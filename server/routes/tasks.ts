import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Router } from "express";
import { bus } from "../agent/bus.ts";
import { curator } from "../agent/curator.ts";
import { scheduler } from "../agent/scheduler.ts";
import { BOUNDARY, live } from "../browser/live.ts";
import { CONFIG } from "../config.ts";
import { defaultProjectId, getProject, workspaceForProject } from "../projects.ts";
import { ROLES, ROLE_IDS, isRoleId } from "../roles.ts";
import { threads } from "../store.ts";
import {
  assetsDir,
  createTask,
  getTask,
  hasNotes,
  readNotes,
  writeNotes,
  listAssets,
  listDocs,
  listTasks,
  onTasksChanged,
  readReport,
  resolveDoc,
  updateTask,
  type TaskStatus,
} from "../tasks.ts";
import { EPHEMERAL_EVENTS, type AttentionEvent, type AutonomyMode, type StoredEvent } from "../types.ts";
import { defaultModeFor } from "../settings.ts";

export const tasksRouter = Router();

const STATUSES: TaskStatus[] = ["queued", "running", "waiting", "needs_review", "done", "failed", "cancelled"];

tasksRouter.get("/roles", (_req, res) => {
  res.json({
    workspaceDir: CONFIG.workspaceDir,
    targetUrl: CONFIG.targetUrl,
    slots: scheduler.stats(),
    roles: ROLE_IDS.map((id) => ({
      id,
      title: ROLES[id].title,
      blurb: ROLES[id].blurb,
      model: ROLES[id].model,
      producesReport: ROLES[id].producesReport,
      usesBrowser: ROLES[id].usesBrowser,
    })),
  });
});

tasksRouter.get("/tasks", (req, res) => {
  const role = typeof req.query.role === "string" && isRoleId(req.query.role) ? req.query.role : undefined;
  const status =
    typeof req.query.status === "string" && STATUSES.includes(req.query.status as TaskStatus)
      ? (req.query.status as TaskStatus)
      : undefined;
  const project = typeof req.query.project === "string" && getProject(req.query.project) ? req.query.project : undefined;
  const tasks = listTasks({ role, status, project }).map((task) => ({ ...task, live: live.state(task.id).active }));
  res.json({ tasks, slots: scheduler.stats() });
});

tasksRouter.post("/tasks", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  const role = typeof req.body?.role === "string" ? req.body.role : "";
  if (!title || !isRoleId(role)) {
    res.status(400).json({ error: "judul dan bot wajib diisi" });
    return;
  }
  const requested = typeof req.body?.projectId === "string" ? req.body.projectId : "";
  const project = getProject(requested) ?? getProject(defaultProjectId());
  if (!project) {
    res.status(400).json({ error: "belum ada project — buat project dulu" });
    return;
  }
  const targetUrl =
    typeof req.body?.targetUrl === "string" && req.body.targetUrl.trim()
      ? req.body.targetUrl.trim()
      : ROLES[role].usesBrowser
        ? project.targetUrl || CONFIG.targetUrl || undefined
        : undefined;

  const task = createTask({ title, description: description || title, role, projectId: project.id, targetUrl });
  scheduler.start(task);
  res.json({ task });
});

const EVENTS_MAX = 2000;

function positiveInt(raw: unknown): number | undefined {
  const value = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Detail tugas. `?events=N` membatasi jumlah event (0 = hanya metadata, untuk refresh header
 * tanpa menarik transcript), `?before=seq` mengambil jendela yang lebih lama.
 */
tasksRouter.get("/tasks/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  const limit = Math.min(positiveInt(req.query.events) ?? EVENTS_MAX, EVENTS_MAX);
  const before = positiveInt(req.query.before);
  const window = threads.window(task.id, { limit, before: before && before > 0 ? before : undefined });
  const runner = scheduler.getRunner(task.id);
  const project = getProject(task.projectId);
  res.json({
    task,
    project: project
      ? { id: project.id, name: project.name, workspaceDir: workspaceForProject(project.id) }
      : undefined,
    events: window.events,
    eventsHasMore: window.hasMore,
    openRequests: runner?.openRequests() ?? [],
    runnerStatus: runner?.status ?? "idle",
    assets: listAssets(task.id),
    docs: listDocs(task.id),
    report: readReport(task.id) ?? null,
    hasNotes: hasNotes(task.id),
    live: live.state(task.id),
    mode: task.mode ?? defaultModeFor(task.role),
  });
});

