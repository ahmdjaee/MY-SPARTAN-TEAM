import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ROLE_SHORT,
  STATUS_LABEL,
  STATUS_STYLE,
  api,
  type DeletedRecapEntry,
  type ProjectRecap as RecapData,
  type RecapEntry,
  type RecapFinding,
  type RecapSeverity,
  type RecapTone,
} from "../api.ts";
import { renderMarkdown } from "../markdown.ts";
import { taskPath } from "../routes.tsx";

/** Tiap peran memakai kosakatanya sendiri (LULUS / SELESAI / BERHASIL), jadi warnanya ikut nada. */
const TONE_STYLE: Record<RecapTone, string> = {
  good: "bg-tag-green text-tag-green-ink",
  warn: "bg-tag-yellow text-tag-yellow-ink",
  bad: "bg-tag-red text-tag-red-ink",
};

const SEVERITY_STYLE: Record<RecapSeverity, string> = {
  blocker: "bg-tag-red text-tag-red-ink",
  major: "bg-tag-orange text-tag-orange-ink",
  minor: "bg-tag-gray text-tag-gray-ink",
  lain: "bg-tag-gray text-tag-gray-ink",
};

const SEVERITY_LABEL: Record<RecapSeverity, string> = {
  blocker: "blocker",
  major: "major",
  minor: "minor",
  lain: "tanpa severity",
};

/** Garis dasar penanda "berubah", per project, per browser. Pola try/catch-nya ikut web/theme.ts. */
const seenKey = (projectId: string): string => `ai-team-recap-seen:${projectId}`;

