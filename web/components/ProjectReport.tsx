import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type CoverageCell,
  type CoverageState,
  type Finding,
  type FindingSeverity,
  type FindingStatus,
  type ProjectReport as ReportData,
} from "../api.ts";
import { renderMarkdown } from "../markdown.ts";
import { taskPath } from "../routes.tsx";
import { ProjectRecap } from "./ProjectRecap.tsx";

const SEVERITY_STYLE: Record<FindingSeverity, string> = {
  blocker: "bg-tag-red text-tag-red-ink",
  major: "bg-tag-orange text-tag-orange-ink",
  minor: "bg-tag-gray text-tag-gray-ink",
};

const STATUS_STYLE: Record<FindingStatus, string> = {
  open: "bg-tag-red text-tag-red-ink",
  needs_retest: "bg-tag-yellow text-tag-yellow-ink",
  fixed: "bg-tag-green text-tag-green-ink",
  wontfix: "bg-tag-gray text-tag-gray-ink",
  invalid: "bg-hover text-muted",
};

const STATUS_LABEL: Record<FindingStatus, string> = {
  open: "terbuka",
  needs_retest: "perlu uji ulang",
  fixed: "diperbaiki",
  wontfix: "tidak diperbaiki",
  invalid: "bukan masalah",
};

const COVERAGE_STYLE: Record<CoverageState, string> = {
  tested: "bg-tag-green text-tag-green-ink",
  partial: "bg-tag-yellow text-tag-yellow-ink",
  blocked: "bg-tag-red text-tag-red-ink",
  untested: "bg-tag-gray text-tag-gray-ink",
};

const COVERAGE_LABEL: Record<CoverageState, string> = {
  tested: "teruji",
  partial: "sebagian",
  blocked: "terblokir",
  untested: "belum",
};

const OPEN: FindingStatus[] = ["open", "needs_retest"];
const SEVERITY_RANK: FindingSeverity[] = ["blocker", "major", "minor"];
const STATUSES: FindingStatus[] = ["open", "needs_retest", "fixed", "wontfix", "invalid"];

const BOX = "rounded-lg border border-line bg-panel p-3 text-sm text-muted";
const SECTION = "rounded-lg border border-line bg-panel";
const H = "flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-semibold text-ink";