const MODES: AutonomyMode[] = ["auto", "ask", "readonly"];

tasksRouter.post("/tasks/:id/mode", async (req, res) => {
  const mode = typeof req.body?.mode === "string" ? (req.body.mode as AutonomyMode) : undefined;
  if (!mode || !MODES.includes(mode)) {
    res.status(400).json({ error: "mode tidak dikenal" });
    return;
  }
  const task = await scheduler.setMode(req.params.id, mode);
  if (!task) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ ok: true, task });
});

/**
 * Catatan pribadi satu tugas. Hanya pemilik produk yang menulis dan membacanya —
 * isinya tidak pernah masuk ke konteks agen (lihat deny rule di roles.ts).
 */
tasksRouter.get("/tasks/:id/notes", (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ text: readNotes(req.params.id) });
});

tasksRouter.put("/tasks/:id/notes", (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  if (typeof req.body?.text !== "string") {
    res.status(400).json({ error: "text wajib diisi" });
    return;
  }
  res.json({ text: writeNotes(req.params.id, req.body.text) });
});

/** Ganti nama tugas. Judul hanya metadata, jadi boleh diubah walau tugasnya sedang dikerjakan. */
tasksRouter.post("/tasks/:id/title", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 140) : "";
  if (!title) {
    res.status(400).json({ error: "nama tugas tidak boleh kosong" });
    return;
  }
  const task = updateTask(req.params.id, { title });
  if (!task) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ ok: true, task });
});

/** Pindahkan tugas ke project lain; konteks yang dibaca bot ikut berganti di turn berikutnya. */
tasksRouter.post("/tasks/:id/project", (req, res) => {
  const project = getProject(typeof req.body?.projectId === "string" ? req.body.projectId : "");
  if (!project) {
    res.status(400).json({ error: "project tujuan tidak dikenal" });
    return;
  }
  const task = updateTask(req.params.id, { projectId: project.id });
  if (!task) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ ok: true, task });
});

