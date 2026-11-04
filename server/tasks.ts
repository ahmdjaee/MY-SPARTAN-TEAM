import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { trimMemory } from "./memory.ts";
import type { AutonomyMode, RoleId } from "./types.ts";

export type TaskStatus = "queued" | "running" | "waiting" | "needs_review" | "done" | "failed" | "cancelled";

/** Status yang berarti tugas masih butuh agen. */
export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "waiting"];

export type Assignment = {
  role: RoleId;
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  handoffNote?: string;
  summary?: string;
  costUsd: number;
};

export type Review = {
  status: "approved" | "changes_requested";
  comment: string;
  reviewedAt: string;
};

export type Task = {
  id: string;
  title: string;
  description: string;
  role: RoleId;
  /** Induk tugas: project yang memegang konteks, memori, target, dan workspace-nya. */
  projectId: string;
  status: TaskStatus;
  /** Mode otonomi khusus tugas ini; kosong = ikut bawaan bot di Pengaturan. */
  mode?: AutonomyMode;
  targetUrl?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  costUsd: number;
  /** Biaya panel Tanya (incognito), dipisah dari biaya bot yang mengerjakan tugas. */
  askCostUsd?: number;
  assignments: Assignment[];
  review?: Review;
  suggestedNext?: { role: RoleId; note: string; at: string };
};

export type TaskSummary = Omit<Task, "description"> & { assetCount: number; hasReport: boolean };

export function taskDir(id: string): string {
  return join(CONFIG.tasksDir, id);
}

export function assetsDir(id: string): string {
  return join(taskDir(id), "assets");
}

export function reportPath(id: string): string {
  return join(taskDir(id), "report.md");
}

/** Catatan pribadi pemilik produk untuk satu tugas. Tidak pernah dibaca bot. */
export function notesPath(id: string): string {
  return join(taskDir(id), "notes.md");
}

const NOTES_MAX = 64 * 1024;

