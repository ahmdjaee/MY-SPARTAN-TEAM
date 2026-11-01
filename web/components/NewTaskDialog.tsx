import { useEffect, useState } from "react";
import { api, type ProjectInfo, type RoleId, type RoleInfo } from "../api.ts";
import { Combobox } from "./Combobox.tsx";

export function NewTaskDialog({
  roles,
  projects,
  defaultProjectId,
  defaultTargetUrl,
  onClose,
  onCreated,
}: {
  roles: RoleInfo[];
  projects: ProjectInfo[];
  defaultProjectId: string;
  defaultTargetUrl: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState<RoleId>("qa");
  const [projectId, setProjectId] = useState(defaultProjectId);
  const project = projects.find((item) => item.id === projectId);
  const [targetUrl, setTargetUrl] = useState(project?.targetUrl ?? defaultTargetUrl);
  const [touchedTarget, setTouchedTarget] = useState(false);
  const [sending, setSending] = useState(false);

  // Ganti project → kolom target ikut berganti, selama Anda belum mengisinya sendiri.
  useEffect(() => {
    if (!touchedTarget) setTargetUrl(project?.targetUrl ?? defaultTargetUrl);
  }, [projectId, project?.targetUrl, defaultTargetUrl, touchedTarget]);

  const selected = roles.find((item) => item.id === role);

  const submit = async () => {
    if (!title.trim() || sending) return;
    setSending(true);
    try {
      const { task } = await api.createTask({
        title: title.trim(),
        description: description.trim() || title.trim(),
        role,
        projectId,
        targetUrl: selected?.usesBrowser ? targetUrl.trim() || undefined : undefined,
      });
      onCreated(task.id);
      onClose();
    } catch (error) {
      alert((error as Error).message);
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-scrim p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-xl border border-line bg-raised p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-ink">Tugas baru</h3>

        <label className="mt-4 block text-xs text-muted">Project</label>
        <div className="mt-1">
          <Combobox
            value={projectId}
            options={projects.map((item) => ({
              value: item.id,
              label: item.name,
              hint: item.workspaceDir,
              badge: String(item.taskCount),
            }))}
            onChange={setProjectId}
            ariaLabel="Pilih project tugas"
            searchPlaceholder="Cari project…"
          />
        </div>
        <p className="mt-1 text-[11px] text-faint">
          Bot membaca konteks & memori project ini, dan bekerja di{" "}
          <span className="font-mono text-muted">{project?.workspaceDir ?? "folder bawaan"}</span>.
        </p>

        <label className="mt-3 block text-xs text-muted">Judul</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="mis. Uji alur login staging"
          className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />

        <label className="mt-3 block text-xs text-muted">Instruksi untuk bot</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
          placeholder="Jelaskan apa yang harus dikerjakan, batasannya, dan apa yang Anda anggap selesai."
          className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />

        <label className="mt-3 block text-xs text-muted">Tugaskan ke</label>
        <div className="mt-1 flex gap-2">
          {roles.map((item) => (
            <button
              key={item.id}
              onClick={() => setRole(item.id)}
              title={item.blurb}
              className={`flex-1 rounded-lg border px-3 py-2 text-left ${
                role === item.id ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong"
              }`}
            >
              <span className="block text-sm text-ink">{item.title}</span>
              <span className="block font-mono text-[10px] text-muted">{item.model}</span>
            </button>
          ))}
        </div>

        {selected?.usesBrowser && (
          <>
            <label className="mt-3 block text-xs text-muted">URL yang diuji</label>
            <input
              value={targetUrl}
              onChange={(e) => {
                setTouchedTarget(true);
                setTargetUrl(e.target.value);
              }}
              placeholder="https://staging.contoh.com/login"
              className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
          </>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-faint">Tugas langsung dikerjakan begitu ada slot.</span>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
            Batal
          </button>
          <button
            onClick={() => void submit()}
            disabled={!title.trim() || sending}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
          >
            Buat & jalankan
          </button>
        </div>
      </div>
    </div>
  );
}
