import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type TaskDetail, type TaskStatus } from "../api.ts";
import { projectPath, taskPath, useAppContext } from "../routes.tsx";

/** Sama dengan ACTIVE_STATUSES di server: agennya masih bisa menulis ke folder tugas. */
const ACTIVE: TaskStatus[] = ["queued", "running", "waiting"];

/** "a", "a dan b", "a, b, dan c". */
function listText(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")}${items.length > 2 ? "," : ""} dan ${items[items.length - 1]}`;
}

/** Isi folder tugas yang ikut terhapus, dari data detail yang sudah dimuat. */
function contentsOf(detail: TaskDetail): string {
  const parts = ["transcript"];
  if (detail.report !== null) parts.push("report.md");
  if (detail.assets.length > 0) parts.push(`${detail.assets.length} screenshot bukti`);
  if (detail.docs.length > 0) parts.push(`${detail.docs.length} lampiran`);
  if (detail.hasNotes) parts.push("catatan Anda");
  const text = listText(parts);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Tab Setelan tugas. Hapus sengaja hanya ada di sini, di dalam Zona berbahaya, dan masih
 * meminta ID tugas diketik ulang — supaya tidak pernah terhapus karena salah klik.
 */
export function TaskSettings({ detail }: { detail: TaskDetail }) {
  const { task } = detail;
  const [confirming, setConfirming] = useState(false);
  const { refresh, tasks } = useAppContext();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const active = ACTIVE.includes(task.status);

  // Tugas yang mulai berjalan lagi selagi dialog terbuka: tutup dialognya, tombolnya ikut nonaktif.
  useEffect(() => {
    if (active) setConfirming(false);
  }, [active]);

  // Langsung ke tugas berikutnya, bukan ke "/": daftar di memori masih memuat tugas yang baru dihapus,
  // dan TasksIndex bisa memantul kembali ke sana. Tanpa tugas lain, ke halaman project-nya.
  const onDeleted = (): void => {
    refresh();
    const project = search.get("project");
    const next = tasks.find((item) => item.id !== task.id && (!project || item.projectId === project));
    navigate(next ? taskPath(next.id, undefined, search) : projectPath(task.projectId, search), { replace: true });
  };

  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <div className="max-w-2xl">
        <h3 className="text-xs uppercase tracking-wide text-tag-red-ink">Zona berbahaya</h3>
        <div data-danger-zone className="mt-2 rounded-lg border border-tag-red-ink">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Hapus tugas ini</p>
              <p className="mt-0.5 text-xs text-muted">
                {contentsOf(detail)} ikut terhapus permanen dan tidak bisa dikembalikan.
              </p>
              <p className="mt-1 text-xs text-faint">
                Register temuan project tidak berubah. Di Report project, {task.id} tetap tampil berlabel{" "}
                <span className="text-muted">dihapus</span> beserta verdict dan ringkasan terakhirnya.
              </p>
              {active && (
                <p data-delete-blocked className="mt-1 text-xs text-tag-red-ink">
                  Tugas masih berjalan — hentikan dengan Batalkan di atas sebelum menghapus.
                </p>
              )}
            </div>
            <button
              data-delete-open
              onClick={() => setConfirming(true)}
              disabled={active}
              className="shrink-0 rounded-lg border border-tag-red-ink px-3 py-1.5 text-sm font-medium text-tag-red-ink hover:bg-tag-red disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Hapus tugas ini…
            </button>
          </div>
        </div>
      </div>

      {confirming && (
        <DeleteTaskDialog detail={detail} onClose={() => setConfirming(false)} onDeleted={onDeleted} />
      )}
    </div>
  );
}

function DeleteTaskDialog({
  detail,
  onClose,
  onDeleted,
}: {
  detail: TaskDetail;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { task } = detail;
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const matches = typed.trim() === task.id;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !deleting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleting, onClose]);

  const submit = async (): Promise<void> => {
    if (!matches || deleting) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteTask(task.id, typed.trim());
      onDeleted();
    } catch (cause) {
      setError((cause as Error).message);
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-scrim p-4" onClick={() => !deleting && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-task-title"
        data-delete-dialog
        className="w-full max-w-md rounded-xl border border-line bg-raised p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="delete-task-title" className="text-sm font-semibold text-ink">
          Hapus {task.id}?
        </h3>
        <p className="mt-1 truncate text-xs text-muted" title={task.title}>
          {task.title}
        </p>

        <p className="mt-3 text-sm text-ink">{contentsOf(detail)} ikut terhapus permanen.</p>
        <p className="mt-1 text-xs text-muted">
          Register temuan project tidak berubah; rujukan ke {task.id} di Report project ditandai{" "}
          <span className="text-ink">dihapus</span>.
        </p>
        <p className="mt-3 rounded-lg border border-line bg-tag-red p-2 text-xs text-tag-red-ink">
          Tindakan ini tidak bisa dibatalkan.
        </p>

        <label className="mt-4 block">
          <span className="text-xs text-muted">
            Ketik <span className="font-mono font-semibold text-ink">{task.id}</span> untuk mengonfirmasi
          </span>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            disabled={deleting}
            autoComplete="off"
            spellCheck={false}
            data-delete-confirm
            className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 font-mono text-sm text-ink outline-none focus:border-tag-red-ink"
          />
        </label>

        {error && <p className="mt-3 rounded-lg border border-line bg-tag-red p-2 text-xs text-tag-red-ink">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={deleting}
            className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink disabled:opacity-40"
          >
            Batal
          </button>
          <button
            data-delete-submit
            onClick={() => void submit()}
            disabled={!matches || deleting}
            className="rounded-lg border border-tag-red-ink bg-tag-red px-3 py-1.5 text-sm font-medium text-tag-red-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {deleting ? "Menghapus…" : "Hapus tugas ini"}
          </button>
        </div>
      </div>
    </div>
  );
}