export function readNotes(id: string): string {
  const path = notesPath(id);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function writeNotes(id: string, text: string): string {
  const trimmed = trimMemory(text, NOTES_MAX);
  mkdirSync(taskDir(id), { recursive: true });
  const tmp = `${notesPath(id)}.tmp`;
  writeFileSync(tmp, trimmed);
  renameSync(tmp, notesPath(id));
  return trimmed;
}

export function hasNotes(id: string): boolean {
  try {
    return statSync(notesPath(id)).size > 0;
  } catch {
    return false;
  }
}

// ---------- indeks dalam memori ----------

const index = new Map<string, Task>();

/** assetCount/hasReport untuk daftar — tugas yang sudah berhenti tidak berubah lagi, jadi cukup dihitung sekali. */
const summaryCache = new Map<string, { assetCount: number; hasReport: boolean }>();

const tasksListeners = new Set<() => void>();

/** Dipanggil setiap task.json ditulis — dipakai SSE /api/events untuk menyuruh klien memuat ulang daftar. */
export function onTasksChanged(listener: () => void): () => void {
  tasksListeners.add(listener);
  return () => tasksListeners.delete(listener);
}

function metaPath(id: string): string {
  return join(taskDir(id), "task.json");
}

function persist(task: Task): void {
  mkdirSync(taskDir(task.id), { recursive: true });
  const tmp = `${metaPath(task.id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(task, null, 2));
  renameSync(tmp, metaPath(task.id));
  index.set(task.id, task);
  summaryCache.delete(task.id);
  for (const listener of tasksListeners) {
    try {
      listener();
    } catch {
      // satu penyimak yang error tidak boleh menggagalkan penyimpanan
    }
  }
}

export function loadTasks(): void {
  index.clear();
  if (!existsSync(CONFIG.tasksDir)) return;
  for (const entry of readdirSync(CONFIG.tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(CONFIG.tasksDir, entry.name, "task.json");
    if (!existsSync(path)) continue;
    try {
      const task = JSON.parse(readFileSync(path, "utf8")) as Task;
      index.set(task.id, task);
    } catch {
      // tugas rusak dilewati
    }
  }
}

function nextId(): string {
  let next = 1;
  if (existsSync(CONFIG.counterPath)) {
    try {
      next = (JSON.parse(readFileSync(CONFIG.counterPath, "utf8")) as { next: number }).next;
    } catch {
      next = index.size + 1;
    }
  }
  while (index.has(`T-${String(next).padStart(3, "0")}`)) next += 1;
  writeFileSync(CONFIG.counterPath, JSON.stringify({ next: next + 1 }));
  return `T-${String(next).padStart(3, "0")}`;
}

// ---------- operasi ----------

export function createTask(input: {
  title: string;
  description: string;
  role: RoleId;
  projectId: string;
  targetUrl?: string;
}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: nextId(),
    title: input.title.trim().slice(0, 140),
    description: input.description.trim(),
    role: input.role,
    projectId: input.projectId,
    status: "queued",
    targetUrl: input.targetUrl?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    costUsd: 0,
    assignments: [{ role: input.role, startedAt: now, costUsd: 0 }],
  };
  mkdirSync(assetsDir(task.id), { recursive: true });
  persist(task);
  return task;
}

export function getTask(id: string): Task | undefined {
  return index.get(id);
}

export function updateTask(id: string, patch: Partial<Task>): Task | undefined {
  const task = index.get(id);
  if (!task) return undefined;
  const next: Task = { ...task, ...patch, updatedAt: new Date().toISOString() };
  persist(next);
  return next;
}

/** Penugasan yang sedang berjalan (selalu elemen terakhir). */
export function currentAssignment(task: Task): Assignment {
  const last = task.assignments[task.assignments.length - 1];
  if (last) return last;
  const fresh: Assignment = { role: task.role, startedAt: new Date().toISOString(), costUsd: 0 };
  task.assignments.push(fresh);
  return fresh;
}

export function patchAssignment(id: string, patch: Partial<Assignment>): Task | undefined {
  const task = index.get(id);
  if (!task) return undefined;
  const assignments = [...task.assignments];
  const last = assignments[assignments.length - 1];
  if (!last) return task;
  assignments[assignments.length - 1] = { ...last, ...patch };
  return updateTask(id, { assignments });
}

/** Tutup penugasan sekarang dan buka penugasan baru untuk role lain. */
export function addAssignment(id: string, role: RoleId, handoffNote?: string): Task | undefined {
  const task = index.get(id);
  if (!task) return undefined;
  const now = new Date().toISOString();
  const assignments = [...task.assignments];
  const last = assignments[assignments.length - 1];
  if (last && !last.endedAt) assignments[assignments.length - 1] = { ...last, endedAt: now };
  assignments.push({ role, startedAt: now, handoffNote, costUsd: 0 });
  return updateTask(id, { assignments, role, status: "queued", suggestedNext: undefined });
}

export function addCost(id: string, costUsd: number): void {
  const task = index.get(id);
  if (!task || !costUsd) return;
  const assignments = [...task.assignments];
  const last = assignments[assignments.length - 1];
  if (last) assignments[assignments.length - 1] = { ...last, costUsd: last.costUsd + costUsd };
  updateTask(id, { assignments, costUsd: Number((task.costUsd + costUsd).toFixed(6)) });
}

/** Biaya panel Tanya tidak ikut menambah biaya tugas — angka di daftar tetap berarti "biaya bot". */
export function addAskCost(id: string, costUsd: number): void {
  const task = index.get(id);
  if (!task || !costUsd) return;
  updateTask(id, { askCostUsd: Number(((task.askCostUsd ?? 0) + costUsd).toFixed(6)) });
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

export function listAssets(id: string): string[] {
  const dir = assetsDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => IMAGE_RE.test(name))
    .sort();
}

export function readReport(id: string): string | undefined {
  const path = reportPath(id);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export type DocInfo = { path: string; size: number; mtime: string };

/** Sudah punya tempat sendiri di UI: tab Laporan, dan mesin aplikasi. */
// notes.md milik Anda sendiri dan sudah punya tabnya; task.json/thread.jsonl mesin aplikasi.
const DOC_SKIP_NAMES = new Set(["report.md", "notes.md", "task.json", "thread.jsonl"]);
const DOC_MAX = 200;
const DOC_MAX_DEPTH = 3;

/**
 * Lampiran: berkas teks lain di folder tugas — laporan tambahan, bukti data, artefak kerja.
 * `report.md` dan gambar di `assets/` tidak ikut karena sudah tampil di tab Laporan.
 */
export function listDocs(id: string): DocInfo[] {
  const root = taskDir(id);
  if (!existsSync(root)) return [];
  const docs: DocInfo[] = [];

  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (docs.length >= DOC_MAX) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (!prefix && entry.name === "assets") continue;
        if (depth + 1 >= DOC_MAX_DEPTH) continue;
        walk(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
        continue;
      }
      // isFile() memakai lstat, jadi symlink tersaring di sini.
      if (!entry.isFile()) continue;
      if (!prefix && DOC_SKIP_NAMES.has(entry.name)) continue;
      if (entry.name.endsWith(".tmp") || IMAGE_RE.test(entry.name)) continue;
      try {
        const stat = statSync(join(dir, entry.name));
        docs.push({ path: `${prefix}${entry.name}`, size: stat.size, mtime: stat.mtime.toISOString() });
      } catch {
        // berkas hilang di tengah jalan
      }
    }
  };
  walk(root, "", 0);

  const depthOf = (path: string): number => path.split("/").length;
  return docs.sort((a, b) => depthOf(a.path) - depthOf(b.path) || b.mtime.localeCompare(a.mtime));
}

/** Path absolut lampiran, hanya kalau ia memang ada di daftar — sekaligus penutup path traversal. */
export function resolveDoc(id: string, relPath: string): string | undefined {
  if (!listDocs(id).some((doc) => doc.path === relPath)) return undefined;
  return join(taskDir(id), relPath);
}

/** Urutan tampil: yang menunggu Anda lebih dulu, lalu yang sedang jalan, lalu terbaru. */
const RANK: Record<TaskStatus, number> = {
  waiting: 0,
  needs_review: 1,
  running: 2,
  queued: 3,
  failed: 4,
  done: 5,
  cancelled: 6,
};

/** Agen masih menulis ke folder tugas aktif di luar persist(), jadi hanya tugas berhenti yang di-cache. */
function summaryExtras(task: Task): { assetCount: number; hasReport: boolean } {
  const active = ACTIVE_STATUSES.includes(task.status);
  if (!active) {
    const cached = summaryCache.get(task.id);
    if (cached) return cached;
  }
  const extras = { assetCount: listAssets(task.id).length, hasReport: existsSync(reportPath(task.id)) };
  if (!active) summaryCache.set(task.id, extras);
  return extras;
}

export function listTasks(filter?: { role?: RoleId; status?: TaskStatus; project?: string }): TaskSummary[] {
  return [...index.values()]
    .filter(
      (task) =>
        (!filter?.role || task.role === filter.role) &&
        (!filter?.status || task.status === filter.status) &&
        (!filter?.project || task.projectId === filter.project),
    )
    .map((task) => {
      const { description: _description, ...rest } = task;
      return { ...rest, ...summaryExtras(task) };
    })
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.updatedAt.localeCompare(a.updatedAt));
}

/** Semua tugas satu project, terbaru dulu — dipakai konteks bersama dan halaman Project. */
export function tasksInProject(projectId: string): Task[] {
  return [...index.values()]
    .filter((task) => task.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Tugas yang belum punya induk (data dari versi sebelum fitur project). */
export function orphanTasks(): Task[] {
  return [...index.values()].filter((task) => !task.projectId);
}

export function activeTasks(): Task[] {
  return [...index.values()].filter((task) => ACTIVE_STATUSES.includes(task.status));
}

/**
 * Ambil bagian "Ringkasan serah terima" dari teks penutup agen.
 * Kalau tidak ada, pakai beberapa baris terakhir sebagai gantinya.
 */
export function extractHandoffSummary(text: string): string {
  const match = text.match(/##+\s*Ringkasan serah terima\s*\n([\s\S]*)$/i);
  const body = (match?.[1] ?? text).trim();
  return body.length > 4000 ? `${body.slice(0, 4000)}…` : body;
}
