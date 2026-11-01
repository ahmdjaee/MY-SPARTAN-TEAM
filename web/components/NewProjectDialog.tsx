import { useState } from "react";
import { api } from "../api.ts";

/** Project baru: hanya nama yang wajib; target & workspace bisa diisi belakangan di halaman Project. */
export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (projectId: string) => void;
}) {
  const [name, setName] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (!name.trim() || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const { project } = await api.createProject({
        name: name.trim(),
        targetUrl: targetUrl.trim() || undefined,
        workspaceDir: workspaceDir.trim() || undefined,
      });
      onCreated(project.id);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-scrim p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-line bg-raised p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-ink">Project baru</h3>
        <p className="mt-1 text-xs text-muted">
          Project adalah induk tugas: konteks, memori, URL target, dan folder workspace-nya dipakai bersama semua tugas
          di dalamnya.
        </p>

        <label className="mt-4 block">
          <span className="text-xs text-muted">Nama</span>
          <input
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="RDMS Staging"
            className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />
        </label>

        <label className="mt-3 block">
          <span className="text-xs text-muted">URL target (opsional)</span>
          <input
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="http://localhost:3000"
            className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />
        </label>

        <label className="mt-3 block">
          <span className="text-xs text-muted">Folder workspace (opsional)</span>
          <input
            value={workspaceDir}
            onChange={(e) => setWorkspaceDir(e.target.value)}
            spellCheck={false}
            placeholder="kosong = pakai folder bawaan aplikasi"
            className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent"
          />
        </label>

        {error && <p className="mt-3 rounded-lg border border-line bg-tag-red p-2 text-xs text-tag-red-ink">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
            Batal
          </button>
          <button
            onClick={() => void submit()}
            disabled={sending || !name.trim()}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
          >
            {sending ? "Membuat…" : "Buat project"}
          </button>
        </div>
      </div>
    </div>
  );
}