function readSeen(projectId: string): string | undefined {
  try {
    return localStorage.getItem(seenKey(projectId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeSeen(projectId: string, at: string): void {
  try {
    localStorage.setItem(seenKey(projectId), at);
  } catch {
    // localStorage bisa diblokir; penanda berubah saja yang hilang
  }
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const BOX = "rounded-lg border border-line bg-panel p-3 text-sm text-muted";

/** Baris tertutup memuat teks mentah: tanda tebal dan backtick dibuang supaya tidak terbaca sebagai simbol. */
function preview(text: string): string {
  return text.replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
}

function FindingList({ findings }: { findings: RecapFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="space-y-1">
      {findings.map((finding, index) => (
        <li key={`${finding.id ?? "x"}-${index}`} className="flex items-start gap-2 text-sm text-ink">
          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] ${SEVERITY_STYLE[finding.severity]}`}>
            {SEVERITY_LABEL[finding.severity]}
          </span>
          <span className="min-w-0">
            {finding.id ? <span className="mr-1 font-mono text-[11px] text-faint">{finding.id}</span> : null}
            {finding.title}
            {finding.note ? <span className="ml-1 text-xs text-faint">({finding.note})</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Baris tugas yang sudah dihapus: snapshot verdict, ringkasan, dan temuan saat dihapus.
 * Tidak ada laporan yang bisa dibuka dan tidak ada tautan ke tugasnya.
 */
function DeletedRow({ entry, expanded, onToggle }: { entry: DeletedRecapEntry; expanded: boolean; onToggle: () => void }) {
  return (
    <div data-recap-deleted={entry.taskId} className="rounded-lg border border-dashed border-line bg-panel px-3 py-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        title={expanded ? "Tutup" : "Lihat ringkasan terakhir sebelum dihapus"}
        className="flex w-full min-w-0 items-center gap-2 rounded text-left hover:opacity-80"
      >
        <span aria-hidden className="shrink-0 text-muted">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-faint line-through">{entry.taskId}</span>
        <span className="shrink-0 text-[11px] text-faint">{ROLE_SHORT[entry.role]}</span>
        {entry.verdict && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] opacity-70 ${TONE_STYLE[entry.verdict.tone]}`}>
            {entry.verdict.text}
          </span>
        )}
        <span title={stamp(entry.deletedAt)} className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[11px] text-muted">
          dihapus {shortDate(entry.deletedAt)}
        </span>
        <span className="truncate text-sm text-faint">{preview(entry.summary ?? entry.title)}</span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-3 border-t border-line pt-2">
          <p className="text-xs text-faint">{entry.title}</p>
          <FindingList findings={entry.findings} />
          {entry.summary && <p className="whitespace-pre-wrap break-words text-sm text-muted">{entry.summary}</p>}
          <p className="text-xs text-faint">
            Lampiran tidak tersedia — tugas sudah dihapus {stamp(entry.deletedAt)}. Yang tersisa hanya ringkasan terakhir
            di atas.
          </p>
        </div>
      )}
    </div>
  );
}

/** Laporan yang dibentangkan di-parse sekali per isi, bukan setiap rekap dimuat ulang. */
const ReportMarkdown = memo(function ReportMarkdown({ text, taskId }: { text: string; taskId: string }) {
  const html = useMemo(() => renderMarkdown(text, taskId), [text, taskId]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});

export function ProjectRecap({ projectId, search }: { projectId: string; search: URLSearchParams }) {
  const [recap, setRecap] = useState<RecapData>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** undefined = belum diambil, null = report.md tidak terbaca. */
  const [reports, setReports] = useState<Record<string, string | null>>({});
  const [seenAt, setSeenAt] = useState<string | undefined>(() => readSeen(projectId));

  const currentProject = useRef(projectId);
  currentProject.current = projectId;

  const load = (markSeen: boolean): void => {
    setBusy(true);
    void api
      .projectRecap(projectId)
      .then((data) => {
        // Respons project sebelumnya yang datang terlambat tidak boleh menimpa yang sedang dibuka.
        if (currentProject.current !== projectId) return;
        setRecap(data);
        setError(undefined);
        if (markSeen) {
          // Sync membuang cache laporan yang sudah dibentang — kalau tidak, isinya ikut basi.
          setReports({});
        }
        // Garis dasar ditetapkan sekali saat pertama kali dibuka; sesudah itu hanya Sync yang menggesernya.
        if (markSeen || readSeen(projectId) === undefined) {
          writeSeen(projectId, data.generatedAt);
          setSeenAt(data.generatedAt);
        }
      })
      .catch((cause: Error) => currentProject.current === projectId && setError(cause.message))
      .finally(() => currentProject.current === projectId && setBusy(false));
  };

  useEffect(() => {
    setRecap(undefined);
    setOpen(new Set());
    setReports({});
    setSeenAt(readSeen(projectId));
    load(false);
  }, [projectId]);

  const changedSinceSync = (entry: RecapEntry): boolean => Boolean(seenAt && entry.changedAt > seenAt);

  const toggleOpen = (taskId: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

  const toggle = (entry: RecapEntry): void => {
    toggleOpen(entry.taskId);
    if (entry.source !== "report" || reports[entry.taskId] !== undefined) return;
    void api
      .taskReport(entry.taskId)
      .then((data) => setReports((current) => ({ ...current, [entry.taskId]: data.text })))
      .catch(() => setReports((current) => ({ ...current, [entry.taskId]: null })));
  };

  if (error) return <p className={BOX}>{error}</p>;
  if (!recap) return <p className={BOX}>Membaca laporan…</p>;

  const { totals, entries } = recap;
  const unlabelled = totals.reports - totals.bad - totals.good - totals.warn;
  const changed = entries.filter(changedSinceSync).length;

  return (
    <div className="space-y-2">
      <div
        data-recap-bar
        className="flex flex-wrap items-start gap-3 rounded-lg border border-line bg-panel px-3 py-2"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm text-ink">
            {totals.reports} laporan tugas
            {totals.summaries > 0 ? ` · ${totals.summaries} ringkasan operan` : ""}
            {recap.emptyCount > 0 ? ` · ${recap.emptyCount} tugas belum berlaporan` : ""}
            {recap.deleted.length > 0 ? ` · ${recap.deleted.length} tugas dihapus` : ""}
            {totals.costUsd > 0 ? ` · $${totals.costUsd.toFixed(4)}` : ""}
          </p>
          {totals.reports > 0 && (
            <p className="text-xs text-muted">
              {totals.bad} gagal/terblokir · {totals.warn} dengan catatan · {totals.good} tuntas
              {unlabelled > 0 ? ` · ${unlabelled} tanpa label Hasil` : ""}
            </p>
          )}
          {totals.blocker + totals.major + totals.minor + totals.other > 0 && (
            <p
              className="text-xs text-muted"
              title="Jumlah temuan yang tertulis di laporan. Laporan tidak mencatat temuan mana yang sudah diperbaiki, jadi ini bukan angka 'masih terbuka'."
            >
              Temuan tercatat: {totals.blocker} blocker · {totals.major} major · {totals.minor} minor
              {totals.other > 0 ? ` · ${totals.other} tanpa severity` : ""}
            </p>
          )}
          <p data-recap-stamp={recap.generatedAt} className="text-[11px] text-faint">
            Dibaca {stamp(recap.generatedAt)}
            {changed > 0 ? ` · ${changed} berubah sejak Sync terakhir` : ""}
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={busy}
          title="Baca ulang semua laporan dari disk"
          className="shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink hover:bg-hover disabled:opacity-40"
        >
          {busy ? "Sync…" : "Sync"}
          {changed > 0 ? ` (${changed})` : ""}
        </button>
      </div>

      {entries.length === 0 && recap.deleted.length === 0 && (
        <p className={BOX}>
          Belum ada laporan di project ini. Laporan muncul setelah bot menulis <code>report.md</code> di folder
          tugasnya, atau setelah ia menutup pekerjaannya dengan ringkasan serah terima.
        </p>
      )}

      {entries.map((entry) => {
        const expanded = open.has(entry.taskId);
        const report = reports[entry.taskId];
        return (
          <div
            key={entry.taskId}
            data-recap-row={entry.taskId}
            className="rounded-lg border border-line bg-panel px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => toggle(entry)}
                title={expanded ? "Tutup laporan" : "Baca laporan selengkapnya"}
                className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:opacity-80"
              >
                <span aria-hidden className="shrink-0 text-muted">
                  {expanded ? "▾" : "▸"}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted">{entry.taskId}</span>
                <span className="shrink-0 text-[11px] text-faint">{ROLE_SHORT[entry.role]}</span>
                {entry.verdict ? (
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${TONE_STYLE[entry.verdict.tone]}`}>
                    {entry.verdict.text}
                  </span>
                ) : (
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[entry.status]}`}>
                    {STATUS_LABEL[entry.status]}
                  </span>
                )}
                <span className="shrink-0 text-[11px] text-faint">{shortDate(entry.changedAt)}</span>
                {changedSinceSync(entry) && (
                  <span
                    title="Berubah sejak Sync terakhir"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  />
                )}
                <span className="truncate text-sm text-muted">
                  {entry.source === "summary" ? "(ringkasan operan) " : ""}
                  {preview(entry.summary ?? entry.title)}
                </span>
              </button>
              <Link
                to={taskPath(entry.taskId, entry.source === "report" ? "report" : "work", search)}
                className="shrink-0 rounded border border-line-strong px-2 py-0.5 text-xs text-ink hover:bg-hover"
              >
                Buka tugas
              </Link>
            </div>

            {expanded && (
              <div className="mt-2 space-y-3 border-t border-line pt-2">
                <p className="text-xs text-faint">{entry.title}</p>

                <FindingList findings={entry.findings} />

                {entry.source === "summary" && entry.summary && (
                  <p className="whitespace-pre-wrap break-words text-sm text-ink">{entry.summary}</p>
                )}

                {entry.source === "report" && report === undefined && (
                  <p className="text-sm text-muted">Memuat laporan…</p>
                )}
                {entry.source === "report" && report === null && (
                  <p className="text-sm text-muted">report.md tidak bisa dibaca.</p>
                )}
                {entry.source === "report" && typeof report === "string" && (
                  <ReportMarkdown text={report} taskId={entry.taskId} />
                )}
              </div>
            )}
          </div>
        );
      })}

      {recap.deleted.map((entry) => (
        <DeletedRow
          key={`deleted-${entry.taskId}`}
          entry={entry}
          expanded={open.has(`deleted:${entry.taskId}`)}
          onToggle={() => toggleOpen(`deleted:${entry.taskId}`)}
        />
      ))}
    </div>
  );
}