/** Satu aliran untuk seluruh aplikasi: dipakai notifikasi browser. */
tasksRouter.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const unsubscribe = bus.subscribeAll((event: AttentionEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`));
  // Daftar tugas berubah → klien memuat ulang daftar, bukan polling tiap 3 detik.
  // Dinamai `event:` supaya tidak masuk onmessage notifikasi.
  let pending: NodeJS.Timeout | undefined;
  const unsubscribeTasks = onTasksChanged(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      res.write("event: tasks_changed\ndata: {}\n\n");
    }, 300);
  });
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    if (pending) clearTimeout(pending);
    unsubscribe();
    unsubscribeTasks();
  });
});

tasksRouter.get("/tasks/:id/live/status", (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ ...live.state(req.params.id), hasFrame: Boolean(live.lastFrame(req.params.id)) });
});

/** Aliran MJPEG: bisa langsung dipasang di <img src>, tanpa dekoder di sisi klien. */
tasksRouter.get("/tasks/:id/live", (req, res) => {
  const task = getTask(req.params.id);
  if (!task || (!live.state(task.id).active && !live.lastFrame(task.id))) {
    res.status(404).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "Cache-Control": "no-store, no-transform",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const unsubscribe = live.subscribe(task.id, res);
  live.sendLastFrame(task.id, res);
  // Kirim ulang frame terakhir secara berkala supaya koneksi tidak dianggap mati
  // saat halaman yang diuji sedang diam (screencast hanya mengirim saat repaint).
  const heartbeat = setInterval(() => live.sendLastFrame(task.id, res), 10_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

tasksRouter.get("/tasks/:id/events", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  // `id:` hanya untuk event yang tersimpan: browser mengirimnya balik sebagai Last-Event-ID
  // saat menyambung ulang, dan event ephemeral (delta/status) tidak bisa di-replay.
  const push = (event: StoredEvent | Record<string, unknown>) => {
    const seq = typeof event.seq === "number" ? event.seq : 0;
    const persisted = seq > 0 && !EPHEMERAL_EVENTS.has(String(event.type));
    res.write(`${persisted ? `id: ${seq}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
  };
  const runner = scheduler.getRunner(task.id);
  push({ type: "status", status: runner?.status ?? "idle", seq: 0, ts: new Date().toISOString(), taskId: task.id });
  for (const request of runner?.openRequests() ?? []) {
    push({ ...request, seq: 0, ts: new Date().toISOString(), taskId: task.id, role: task.role });
  }

  // Replay event yang terlewat sejak `after` (atau Last-Event-ID), lalu langsung berlangganan —
  // keduanya sinkron berurutan, jadi tidak ada celah maupun duplikat.
  const after = positiveInt(req.query.after) ?? positiveInt(req.get("last-event-id"));
  if (after !== undefined) for (const event of threads.readAfter(task.id, after)) push(event);

  const unsubscribe = bus.subscribe(task.id, push);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

tasksRouter.post("/tasks/:id/message", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "text wajib diisi" });
    return;
  }
  if (!scheduler.send(req.params.id, text)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ ok: true });
});

tasksRouter.post("/tasks/:id/interrupt", async (req, res) => {
  await scheduler.interrupt(req.params.id);
  res.json({ ok: true, task: getTask(req.params.id) });
});

tasksRouter.post("/tasks/:id/cancel", async (req, res) => {
  await scheduler.cancel(req.params.id);
  res.json({ ok: true, task: getTask(req.params.id) });
});

tasksRouter.post("/tasks/:id/handoff", async (req, res) => {
  const role = typeof req.body?.role === "string" ? req.body.role : "";
  if (!isRoleId(role)) {
    res.status(400).json({ error: "bot tujuan tidak dikenal" });
    return;
  }
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : undefined;
  const task = await scheduler.handoff(req.params.id, role, note);
  if (!task) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ ok: true, task });
});

tasksRouter.post("/tasks/:id/review", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  const status = req.body?.status === "approved" ? "approved" : "changes_requested";
  const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
  const sendBack = req.body?.sendBackToAgent !== false;

  if (status === "changes_requested" && !comment) {
    res.status(400).json({ error: "komentar wajib diisi kalau meminta perbaikan" });
    return;
  }

  const review = { status, comment, reviewedAt: new Date().toISOString() } as const;
  updateTask(task.id, {
    review,
    status: status === "approved" ? "done" : task.status,
    finishedAt: status === "approved" ? new Date().toISOString() : task.finishedAt,
  });

  if (status === "changes_requested" && sendBack) scheduler.sendReview(task.id, comment);
  // Tugas yang di-approve masuk report project; kurator menautkannya ke register.
  if (status === "approved") curator.schedule(task.projectId);
  res.json({ ok: true, task: getTask(task.id) });
});

/** Hanya teks report.md — dipakai baris rekap project yang dibentang, tanpa ikut menarik transcript. */
tasksRouter.get("/tasks/:id/report", (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ text: readReport(req.params.id) ?? null });
});

/** Teks lampiran dipotong di sini supaya tab tetap enteng kalau agen menulis log besar. */
const DOC_TEXT_LIMIT = 512 * 1024;

/** Lampiran hanya dilayani kalau namanya memang ada di daftar listDocs() tugas itu. */
function docFor(id: string, raw: unknown): { path: string; abs: string } | undefined {
  if (!getTask(id) || typeof raw !== "string" || !raw) return undefined;
  const abs = resolveDoc(id, raw);
  return abs ? { path: raw, abs } : undefined;
}

tasksRouter.get("/tasks/:id/doc", (req, res) => {
  const found = docFor(req.params.id, req.query.path);
  if (!found) {
    res.status(404).json({ error: "lampiran tidak ditemukan" });
    return;
  }
  const stat = statSync(found.abs);
  const buffer = readFileSync(found.abs);
  const meta = { path: found.path, size: stat.size, mtime: stat.mtime.toISOString() };
  if (buffer.subarray(0, 8192).includes(0)) {
    res.json({ ...meta, binary: true });
    return;
  }
  res.json({
    ...meta,
    text: buffer.subarray(0, DOC_TEXT_LIMIT).toString("utf8"),
    truncated: buffer.byteLength > DOC_TEXT_LIMIT,
  });
});

tasksRouter.get("/tasks/:id/doc/raw", (req, res) => {
  const found = docFor(req.params.id, req.query.path);
  if (!found) {
    res.status(404).end();
    return;
  }
  res.download(found.abs, basename(found.path));
});

tasksRouter.get("/tasks/:id/assets/:file", (req, res) => {
  const task = getTask(req.params.id);
  // basename() mencegah path traversal lewat nama file.
  const file = basename(req.params.file);
  if (!task || !listAssets(task.id).includes(file)) {
    res.status(404).end();
    return;
  }
  const path = join(assetsDir(task.id), file);
  if (!existsSync(path)) {
    res.status(404).end();
    return;
  }
  res.sendFile(path);
});
