import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  api,
  type Finding,
  type FindingSeverity,
  type RecapTone,
  type ReportRound,
  type TaskFinding,
  type TaskReportView,
  type TaskUnlinkedFinding,
} from "../api.ts";
import { renderMarkdown } from "../markdown.ts";
import { subscribe } from "../realtime.ts";
import { SEVERITY_STYLE, STATUS_STYLE } from "./ProjectReport.tsx";

const SEVERITIES: FindingSeverity[] = ["blocker", "major", "minor"];

type Section = "main" | "findings" | "resolved";

const TONE_STYLE: Record<RecapTone, string> = {
  good: "bg-tag-green text-tag-green-ink",
  warn: "bg-tag-yellow text-tag-yellow-ink",
  bad: "bg-tag-red text-tag-red-ink",
};

const BOX = "rounded-lg border border-line bg-panel p-3 text-sm text-muted";
const TAG = "shrink-0 rounded px-1.5 py-0.5 text-[11px]";

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Label Resolved membedakan klaim perbaikan dari perbaikan yang sudah terbukti. */
function resolvedLabel(finding: Finding): string {
  if (finding.status === "needs_retest") return "menunggu uji ulang";
  if (finding.status === "wontfix") return "tidak diperbaiki";
  if (finding.status === "invalid") return "bukan masalah";
  return finding.lastVerifiedAt ? "terverifikasi" : "diperbaiki";
}

