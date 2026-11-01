import type { AttentionEvent, AutonomyMode, RoleId, StoredEvent, UiEvent, WorkerStatus } from "../server/types.ts";
import type { Settings } from "../server/settings.ts";
import type { Assignment, Review, Task, TaskStatus, TaskSummary } from "../server/tasks.ts";
import type { Project } from "../server/projects.ts";
import type { AskMessage } from "../server/agent/ask.ts";

export type { AskMessage, Assignment, AttentionEvent, AutonomyMode, Project, RoleId, Review, Settings, StoredEvent, Task, TaskStatus, TaskSummary, UiEvent, WorkerStatus };

/** Project + angka ringkas untuk pemilih sidebar dan halaman Project. */
export type ProjectInfo = Project & {
  /** Workspace efektif (folder sendiri kalau diisi, kalau tidak folder bawaan aplikasi). */
  workspaceDir: string;
  ownWorkspaceDir?: string;
  taskCount: number;
  waitingCount: number;
  reviewCount: number;
  costUsd: number;
};

export type ProjectDetail = { project: ProjectInfo; context: string; memory: string; tasks: TaskSummary[] };

export type RoleInfo = {
  id: RoleId;
  title: string;
  blurb: string;
  model: string;
  producesReport: boolean;
  usesBrowser: boolean;
};

export type Slots = { inUse: number; max: number; runners: number; workspaceBusy: boolean };

export type LiveState = { active: boolean; url?: string; title?: string; lastFrameAt?: number; hasFrame?: boolean };

export type TaskListItem = TaskSummary & { live?: boolean };

/** Lampiran: berkas teks lain di folder tugas, selain report.md dan gambar bukti. */
export type DocInfo = { path: string; size: number; mtime: string };
export type DocContent = DocInfo & { text?: string; truncated?: boolean; binary?: boolean };

export type TaskDetail = {
  task: Task;
  project?: { id: string; name: string; workspaceDir: string };
  events: StoredEvent[];
  openRequests: UiEvent[];
  runnerStatus: WorkerStatus;
  assets: string[];
  docs: DocInfo[];
  report: string | null;
  /** Ada isinya atau tidak — dipakai untuk menandai tab Catatan. */
  hasNotes: boolean;
  live: LiveState;
  mode: AutonomyMode;
};

function docUrl(id: string, path: string, raw = false): string {
  return `/api/tasks/${encodeURIComponent(id)}/doc${raw ? "/raw" : ""}?path=${encodeURIComponent(path)}`;
}

