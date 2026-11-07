import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ROLE_SHORT,
  STATUS_LABEL,
  STATUS_STYLE,
  api,
  type ProjectDetail,
  type ProjectInfo,
  type TaskSummary,
} from "../api.ts";
import { taskPath } from "../routes.tsx";
import { MarkdownEditor, isEditorView, type EditorView } from "./MarkdownEditor.tsx";
import { ProjectReport } from "./ProjectReport.tsx";

const TABS = [
  ["context", "Konteks"],
  ["memory", "Memori project"],
  ["tasks", "Tugas"],
  ["recap", "Report"],
  ["settings", "Setelan"],
] as const;
type PageTab = (typeof TABS)[number][0];

function Settings({
  project,
  projects,
  onChanged,
}: {
  project: ProjectInfo;
  projects: ProjectInfo[];
  onChanged: () => void;
}) {
  const [targetUrl, setTargetUrl] = useState(project.targetUrl ?? "");
  const [workspaceDir, setWorkspaceDir] = useState(project.ownWorkspaceDir ?? "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTargetUrl(project.targetUrl ?? "");
    setWorkspaceDir(project.ownWorkspaceDir ?? "");
    setError(undefined);
  }, [project.id, project.targetUrl, project.ownWorkspaceDir]);

  const dirty = targetUrl !== (project.targetUrl ?? "") || workspaceDir !== (project.ownWorkspaceDir ?? "");

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.patchProject(project.id, { targetUrl, workspaceDir });
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Hapus project ${project.name}?`)) return;
    try {
      await api.deleteProject(project.id);
      onChanged();
    } catch (cause) {
      alert((cause as Error).message);
    }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <label className="block">
        <span className="text-xs text-muted">URL target bawaan</span>
        <input
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          placeholder="http://localhost:3000"
          className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
        <span className="mt-1 block text-[11px] text-faint">Mengisi sendiri kolom target saat Anda membuat tugas QA atau UI/UX di project ini.</span>
      </label>

      <label className="block">
        <span className="text-xs text-muted">Folder workspace</span>
        <input
          value={workspaceDir}
          onChange={(e) => setWorkspaceDir(e.target.value)}
          placeholder={`kosong = ${project.workspaceDir}`}
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent"
        />
        <span className="mt-1 block text-[11px] text-faint">
          Folder yang dipegang Engineer & DevOps di project ini. Yang berlaku sekarang:{" "}
          <span className="font-mono text-muted">{project.workspaceDir}</span>. Folder sistem, folder data aplikasi, dan
          folder sesi login Claude ditolak.
        </span>
      </label>

      {error && <p className="rounded-lg border border-line bg-tag-red p-3 text-xs text-tag-red-ink">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
        >
          {saving ? "Menyimpan…" : "Simpan setelan"}
        </button>
        <button
          onClick={() => void api.patchProject(project.id, { archived: !project.archived }).then(onChanged)}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink hover:bg-hover"
        >
          {project.archived ? "Keluarkan dari arsip" : "Arsipkan project"}
        </button>
        {project.taskCount === 0 && projects.length > 1 && (
          <button onClick={() => void remove()} className="ml-auto text-sm text-muted hover:text-tag-red-ink">
            Hapus project
          </button>
        )}
      </div>
    </div>
  );
}

function Tasks({
  tasks,
  projects,
  projectId,
  search,
  onChanged,
}: {
  tasks: TaskSummary[];
  projects: ProjectInfo[];
  projectId: string;
  search: URLSearchParams;
  onChanged: () => void;
}) {
  if (tasks.length === 0) {
    return <p className="rounded-lg border border-line bg-panel p-3 text-sm text-muted">Belum ada tugas di project ini.</p>;
  }
  const others = projects.filter((project) => project.id !== projectId);

  return (
    <div className="space-y-1.5">
      {tasks.map((task) => (
        <div key={task.id} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
          <Link to={taskPath(task.id, undefined, search)} className="min-w-0 flex-1">
            <span className="font-mono text-[11px] text-muted">{task.id}</span>
            <span className="ml-2 text-sm text-ink hover:underline">{task.title}</span>
          </Link>
          <span className="shrink-0 text-[11px] text-faint">{ROLE_SHORT[task.role]}</span>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[task.status]}`}>
            {STATUS_LABEL[task.status]}
          </span>
          {task.costUsd > 0 && <span className="shrink-0 text-[11px] text-faint">${task.costUsd.toFixed(4)}</span>}
          {others.length > 0 && (
            <select
              value=""
              onChange={(e) => void api.moveTask(task.id, e.target.value).then(onChanged)}
              title="Pindahkan tugas ini ke project lain"
              className="shrink-0 rounded border border-line bg-page px-1 py-0.5 text-[11px] text-muted"
            >
              <option value="" disabled>
                pindah ke…
              </option>
              {others.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          )}
        </div>
      ))}
    </div>
  );
}