function Markdown({ text, taskId }: { text: string; taskId: string }) {
  const html = useMemo(() => renderMarkdown(text, taskId), [text, taskId]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Round({ round, taskId, defaultOpen, label }: { round: ReportRound; taskId: string; defaultOpen: boolean; label: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section data-report-round className="rounded-lg border border-line bg-panel">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover"
      >
        <span aria-hidden className="shrink-0 text-muted">{open ? "▾" : "▸"}</span>
        <span className="shrink-0 text-[11px] text-faint">{label}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{round.title}</span>
        {round.verdict && <span className={`${TAG} ${TONE_STYLE[round.verdict.tone]}`}>{round.verdict.text}</span>}
      </button>
      {open && (
        <div className="border-t border-line px-4 py-3">
          <Markdown text={round.body} taskId={taskId} />
        </div>
      )}
    </section>
  );
}

function FindingCard({ item, taskId, resolved }: { item: TaskFinding; taskId: string; resolved: boolean }) {
  const { finding, blocks } = item;
  const [open, setOpen] = useState(false);
  return (
    <li data-task-finding={finding.id} className="border-b border-line last:border-b-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover">
        <span aria-hidden className="shrink-0 text-muted">{open ? "▾" : "▸"}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">{finding.id}</span>
        <span className={`${TAG} ${SEVERITY_STYLE[finding.severity]}`}>{finding.severity}</span>
        {resolved && (
          <span data-finding-badge className={`${TAG} ${STATUS_STYLE[finding.status]}`}>
            {resolvedLabel(finding)}
          </span>
        )}
        {!resolved && finding.reopenedAt && <span data-finding-regression className={`${TAG} bg-tag-red text-tag-red-ink`}>regresi</span>}
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{finding.title}</span>
        {finding.area && <span className="hidden shrink-0 text-[11px] text-faint sm:inline">{finding.area}</span>}
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3 pl-8 text-sm">
          {finding.summary && <p className="text-ink">{finding.summary}</p>}
          {finding.fix && (
            <p className="text-xs text-muted">
              Dilaporkan diperbaiki oleh <span className="font-mono">{finding.fix.by}</span> ({stamp(finding.fix.at)}): {finding.fix.note}
            </p>
          )}
          {finding.retest && (
            <p className="text-xs text-muted">
              Uji ulang {finding.retest.passed ? "lolos" : "gagal"} di <span className="font-mono">{finding.retest.taskId}</span> ({stamp(finding.retest.at)}):{" "}
              {finding.retest.note} (bukti: {finding.retest.evidence})
            </p>
          )}
          {resolved && finding.status !== "needs_retest" && finding.resolution && !finding.retest?.passed && (
            <p className="text-xs text-muted">
              Ditutup oleh <span className="font-mono">{finding.resolution.by}</span> ({stamp(finding.resolution.at)}): {finding.resolution.note}
            </p>
          )}
          {blocks.map((block, index) => (
            <div key={`${block.heading}-${index}`} className="rounded border border-line p-2">
              <p className="mb-1 text-xs font-medium text-faint">Dari laporan: {block.heading}</p>
              {block.body && <Markdown text={block.body} taskId={taskId} />}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function UnlinkedCard({ item, taskId }: { item: TaskUnlinkedFinding; taskId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li data-task-unlinked className="border-b border-line last:border-b-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover">
        <span aria-hidden className="shrink-0 text-muted">{open ? "▾" : "▸"}</span>
        {item.id && <span className="shrink-0 font-mono text-[11px] text-muted">{item.id}</span>}
        <span className={`${TAG} ${SEVERITY_STYLE[item.severity]}`}>{item.severity}</span>
        <span className={`${TAG} bg-hover text-muted`}>belum masuk register</span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.title}</span>
      </button>
      {open && item.body && (
        <div className="px-3 pb-3 pl-8">
          <Markdown text={item.body} taskId={taskId} />
        </div>
      )}
    </li>
  );
}

function FindingsTab({ view, taskId }: { view: TaskReportView; taskId: string }) {
  const [severity, setSeverity] = useState<FindingSeverity | "">("");
  const shown = SEVERITIES.filter((value) => !severity || value === severity);
  if (view.opened.length + view.unlinked.length === 0) return <p className={BOX}>Tidak ada temuan terbuka di tugas ini.</p>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 text-xs">
        {(["", ...SEVERITIES] as const).map((value) => (
          <button
            key={value || "all"}
            type="button"
            onClick={() => setSeverity(value)}
            className={`rounded px-2 py-0.5 ${severity === value ? "bg-hover text-ink" : "text-muted hover:bg-hover"}`}
          >
            {value || "semua"}
          </button>
        ))}
      </div>
      {shown.map((value) => {
        const items = view.opened.filter(({ finding }) => finding.severity === value);
        const unlinked = view.unlinked.filter((item) => item.severity === value);
        if (items.length + unlinked.length === 0) return null;
        return (
          <section key={value} data-severity-group={value} className="rounded-lg border border-line bg-panel">
            <h3 className="border-b border-line px-3 py-2 text-sm font-semibold capitalize text-ink">
              {value} ({items.length + unlinked.length})
            </h3>
            <ul>
              {items.map((item) => (
                <FindingCard key={item.finding.id} item={item} taskId={taskId} resolved={false} />
              ))}
              {unlinked.map((item, index) => (
                <UnlinkedCard key={`${item.id ?? item.title}-${index}`} item={item} taskId={taskId} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ResolvedTab({ view, taskId }: { view: TaskReportView; taskId: string }) {
  if (view.resolved.length === 0) return <p className={BOX}>Belum ada temuan yang ditangani di tugas ini.</p>;
  return (
    <ul className="rounded-lg border border-line bg-panel">
      {view.resolved.map((item) => (
        <FindingCard key={item.finding.id} item={item} taskId={taskId} resolved />
      ))}
    </ul>
  );
}

/**
 * `revision` naik saat report.md ditulis atau turn selesai (dari thread tugas). Status temuan bisa
 * diubah kurator atau retest dari tugas lain — itu datang lewat topik `project:<id>`.
 */
export const TaskReport = memo(function TaskReport({
  taskId,
  projectId,
  revision,
}: {
  taskId: string;
  projectId: string;
  revision: number;
}) {
  const [view, setView] = useState<TaskReportView>();
  const [error, setError] = useState<string>();
  const [search, setSearch] = useSearchParams();
  const lastJson = useRef("");

  const section: Section = search.get("section") === "findings" ? "findings" : search.get("section") === "resolved" ? "resolved" : "main";
  const choose = (next: Section): void => {
    const params = new URLSearchParams(search);
    if (next === "main") params.delete("section");
    else params.set("section", next);
    setSearch(params, { replace: true });
  };

  // Register temuan project berubah → minta muat ulang (digabung kalau beruntun).
  const [projectTick, setProjectTick] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ready = false;
    const soon = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        setProjectTick((value) => value + 1);
      }, 300);
    };
    const off = subscribe<{ type: string }>(
      `project:${projectId}`,
      (event) => {
        if (event.type === "project_changed") soon();
      },
      // Tersambung ulang: perubahan selama terputus tidak terlewat.
      { onReady: () => (ready ? soon() : (ready = true)) },
    );
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    const load = (): void => {
      void api
        .taskReportView(taskId)
        .then((data) => {
          if (!active) return;
          setError(undefined);
          const json = JSON.stringify(data);
          if (json === lastJson.current) return;
          lastJson.current = json;
          setView(data);
        })
        .catch((cause: Error) => active && setError(cause.message));
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") load();
    };
    load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [taskId, revision, projectTick]);

  if (error && !view) return <div className="px-6 py-5"><p className={BOX}>{error}</p></div>;
  if (!view) return <div className="px-6 py-5"><p className={BOX}>Membaca laporan…</p></div>;

  const openCount = view.opened.length + view.unlinked.length;
  const count = (severity: FindingSeverity): number =>
    view.opened.filter(({ finding }) => finding.severity === severity).length + view.unlinked.filter((item) => item.severity === severity).length;
  const waiting = view.resolved.filter(({ finding }) => finding.status === "needs_retest").length;
  const tabs: Array<[Section, string]> = [
    ["main", "Report utama"],
    ["findings", `Temuan (${openCount})`],
    ["resolved", `Resolved (${view.resolved.length})`],
  ];
  const newestFirst = view.rounds.map((round, index) => ({ round, index })).reverse();

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 text-sm">
          {tabs.map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-report-section={value}
              onClick={() => choose(value)}
              className={`rounded-lg px-3 py-1.5 ${section === value ? "bg-hover text-ink" : "text-muted hover:bg-hover"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <a
          href={api.taskFindingsMarkdownUrl(taskId)}
          download
          data-task-findings-download
          title="Unduh temuan tugas ini sebagai berkas Markdown, dibagi Temuan dan Resolved"
          className="ml-auto shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink hover:bg-hover"
        >
          Download temuan
        </a>
      </div>
      {error && <p className="mb-3 text-xs text-tag-red-ink">Gagal memuat ulang: {error}</p>}

      {section === "main" && (
        <div className="space-y-3">
          <div data-report-now className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm">
            {view.verdict && (
              <span data-report-now-verdict className={`rounded px-2 py-0.5 text-xs font-semibold ${TONE_STYLE[view.verdict.tone]}`}>
                {view.verdict.text}
              </span>
            )}
            <span className="text-ink">
              {count("blocker")} blocker · {count("major")} major · {count("minor")} minor terbuka
            </span>
            <span className="text-xs text-faint">
              · {waiting} menunggu uji ulang · {view.resolved.length - waiting} selesai
            </span>
            <Link to={`/projects/${encodeURIComponent(projectId)}?tab=recap`} className="ml-auto text-xs text-accent hover:underline">
              Report project
            </Link>
          </div>
          {!view.hasReport && <p className={BOX}>Belum ada `report.md` untuk tugas ini.</p>}
          {newestFirst.map(({ round, index }, position) => (
            <Round
              key={index}
              round={round}
              taskId={taskId}
              defaultOpen={position === 0}
              label={position === 0 ? "Terbaru" : `Putaran ${index + 1}`}
            />
          ))}
          {view.assets.length > 0 && (
            <div className="pt-3">
              <h3 className="text-xs uppercase tracking-wide text-muted">Bukti ({view.assets.length})</h3>
              <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-3">
                {view.assets.map((asset) => {
                  const url = `/api/tasks/${encodeURIComponent(taskId)}/assets/${encodeURIComponent(asset)}`;
                  return (
                    <a key={asset} href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-line">
                      <img src={url} alt={asset} loading="lazy" className="h-32 w-full object-cover object-top" />
                      <p className="truncate px-2 py-1 font-mono text-[11px] text-muted">{asset}</p>
                    </a>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {section === "findings" && <FindingsTab view={view} taskId={taskId} />}
      {section === "resolved" && <ResolvedTab view={view} taskId={taskId} />}
    </div>
  );
});