/** Tautan unduh lampiran apa adanya (dipakai di href, bukan lewat fetch). */
export function docRawUrl(id: string, path: string): string {
  return docUrl(id, path, true);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export const api = {
  roles: () =>
    request<{ workspaceDir: string; targetUrl: string; slots: Slots; roles: RoleInfo[] }>("/api/roles"),
  auth: () =>
    request<{ account: { email?: string; subscriptionType?: string } | null; error?: string }>("/api/health/auth"),

  tasks: (filter?: { role?: RoleId | ""; status?: TaskStatus | ""; project?: string }) => {
    const params = new URLSearchParams();
    if (filter?.role) params.set("role", filter.role);
    if (filter?.status) params.set("status", filter.status);
    if (filter?.project) params.set("project", filter.project);
    const query = params.toString();
    return request<{ tasks: TaskListItem[]; slots: Slots }>(`/api/tasks${query ? `?${query}` : ""}`);
  },
  task: (id: string) => request<TaskDetail>(`/api/tasks/${id}`),
  taskDoc: (id: string, path: string) => request<DocContent>(docUrl(id, path)),
  liveStatus: (id: string) => request<LiveState>(`/api/tasks/${id}/live/status`),
  taskNotes: (id: string) => request<{ text: string }>(`/api/tasks/${id}/notes`),
  askHistory: (id: string) =>
    request<{ messages: AskMessage[]; busy: boolean; costUsd: number; models: { id: string; label: string }[] }>(
      `/api/tasks/${id}/ask`,
    ),
  ask: (id: string, body: { text: string; model?: string }) =>
    request<{ message: AskMessage }>(`/api/tasks/${id}/ask`, { method: "POST", body: JSON.stringify(body) }),
  clearAsk: (id: string) => request<{ ok: true }>(`/api/tasks/${id}/ask`, { method: "DELETE" }),
  saveTaskNotes: (id: string, text: string) =>
    request<{ text: string }>(`/api/tasks/${id}/notes`, { method: "PUT", body: JSON.stringify({ text }) }),
  createTask: (body: { title: string; description: string; role: RoleId; projectId: string; targetUrl?: string }) =>
    request<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  message: (id: string, text: string) =>
    request<{ ok: true }>(`/api/tasks/${id}/message`, { method: "POST", body: JSON.stringify({ text }) }),
  interrupt: (id: string) => request<{ ok: true }>(`/api/tasks/${id}/interrupt`, { method: "POST" }),
  cancel: (id: string) => request<{ ok: true }>(`/api/tasks/${id}/cancel`, { method: "POST" }),
  handoff: (id: string, body: { role: RoleId; note?: string }) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/handoff`, { method: "POST", body: JSON.stringify(body) }),
  review: (id: string, body: { status: "approved" | "changes_requested"; comment: string; sendBackToAgent: boolean }) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/review`, { method: "POST", body: JSON.stringify(body) }),

  approve: (id: string, body: { decision: "allow" | "deny"; message?: string; remember?: boolean }) =>
    request<{ ok: true }>(`/api/approvals/${id}`, { method: "POST", body: JSON.stringify(body) }),
  answer: (id: string, answers: Record<string, string>) =>
    request<{ ok: true }>(`/api/questions/${id}`, { method: "POST", body: JSON.stringify({ answers }) }),

  renameTask: (id: string, title: string) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/title`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  setMode: (id: string, mode: AutonomyMode) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/mode`, { method: "POST", body: JSON.stringify({ mode }) }),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),

  projects: () => request<{ projects: ProjectInfo[] }>("/api/projects"),
  project: (id: string) => request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),
  createProject: (body: { name: string; targetUrl?: string; workspaceDir?: string }) =>
    request<{ project: ProjectInfo }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  patchProject: (id: string, patch: { name?: string; targetUrl?: string; workspaceDir?: string; archived?: boolean }) =>
    request<{ project: ProjectInfo }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  saveProjectContext: (id: string, text: string) =>
    request<{ text: string }>(`/api/projects/${encodeURIComponent(id)}/context`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  saveProjectMemory: (id: string, text: string) =>
    request<{ text: string }>(`/api/projects/${encodeURIComponent(id)}/memory`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  deleteProject: (id: string) =>
    request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  moveTask: (id: string, projectId: string) =>
    request<{ ok: true; task: Task }>(`/api/tasks/${id}/project`, {
      method: "POST",
      body: JSON.stringify({ projectId }),
    }),

  memory: () => request<{ text: string }>("/api/memory"),
  saveMemory: (text: string) =>
    request<{ text: string }>("/api/memory", { method: "PUT", body: JSON.stringify({ text }) }),

  diff: (projectId?: string) =>
    request<{ isRepo: boolean; dir: string; branch: string; status: string; diff: string }>(
      `/api/workspace/diff${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`,
    ),
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "antre",
  running: "dikerjakan",
  waiting: "butuh Anda",
  needs_review: "perlu dibaca",
  done: "selesai",
  failed: "gagal",
  cancelled: "dibatalkan",
};

export const STATUS_STYLE: Record<TaskStatus, string> = {
  queued: "bg-tag-gray text-tag-gray-ink",
  running: "bg-tag-blue text-tag-blue-ink",
  waiting: "bg-tag-yellow text-tag-yellow-ink",
  needs_review: "bg-tag-orange text-tag-orange-ink",
  done: "bg-tag-green text-tag-green-ink",
  failed: "bg-tag-red text-tag-red-ink",
  cancelled: "bg-hover text-muted",
};

export const MODE_LABEL: Record<AutonomyMode, string> = {
  auto: "Auto",
  ask: "Minta approval",
  readonly: "Hanya baca",
};

export const MODE_NOTE: Record<AutonomyMode, string> = {
  auto: "Agen menjalankan perintahnya sendiri; hanya kategori kritis yang masih ditanyakan.",
  ask: "Perilaku seperti sekarang: perintah di luar daftar aman memunculkan kartu persetujuan.",
  readonly: "Agen hanya boleh menyelidiki dan menyusun rencana, tidak mengubah apa pun.",
};