export function ProjectPage({
  projectId,
  projects,
  onChanged,
}: {
  projectId: string;
  projects: ProjectInfo[];
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ProjectDetail>();
  const [error, setError] = useState<string>();
  const [search, setSearch] = useSearchParams();
  const [nameDraft, setNameDraft] = useState<string | undefined>(undefined);
  const tabFromUrl = search.get("tab");
  const tab: PageTab = (TABS.find(([value]) => value === tabFromUrl)?.[0] ?? "context") as PageTab;
  // Mode baca/tulis dipakai bersama kedua editor, jadi berpindah tab tidak mengubahnya.
  const viewFromUrl = search.get("view");
  const view: EditorView = isEditorView(viewFromUrl) ? viewFromUrl : "write";

  const currentProject = useRef(projectId);
  currentProject.current = projectId;

  const load = () => {
    void api
      .project(projectId)
      .then((data) => {
        if (currentProject.current !== projectId) return;
        setDetail(data);
        setError(undefined);
      })
      .catch((cause: Error) => currentProject.current === projectId && setError(cause.message));
  };

  useEffect(() => {
    setDetail(undefined);
    setNameDraft(undefined);
    load();
  }, [projectId]);

  const setTab = (next: PageTab) => {
    const params = new URLSearchParams(search);
    params.set("tab", next);
    setSearch(params, { replace: true });
  };

  const setView = (next: EditorView) => {
    const params = new URLSearchParams(search);
    params.set("view", next);
    setSearch(params, { replace: true });
  };

  const refresh = () => {
    load();
    onChanged();
  };

  if (error) {
    return (
      <div className="p-6">
        <p className="rounded-lg border border-line bg-panel p-3 text-sm text-muted">
          Project <span className="font-mono text-ink">{projectId}</span> tidak ditemukan — {error}
        </p>
        <Link to="/" className="mt-3 inline-block text-sm text-accent underline underline-offset-2">
          Kembali ke daftar tugas
        </Link>
      </div>
    );
  }
  if (!detail) return <p className="p-6 text-sm text-faint">Memuat project…</p>;
  const { project } = detail;
  // Angka di label tab Rekap datang dari data yang sudah ada — tanpa request tambahan.
  const reportCount = detail.tasks.filter((task) => task.hasReport).length;

  const saveName = () => {
    const next = nameDraft?.trim() ?? "";
    setNameDraft(undefined);
    if (!next || next === project.name) return;
    void api
      .patchProject(project.id, { name: next })
      .then(refresh)
      .catch((cause: Error) => alert(cause.message));
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0 font-mono text-xs text-muted">{project.id}</span>
          {project.archived && (
            <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[11px] text-muted">arsip</span>
          )}
          <span className="min-w-0 flex-1 basis-0 truncate text-xs text-muted" title={project.workspaceDir}>
            {project.workspaceDir}
          </span>
          {project.costUsd > 0 && <span className="shrink-0 text-xs text-faint">${project.costUsd.toFixed(4)}</span>}
          <span className="shrink-0 text-xs text-faint">
            {project.taskCount} tugas
            {project.waitingCount > 0 ? ` · ${project.waitingCount} butuh Anda` : ""}
          </span>
        </div>
        {nameDraft === undefined ? (
          <h2
            onClick={() => setNameDraft(project.name)}
            title="Klik untuk mengganti nama"
            className="-mx-1 mt-1 cursor-text truncate rounded px-1 text-sm font-semibold text-ink hover:bg-hover"
          >
            {project.name}
          </h2>
        ) : (
          <input
            autoFocus
            value={nameDraft}
            maxLength={80}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") setNameDraft(undefined);
            }}
            className="-mx-1 mt-1 w-full rounded border border-accent bg-page px-1 text-sm font-semibold text-ink outline-none"
          />
        )}

        <nav className="mt-3 flex flex-wrap gap-1 text-xs">
          {TABS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={`rounded-lg px-3 py-1.5 ${tab === value ? "bg-hover text-ink" : "text-muted hover:bg-hover"}`}
            >
              {label}
              {value === "tasks" && project.taskCount > 0 ? ` (${project.taskCount})` : ""}
              {value === "recap" && reportCount > 0 ? ` (${reportCount})` : ""}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {tab === "context" && (
          <div className="h-full">
            <MarkdownEditor
              value={detail.context}
              view={view}
              onView={setView}
              note="Ditulis Anda. Semua bot di project ini membacanya di setiap tugas, sebelum instruksi tugas."
              onSave={async (text) => (await api.saveProjectContext(project.id, text)).text}
            />
          </div>
        )}
        {tab === "memory" && (
          <div className="h-full">
            <MarkdownEditor
              value={detail.memory}
              view={view}
              onView={setView}
              note="Bagian Catatan tim dirapikan otomatis oleh kurator dari catatan `remember` bot; bagian lain milik Anda. Isinya ikut dibaca setiap tugas di project ini."
              onSave={async (text) => (await api.saveProjectMemory(project.id, text)).text}
            />
          </div>
        )}
        {tab === "tasks" && (
          <Tasks
            tasks={detail.tasks}
            projects={projects}
            projectId={project.id}
            search={search}
            onChanged={refresh}
          />
        )}
        {tab === "recap" && <ProjectReport projectId={project.id} search={search} />}
        {tab === "settings" && <Settings project={project} projects={projects} onChanged={refresh} />}
      </div>
    </div>
  );
}