function stamp(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Kesimpulan diambil dari baris "**Kesimpulan:**" yang ditulis kurator. */
function verdictOf(state: string): string | undefined {
  const match = /\*\*Kesimpulan:?\*\*:?\s*(SIAP DENGAN CATATAN|BELUM SIAP|SIAP)/i.exec(state);
  return match?.[1]?.toUpperCase();
}

const VERDICT_STYLE: Record<string, string> = {
  SIAP: "bg-tag-green text-tag-green-ink",
  "SIAP DENGAN CATATAN": "bg-tag-yellow text-tag-yellow-ink",
  "BELUM SIAP": "bg-tag-red text-tag-red-ink",
};

type Filter = "open" | "closed" | "all";

export function ProjectReport({ projectId, search }: { projectId: string; search: URLSearchParams }) {
  const [report, setReport] = useState<ReportData>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<Filter>("open");
  const [area, setArea] = useState<string>("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showLog, setShowLog] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showUnlinked, setShowUnlinked] = useState(false);

  // Polling 4 detik saat kurator jalan: payload yang sama tidak boleh merender ulang register.
  const lastJson = useRef("");
  const currentProject = useRef(projectId);
  currentProject.current = projectId;

  const load = (): Promise<void> =>
    api
      .projectReport(projectId)
      .then((data) => {
        if (currentProject.current !== projectId) return;
        const json = JSON.stringify({ ...data, generatedAt: "" });
        if (json !== lastJson.current) {
          lastJson.current = json;
          setReport(data);
        }
        setError(undefined);
      })
      .catch((cause: Error) => {
        if (currentProject.current === projectId) setError(cause.message);
      });

  useEffect(() => {
    setReport(undefined);
    setOpen(new Set());
    lastJson.current = "";
    void load();
  }, [projectId]);

  // Selama kurator jalan atau terjadwal, baca ulang berkala supaya hasilnya muncul sendiri.
  const busy = Boolean(report?.curator.running || report?.curator.scheduledAt);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 4_000);
    return () => clearInterval(timer);
  }, [busy, projectId]);

  const findings = report?.findings;
  const areas = useMemo(
    () => [...new Set((findings ?? []).map((finding) => finding.area).filter(Boolean) as string[])].sort(),
    [findings],
  );
  /** Temuan yang masih berdiri sendiri (duplikat yang sudah digabung disembunyikan). */
  const active = useMemo(() => (findings ?? []).filter((finding) => !finding.mergedInto), [findings]);
  const visible = useMemo(
    () =>
      active
        .filter((finding) =>
          filter === "all" ? true : filter === "open" ? OPEN.includes(finding.status) : !OPEN.includes(finding.status),
        )
        .filter((finding) => !area || finding.area === area)
        .sort(
          (a, b) =>
            Number(!OPEN.includes(a.status)) - Number(!OPEN.includes(b.status)) ||
            SEVERITY_RANK.indexOf(a.severity) - SEVERITY_RANK.indexOf(b.severity) ||
            a.id.localeCompare(b.id),
        ),
    [active, filter, area],
  );
  const stateHtml = useMemo(() => (report?.state.trim() ? renderMarkdown(report.state) : ""), [report?.state]);

  if (error) return <p className={BOX}>{error}</p>;
  if (!report) return <p className={BOX}>Membaca report project…</p>;

  const { curator, counts } = report;
  const verdict = verdictOf(report.state);
  const sync = (): void => {
    void api
      .curate(projectId)
      .then(() => load())
      .catch((cause: Error) => setError(cause.message));
  };
  const toggle = (id: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      {/* ---------- kesimpulan ---------- */}
      <section data-report-summary className={SECTION}>
        <div className="flex flex-wrap items-start gap-3 px-3 py-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-report-verdict={verdict ?? ""}
                className={`rounded px-2 py-0.5 text-xs font-semibold ${verdict ? VERDICT_STYLE[verdict] : "bg-hover text-muted"}`}
              >
                {verdict ?? "belum ada kesimpulan"}
              </span>
              <span className="text-sm text-ink">
                {counts.blocker ?? 0} blocker · {counts.major ?? 0} major · {counts.minor ?? 0} minor terbuka
              </span>
              <span className="text-xs text-faint">
                · {counts.needs_retest ?? 0} perlu uji ulang · {counts.fixed ?? 0} diperbaiki · {active.length} total
              </span>
            </div>
            <p className="text-[11px] text-faint">
              {curator.running
                ? "Kurator sedang merapikan report…"
                : curator.scheduledAt
                  ? `Kurasi otomatis dijadwalkan ${stamp(curator.scheduledAt)}`
                  : `Dikurasi ${stamp(curator.lastRunAt)}`}
              {curator.pending > 0 ? ` · ${curator.pending} laporan belum dikurasi` : ""}
              {curator.inbox > 0 ? ` · ${curator.inbox} catatan memori menunggu` : ""}
              {curator.costUsd > 0 ? ` · biaya kurator $${curator.costUsd.toFixed(4)}` : ""}
            </p>
            {curator.inProgress.length > 0 && (
              <p data-report-in-progress className="text-xs text-muted">
                {curator.inProgress.join(", ")} masih dikerjakan — laporannya masuk register setelah selesai.
              </p>
            )}
            {curator.lastError && <p className="text-xs text-tag-red-ink">Kurasi terakhir gagal: {curator.lastError}</p>}
          </div>
          <a
            href={api.projectFindingsMarkdownUrl(projectId)}
            download
            data-findings-download
            title="Unduh ringkasan dan semua temuan sebagai berkas Markdown (tanpa saringan)"
            className="shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink hover:bg-hover"
          >
            Download temuan
          </a>
          <a
            href={api.projectReportMarkdownUrl(projectId)}
            download
            data-report-download
            title="Unduh report lengkap sebagai berkas Markdown: kesimpulan, semua temuan, cakupan uji, dan lampiran"
            className="shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink hover:bg-hover"
          >
            Download report lengkap
          </a>
          <button
            onClick={sync}
            disabled={curator.running}
            title="Jalankan kurator sekarang: tautkan laporan baru ke register, perbarui status, rapikan memori"
            className="shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:opacity-40"
          >
            {curator.running ? "Mengurasi…" : "Sync"}
            {!curator.running && curator.pending > 0 ? ` (${curator.pending})` : ""}
          </button>
        </div>
        {report.state.trim() ? (
          <div className="markdown border-t border-line px-3 py-2" dangerouslySetInnerHTML={{ __html: stateHtml }} />
        ) : (
          <p className="border-t border-line px-3 py-2 text-sm text-muted">
            Kesimpulan ditulis kurator setelah laporan pertama dikurasi. Tekan Sync untuk memulai.
          </p>
        )}
      </section>

      {/* ---------- register ---------- */}
      <section className={SECTION}>
        <div className={H}>
          <span>Register temuan</span>
          <span className="ml-auto flex items-center gap-1 text-xs font-normal">
            {(["open", "closed", "all"] as Filter[]).map((value) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`rounded px-2 py-0.5 ${filter === value ? "bg-hover text-ink" : "text-muted hover:bg-hover"}`}
              >
                {value === "open" ? "terbuka" : value === "closed" ? "ditutup" : "semua"}
              </button>
            ))}
            {areas.length > 0 && (
              <select
                value={area}
                onChange={(e) => setArea(e.target.value)}
                className="ml-1 rounded border border-line bg-page px-1 py-0.5 text-xs text-ink"
              >
                <option value="">semua area</option>
                {areas.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </span>
        </div>
        {visible.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted">
            {active.length === 0 ? "Register masih kosong — terisi setelah kurator membaca laporan." : "Tidak ada temuan di saringan ini."}
          </p>
        ) : (
          <ul>
            {visible.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                expanded={open.has(finding.id)}
                onToggle={() => toggle(finding.id)}
                projectId={projectId}
                others={active}
                search={search}
                onChanged={() => void load()}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ---------- temuan laporan yang tidak tertaut ---------- */}
      {report.unlinked.length > 0 && (
        <section data-report-unlinked className={SECTION}>
          <button type="button" onClick={() => setShowUnlinked((value) => !value)} className={`${H} w-full text-left`} aria-expanded={showUnlinked}>
            <span aria-hidden className="text-muted">{showUnlinked ? "▾" : "▸"}</span>
            <span>Temuan laporan yang tidak masuk register ({report.unlinked.length})</span>
          </button>
          {showUnlinked && (
            <ul className="divide-y divide-line">
              {report.unlinked.map((item) => (
                <li key={`${item.taskId}-${item.id}`} data-unlinked-row className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
                  <Link to={taskPath(item.taskId, "report", search)} className="shrink-0 font-mono text-accent hover:underline">
                    {item.taskId}
                  </Link>
                  <span className="shrink-0 font-mono text-faint">{item.id}</span>
                  <span className="shrink-0 rounded bg-hover px-1 text-muted">{item.severity}</span>
                  <span className="min-w-0 flex-1 text-ink">{item.title}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ---------- cakupan ---------- */}
      <CoverageMatrix cells={report.coverage} search={search} />

      {/* ---------- log kurasi ---------- */}
      <section className={SECTION}>
        <button type="button" onClick={() => setShowLog((value) => !value)} className={`${H} w-full text-left`} aria-expanded={showLog}>
          <span aria-hidden className="text-muted">{showLog ? "▾" : "▸"}</span>
          <span>Log kurasi</span>
          <span className="text-xs font-normal text-faint">{report.log.length} perubahan terakhir</span>
        </button>
        {showLog && (
          <ul className="divide-y divide-line">
            {report.log.map((entry, index) => (
              <li key={`${entry.at}-${index}`} data-log-row className="flex items-start gap-2 px-3 py-1.5 text-xs">
                <span className="shrink-0 text-faint">{stamp(entry.at)}</span>
                <span className="shrink-0 rounded bg-hover px-1 text-muted">{entry.by}</span>
                <span className="min-w-0 flex-1 text-ink">
                  {entry.target ? <span className="mr-1 font-mono">{entry.target}</span> : null}
                  {entry.detail}
                </span>
                {entry.revertible && (
                  <button
                    onClick={() => {
                      if (!confirm(`Batalkan perubahan ini?\n${entry.target ?? ""} ${entry.detail}`)) return;
                      void api.revertCuration(projectId, { at: entry.at, action: entry.action, target: entry.target }).then(() => load()).catch((cause: Error) => alert(cause.message));
                    }}
                    className="shrink-0 rounded border border-line-strong px-1.5 text-muted hover:bg-hover"
                  >
                    batalkan
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------- lampiran: laporan per tugas ---------- */}
      <section className={SECTION}>
        <button type="button" onClick={() => setShowTasks((value) => !value)} className={`${H} w-full text-left`} aria-expanded={showTasks}>
          <span aria-hidden className="text-muted">{showTasks ? "▾" : "▸"}</span>
          <span>Lampiran: laporan per tugas</span>
          <span className="text-xs font-normal text-faint">{report.recap.entries.length} tugas</span>
        </button>
        {showTasks && (
          <div data-recap-root className="p-3">
            <ProjectRecap projectId={projectId} search={search} />
          </div>
        )}
      </section>
    </div>
  );
}

const FindingRow = memo(function FindingRow({
  finding,
  expanded,
  onToggle,
  projectId,
  others,
  search,
  onChanged,
}: {
  finding: Finding;
  expanded: boolean;
  onToggle: () => void;
  projectId: string;
  others: Finding[];
  search: URLSearchParams;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<FindingStatus>(finding.status);
  const [note, setNote] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const [error, setError] = useState<string>();
  const tasks = useMemo(() => [...new Set(finding.occurrences.map((item) => item.taskId))], [finding.occurrences]);
  // Kurator bisa mengubah status saat baris terbuka; pilihan di select harus ikut, bukan membalikkannya.
  useEffect(() => setStatus(finding.status), [finding.status]);
  const mergeTargets = useMemo(() => others.filter((item) => item.id !== finding.id), [others, finding.id]);

  const save = (): void => {
    setError(undefined);
    const body = mergeInto ? { mergeInto } : { status, note: note.trim() || undefined };
    void api
      .patchFinding(projectId, finding.id, body)
      .then(() => {
        setNote("");
        setMergeInto("");
        onChanged();
      })
      .catch((cause: Error) => setError(cause.message));
  };

  return (
    <li data-finding-row={finding.id} className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover"
      >
        <span aria-hidden className="shrink-0 text-muted">{expanded ? "▾" : "▸"}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">{finding.id}</span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${SEVERITY_STYLE[finding.severity]}`}>{finding.severity}</span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[finding.status]}`}>{STATUS_LABEL[finding.status]}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{finding.title}</span>
        {finding.area && <span className="hidden shrink-0 text-[11px] text-faint sm:inline">{finding.area}</span>}
        <span className="shrink-0 text-[11px] text-faint" title="jumlah tugas yang melaporkan">
          {tasks.length}×
        </span>
      </button>

      {expanded && (
        <div className="space-y-2 px-3 pb-3 pl-8 text-sm">
          {finding.summary && <p className="text-ink">{finding.summary}</p>}
          {finding.resolution && !OPEN.includes(finding.status) && (
            <p className="text-xs text-muted">
              Ditutup oleh <span className="font-mono">{finding.resolution.by}</span> ({stamp(finding.resolution.at)}):{" "}
              {finding.resolution.note}
            </p>
          )}
          {finding.lastVerifiedAt && <p className="text-xs text-muted">Terverifikasi uji ulang {stamp(finding.lastVerifiedAt)}</p>}

          <div>
            <p className="text-xs text-faint">Dilaporkan di:</p>
            <ul className="mt-1 space-y-0.5">
              {finding.occurrences.map((item) => (
                <li key={`${item.taskId}-${item.localId ?? ""}`} className="flex items-baseline gap-2 text-xs">
                  <Link to={taskPath(item.taskId, "report", search)} className="font-mono text-accent hover:underline">
                    {item.taskId}
                  </Link>
                  {item.localId && <span className="font-mono text-faint">{item.localId}</span>}
                  <span className="text-faint">{stamp(item.at)}</span>
                  {item.note && <span className="text-muted">{item.note}</span>}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2 text-xs">
            <span className="text-faint">Koreksi:</span>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as FindingStatus);
                setMergeInto("");
              }}
              className="rounded border border-line bg-page px-1 py-0.5 text-ink"
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABEL[value]}
                </option>
              ))}
            </select>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="bukti / alasan (wajib untuk menutup)"
              className="min-w-48 flex-1 rounded border border-line bg-page px-1.5 py-0.5 text-ink"
            />
            <select
              value={mergeInto}
              onChange={(e) => setMergeInto(e.target.value)}
              title="Gabungkan sebagai duplikat dari temuan lain"
              className="rounded border border-line bg-page px-1 py-0.5 text-ink"
            >
              <option value="">— gabung ke…</option>
              {mergeTargets.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.id} · {other.title.slice(0, 40)}
                </option>
              ))}
            </select>
            <button
              onClick={save}
              disabled={!mergeInto && status === finding.status}
              className="rounded border border-line-strong px-2 py-0.5 text-ink hover:bg-hover disabled:opacity-40"
            >
              Simpan
            </button>
            {error && <span className="text-tag-red-ink">{error}</span>}
          </div>
        </div>
      )}
    </li>
  );
});

function CoverageMatrix({ cells, search }: { cells: CoverageCell[]; search: URLSearchParams }) {
  const areas = [...new Set(cells.map((cell) => cell.area))].sort();
  const subjects = [...new Set(cells.map((cell) => cell.subject))].sort();
  const byKey = new Map(cells.map((cell) => [`${cell.area}\u0000${cell.subject}`, cell]));
  const at = (area: string, subject: string): CoverageCell | undefined => byKey.get(`${area}\u0000${subject}`);

  return (
    <section data-report-coverage className={SECTION}>
      <div className={H}>
        <span>Cakupan uji</span>
        <span className="text-xs font-normal text-faint">
          {areas.length} area × {subjects.length} persona/lingkungan
        </span>
      </div>
      {cells.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted">Belum ada data cakupan — diisi kurator dari tabel `## Cakupan uji` di laporan QA.</p>
      ) : (
        <div className="overflow-x-auto p-3">
          <table className="text-xs">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left font-normal text-faint">area</th>
                {subjects.map((subject) => (
                  <th key={subject} className="whitespace-nowrap px-2 py-1 text-left font-normal text-faint">
                    {subject}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {areas.map((area) => (
                <tr key={area} className="border-t border-line">
                  <td className="whitespace-nowrap px-2 py-1 text-ink">{area}</td>
                  {subjects.map((subject) => {
                    const cell = at(area, subject);
                    return (
                      <td key={subject} className="px-2 py-1">
                        {cell ? (
                          cell.taskId ? (
                            <Link
                              to={taskPath(cell.taskId, "report", search)}
                              title={`${cell.taskId}${cell.note ? ` — ${cell.note}` : ""}`}
                              className={`inline-block rounded px-1.5 py-0.5 ${COVERAGE_STYLE[cell.state]}`}
                            >
                              {COVERAGE_LABEL[cell.state]}
                            </Link>
                          ) : (
                            <span title={cell.note} className={`inline-block rounded px-1.5 py-0.5 ${COVERAGE_STYLE[cell.state]}`}>
                              {COVERAGE_LABEL[cell.state]}
                            </span>
                          )
                        ) : (
                          <span className="text-faint">·</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
