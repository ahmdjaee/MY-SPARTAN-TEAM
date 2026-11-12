import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MODE_LABEL,
  MODE_NOTE,
  ROLE_SHORT,
  STATUS_LABEL,
  STATUS_STYLE,
  api,
  type RoleId,
  type AutonomyMode,
  type ContextUsage,
  type RoleInfo,
  type TaskDetail as TaskDetailData,
} from "../api.ts";
import { Link, useSearchParams } from "react-router-dom";
import { formatTokens } from "../activity.ts";
import { projectPath, type Tab } from "../routes.tsx";
import { useTaskThread } from "../useTaskThread.ts";
import { AskPanel } from "./AskPanel.tsx";
import { Attachments } from "./Attachments.tsx";
import { Diff } from "./Diff.tsx";
import { LiveView, lastBrowserAction } from "./LiveView.tsx";
import { TaskNotes } from "./TaskNotes.tsx";
import { TaskReport } from "./TaskReport.tsx";
import { TaskSettings } from "./TaskSettings.tsx";
import { TaskThread } from "./TaskThread.tsx";

const ASK_KEY = "ai-team-ask";

function HandoffDialog({
  detail,
  roles,
  preset,
  onClose,
  onDone,
}: {
  detail: TaskDetailData;
  roles: RoleInfo[];
  preset?: { role: RoleId; note: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [role, setRole] = useState<RoleId>(
    preset?.role ?? (roles.find((item) => item.id !== detail.task.role)?.id ?? "engineer"),
  );
  const [note, setNote] = useState(preset?.note ?? "");
  const [sending, setSending] = useState(false);

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-scrim p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-line bg-raised p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-ink">Oper tugas {detail.task.id} ke bot lain</h3>
        <p className="mt-1 text-xs text-muted">
          Bot baru menerima instruksi asli, ringkasan serah terima dari {ROLE_SHORT[detail.task.role]}, dan catatan Anda.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {roles.map((item) => (
            <button
              key={item.id}
              onClick={() => setRole(item.id)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                role === item.id ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink"
              }`}
            >
              {item.title}
            </button>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Catatan operan: apa yang harus dikerjakan bot berikutnya"
          className="mt-3 w-full rounded-lg border border-line bg-page p-2 text-sm text-ink outline-none focus:border-accent"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
            Batal
          </button>
          <button
            disabled={sending}
            onClick={async () => {
              setSending(true);
              try {
                await api.handoff(detail.task.id, { role, note: note.trim() || undefined });
                onDone();
                onClose();
              } catch (error) {
                alert((error as Error).message);
                setSending(false);
              }
            }}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            Oper sekarang
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewDialog({ detail, onClose, onDone }: { detail: TaskDetailData; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<"approved" | "changes_requested">("approved");
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-scrim p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-line bg-raised p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-ink">Review tugas {detail.task.id}</h3>
        <div className="mt-3 flex gap-2">
          {(
            [
              ["approved", "Setuju — tutup tugas"],
              ["changes_requested", "Perlu perbaikan"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setStatus(value)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                status === value ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          placeholder={status === "approved" ? "Catatan (opsional)" : "Apa yang perlu diperbaiki? (wajib)"}
          className="mt-3 w-full rounded-lg border border-line bg-page p-2 text-sm text-ink outline-none focus:border-accent"
        />
        {status === "changes_requested" && (
          <p className="mt-2 text-xs text-muted">
            Komentar dikirim sebagai arahan lanjutan ke {ROLE_SHORT[detail.task.role]} dan tugas kembali dikerjakan.
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
            Batal
          </button>
          <button
            disabled={sending || (status === "changes_requested" && !comment.trim())}
            onClick={async () => {
              setSending(true);
              try {
                await api.review(detail.task.id, { status, comment: comment.trim(), sendBackToAgent: true });
                onDone();
                onClose();
              } catch (error) {
                alert((error as Error).message);
                setSending(false);
              }
            }}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
          >
            Simpan review
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mulai dari sini bot sudah dekat dengan batas tempat konteksnya diringkas otomatis. */
const CONTEXT_WARN_PERCENT = 80;

function ContextMeter({ usage }: { usage?: ContextUsage }) {
  if (!usage) return null;
  return (
    <span
      data-context-meter
      title="Pemakaian konteks sesi bot. Di batas ini bot meringkas konteksnya otomatis (auto-compact) dan bisa kehilangan detail lama."
      className={`shrink-0 text-xs ${usage.percentage >= CONTEXT_WARN_PERCENT ? "rounded bg-tag-yellow px-1.5 py-0.5 text-tag-yellow-ink" : "text-faint"}`}
    >
      Konteks {usage.percentage}% · {formatTokens(usage.usedTokens)}/{formatTokens(usage.maxTokens)}
    </span>
  );
}

export function TaskDetail({
  taskId,
  tab,
  tabInUrl,
  onTab,
  roles,
  refreshKey,
  onChanged,
}: {
  taskId: string;
  tab: Tab;
  /** Alamat menyebut tab secara eksplisit — auto-buka Live tidak boleh membajaknya. */
  tabInUrl: boolean;
  onTab: (tab: Tab, replace?: boolean) => void;
  roles: RoleInfo[];
  refreshKey: number;
  onChanged: () => void;
}) {
  const [handoff, setHandoff] = useState<{ role: RoleId; note: string } | true | undefined>();
  const [review, setReview] = useState(false);
  // Usul agen dibiarkan tertutup: catatannya sering panjang dan header tidak ikut ter-scroll.
  const [suggestOpen, setSuggestOpen] = useState(false);
  // undefined = judul sedang tidak disunting.
  const [titleDraft, setTitleDraft] = useState<string | undefined>(undefined);
  const autoOpened = useRef<string | undefined>(undefined);
  const [search] = useSearchParams();
  const [asking, setAsking] = useState(() => {
    try {
      return localStorage.getItem(ASK_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Ctrl+K (Cmd+K) membuka/menutup panel Tanya dari tab mana pun; Esc menutupnya.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setAsking((value) => !value);
        return;
      }
      if (event.key === "Escape") setAsking(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ASK_KEY, asking ? "1" : "0");
    } catch {
      // localStorage bisa diblokir; abaikan
    }
  }, [asking]);
  const {
    detail,
    events,
    status,
    streaming,
    context: liveContext,
    live,
    reportRevision,
    error,
    deleted,
    disconnected,
    hasMore,
    loadingOlder,
    loadOlder,
  } = useTaskThread(taskId, refreshKey);
  // Tab Live hanya butuh satu string; dihitung hanya saat tab itu terbuka.
  const lastAction = useMemo(() => (tab === "live" ? lastBrowserAction(events) : undefined), [tab, events]);
  const closeAsk = useCallback(() => setAsking(false), []);
  // Pindah tugas tidak boleh meninggalkan nama tugas sebelumnya di kotak sunting.
  useEffect(() => setTitleDraft(undefined), [taskId]);

  // Usul yang baru ditulis agen tidak boleh muncul dalam keadaan terbentang.
  useEffect(() => setSuggestOpen(false), [taskId, detail?.task.suggestedNext?.at]);

  // Tugas yang browsernya sedang hidup langsung membuka tab Live — sekali saja, dan
  // hanya kalau alamatnya belum menyebut tab (tautan dalam tidak boleh dibajak).
  useEffect(() => {
    if (!detail || !live.active || tabInUrl || autoOpened.current === taskId) return;
    autoOpened.current = taskId;
    onTab("live", true);
  }, [detail, live.active, taskId, tabInUrl, onTab]);

  // Dihapus selagi terbuka (di tab ini atau tab lain), atau alamat lama dari tugas yang sudah dihapus.
  if (deleted) {
    return (
      <div className="p-6">
        <p data-task-deleted className="rounded-lg border border-line bg-panel p-3 text-sm text-muted">
          Tugas <span className="font-mono text-ink">{taskId}</span> sudah dihapus beserta lampirannya. Rujukannya di
          Report project tetap ada dengan label dihapus.
        </p>
        <Link to="/" className="mt-3 inline-block text-sm text-accent underline underline-offset-2">
          Kembali ke daftar tugas
        </Link>
      </div>
    );
  }

  if (!detail) {
    // Tautan dalam membuat id yang sudah tidak ada jadi mudah dibuka (mis. bookmark lama).
    if (error) {
      return (
        <div className="p-6">
          <p className="rounded-lg border border-line bg-panel p-3 text-sm text-muted">
            Tugas <span className="font-mono text-ink">{taskId}</span> tidak ditemukan — {error}
          </p>
          <Link to="/" className="mt-3 inline-block text-sm text-accent underline underline-offset-2">
            Kembali ke daftar tugas
          </Link>
        </div>
      );
    }
    return <p className="p-6 text-sm text-faint">Memuat tugas…</p>;
  }
  const { task } = detail;
  const busy = status === "working" || status === "starting" || status === "waiting";
  const closed = task.status === "done" || task.status === "cancelled";

  // Tugas yang dioper berkali-kali (T-015 sudah 10 penugasan) tidak boleh mendorong tombol keluar layar.
  const chain = task.assignments.map((assignment) => ROLE_SHORT[assignment.role]);
  const chainLabel =
    chain.length > 5 ? `${chain[0]} → … → ${chain[chain.length - 1]} (${chain.length})` : chain.join(" → ");

  const saveTitle = () => {
    const next = titleDraft?.trim() ?? "";
    setTitleDraft(undefined);
    if (!next || next === task.title) return;
    void api
      .renameTask(task.id, next)
      .then(onChanged)
      .catch((error: Error) => alert(error.message));
  };

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <span className="shrink-0 font-mono text-xs text-muted">{task.id}</span>
          <span
            className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[task.status]}`}
          >
            {STATUS_LABEL[task.status]}
          </span>
          {detail.project && (
            <Link
              to={projectPath(detail.project.id, search)}
              title={`Project ${detail.project.name} · workspace ${detail.project.workspaceDir}`}
              className="shrink-0 max-w-[12rem] truncate rounded bg-hover px-1.5 py-0.5 text-[11px] text-muted hover:text-ink"
            >
              {detail.project.name}
            </Link>
          )}
          <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted" title={chain.join(" → ")}>
            {chainLabel}
          </span>
          {task.costUsd > 0 && <span className="shrink-0 text-xs text-faint">${task.costUsd.toFixed(4)}</span>}
          <ContextMeter usage={liveContext ?? task.assignments.at(-1)?.context} />
          <div className="ml-auto flex shrink-0 items-center gap-2 text-xs">
            <select
              value={detail.mode}
              onChange={(e) => void api.setMode(task.id, e.target.value as AutonomyMode).then(onChanged)}
              title={MODE_NOTE[detail.mode]}
              className="rounded-lg border border-line bg-page px-2 py-1 text-muted"
            >
              {(["auto", "ask", "readonly"] as AutonomyMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  Mode: {MODE_LABEL[mode]}
                </option>
              ))}
            </select>
            {busy && (
              <button
                onClick={() => void api.interrupt(task.id).then(onChanged)}
                className="rounded-lg border border-tag-red-ink px-2 py-1 text-tag-red-ink hover:bg-tag-red"
              >
                Stop
              </button>
            )}
            <button
              onClick={() => setAsking((value) => !value)}
              title="Tanya soal tugas ini tanpa mengganggu percakapan utama (Ctrl+K)"
              className={`rounded-lg border px-2 py-1 ${
                asking ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong text-ink hover:bg-hover"
              }`}
            >
              Tanya
            </button>
            <button
              onClick={() => setHandoff(true)}
              className="rounded-lg border border-line-strong px-2 py-1 text-ink hover:bg-hover"
            >
              Oper ke…
            </button>
            <button
              onClick={() => setReview(true)}
              className="rounded-lg border border-line-strong px-2 py-1 text-ink hover:bg-hover"
            >
              Review
            </button>
            {!closed && (
              <button
                onClick={() => confirm("Batalkan tugas ini?") && void api.cancel(task.id).then(onChanged)}
                className="rounded-lg px-2 py-1 text-muted hover:text-tag-red-ink"
              >
                Batalkan
              </button>
            )}
          </div>
        </div>
        {titleDraft === undefined ? (
          <h2
            onClick={() => setTitleDraft(task.title)}
            title="Klik untuk mengganti nama"
            className="-mx-1 mt-1 cursor-text truncate rounded px-1 text-sm font-semibold text-ink hover:bg-hover"
          >
            {task.title}
          </h2>
        ) : (
          <input
            autoFocus
            value={titleDraft}
            maxLength={140}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveTitle();
              if (e.key === "Escape") setTitleDraft(undefined);
            }}
            className="-mx-1 mt-1 w-full rounded border border-accent bg-page px-1 text-sm font-semibold text-ink outline-none"
          />
        )}

        {task.suggestedNext && (
          <div className="mt-2 rounded-lg border border-line bg-tag-orange px-3 py-1.5 text-xs text-tag-orange-ink">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-expanded={suggestOpen}
                onClick={() => setSuggestOpen((value) => !value)}
                title={suggestOpen ? "Tutup usul agen" : "Baca usul agen selengkapnya"}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left hover:opacity-80"
              >
                <span aria-hidden className="shrink-0">
                  {suggestOpen ? "▾" : "▸"}
                </span>
                <span className="truncate">
                  Usul agen: lanjutkan ke <strong>{ROLE_SHORT[task.suggestedNext.role]}</strong>
                  {suggestOpen ? null : ` — ${task.suggestedNext.note}`}
                </span>
              </button>
              <button
                onClick={() => setHandoff({ role: task.suggestedNext!.role, note: task.suggestedNext!.note })}
                className="shrink-0 rounded border border-line-strong px-2 py-0.5 hover:bg-hover"
              >
                Oper sekarang
              </button>
            </div>
            {/* Dibatasi tingginya: catatan agen bisa ribuan karakter dan header tidak ikut ter-scroll. */}
            {suggestOpen && (
              <p className="mt-1.5 max-h-56 overflow-y-auto break-words whitespace-pre-wrap">
                {task.suggestedNext.note}
              </p>
            )}
          </div>
        )}

        {task.review && (
          <div
            className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
              task.review.status === "approved"
                ? "border-line bg-tag-green text-tag-green-ink"
                : "border-line bg-tag-yellow text-tag-yellow-ink"
            }`}
          >
            {task.review.status === "approved" ? "Disetujui" : "Perlu perbaikan"}
            {task.review.comment ? ` — ${task.review.comment}` : ""}
          </div>
        )}

        <nav className="mt-3 flex flex-wrap gap-1 text-xs">
          {(
            [
              ["work", "Kerja"],
              ["live", "Live"],
              ["report", `Laporan${detail.assets.length ? ` (${detail.assets.length})` : ""}`],
              ["docs", `Lampiran${detail.docs.length ? ` (${detail.docs.length})` : ""}`],
              ["notes", "Catatan"],
              ["diff", "Perubahan"],
              ["settings", "Setelan"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => onTab(value)}
              // Setelan di ujung kanan, terpisah dari tab kerja — seperti Settings di GitHub.
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 ${value === "settings" ? "ml-auto" : ""} ${
                tab === value ? "bg-hover text-ink" : "text-muted hover:bg-hover"
              }`}
            >
              {value === "live" && live.active && (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-tag-red-ink" />
              )}
              {value === "notes" && detail.hasNotes && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1">
        {tab === "work" && (
          <TaskThread
            taskId={task.id}
            events={events}
            status={status}
            taskStatus={task.status}
            streaming={streaming}
            error={error}
            canSend={task.status !== "cancelled"}
            disconnected={disconnected}
            hasMore={hasMore}
            loadingOlder={loadingOlder}
            onLoadOlder={loadOlder}
          />
        )}

        {tab === "live" && <LiveView taskId={task.id} live={live} lastAction={lastAction} />}

        {tab === "report" && (
          <TaskReport key={task.id} taskId={task.id} projectId={task.projectId} revision={reportRevision} />
        )}

        {tab === "docs" && <Attachments taskId={task.id} docs={detail.docs} />}

        {tab === "notes" && <TaskNotes taskId={task.id} onSaved={onChanged} />}

        {tab === "diff" && <Diff projectId={detail.project?.id} />}

        {tab === "settings" && <TaskSettings detail={detail} />}
      </div>

      </div>

      {asking && <AskPanel taskId={task.id} onClose={closeAsk} />}

      {handoff && (
        <HandoffDialog
          detail={detail}
          roles={roles}
          preset={handoff === true ? undefined : handoff}
          onClose={() => setHandoff(undefined)}
          onDone={onChanged}
        />
      )}
      {review && <ReviewDialog detail={detail} onClose={() => setReview(false)} onDone={onChanged} />}
    </div>
  );
}
