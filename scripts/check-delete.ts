/**
 * Uji hapus tugas: isi folder hilang, rujukan di report project tetap ada dan bertanda "dihapus",
 * ID tidak dipakai ulang, dan tidak ada yang menghidupkan folder itu lagi.
 * Deterministik, tanpa model dan tanpa menyentuh data asli: bun run check:delete
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-delete-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");
process.env.CURATOR = "0";

// Pengaman: skrip ini menghapus folder tugas, jadi tidak boleh jalan di atas data sungguhan.
const { CONFIG, ensureDirs } = await import("../server/config.ts");
if (CONFIG.dataDir !== sandbox) throw new Error(`DATA_DIR tidak terpakai: ${CONFIG.dataDir}`);
ensureDirs();

const express = (await import("express")).default;
const { createProject } = await import("../server/projects.ts");
const { assetsDir, createTask, getTask, listTasks, loadTasks, reportPath, taskDir, updateTask, writeNotes } = await import(
  "../server/tasks.ts"
);
const { bus } = await import("../server/agent/bus.ts");
const { isDeleted } = await import("../server/deleted-tasks.ts");
const { readCoverage, readRegister, registerDigest, setCoverage, upsertFinding } = await import("../server/findings.ts");
const { buildProjectRecap } = await import("../server/recap.ts");
const { attachRealtime } = await import("../server/realtime.ts");
const { tasksRouter } = await import("../server/routes/tasks.ts");
const { projectsRouter } = await import("../server/routes/projects.ts");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok   " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const REPORT = `# Laporan QA — Login

- **Hasil:** LULUS DENGAN CATATAN

## Temuan
### T-1 · Tombol masuk mati di Safari · major
- **Bukti:** ![](./assets/a.png)

## Ringkasan
- **Hasil:** login lolos, satu temuan major di Safari.
`;

const app = express();
app.use(express.json());
app.use("/api", tasksRouter, projectsRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const realtime = attachRealtime(server);
const port = (server.address() as AddressInfo).port;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

/** Klien WebSocket kecil: kumpulkan event per sid. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const inbox: Array<{ sid?: number; op?: string; event?: Record<string, any>; error?: string }> = [];
  ws.onmessage = (message) => inbox.push(JSON.parse(String(message.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket gagal tersambung"));
  });
  const of = (sid: number) => inbox.filter((message) => message.sid === sid);
  return {
    ws,
    events: (sid: number) => of(sid).filter((message) => message.event).map((message) => message.event!.type as string),
    subscribe: async (sid: number, topic: string) => {
      ws.send(JSON.stringify({ op: "sub", sid, topic }));
      const end = Date.now() + 2_000;
      while (!of(sid).some((message) => message.op === "ready") && Date.now() < end) await wait(5);
    },
  };
}

try {
  const P = createProject({ name: "Proyek hapus" }).id;
  const keep = createTask({ title: "Tetap ada", description: "x", role: "qa", projectId: P });
  updateTask(keep.id, { status: "needs_review" });
  const task = createTask({ title: "Uji login", description: "uji", role: "qa", projectId: P });

  // ---------- isi folder tugas ----------
  writeFileSync(reportPath(task.id), REPORT);
  writeFileSync(join(assetsDir(task.id), "a.png"), "png");
  writeFileSync(join(taskDir(task.id), "audit.md"), "# audit");
  mkdirSync(join(taskDir(task.id), "downloads"), { recursive: true });
  writeFileSync(join(taskDir(task.id), "downloads", "laporan.xlsx"), "xlsx");
  writeNotes(task.id, "catatan pribadi");
  bus.emit(task.id, "qa", { type: "notice", text: "halo" });
  const finding = upsertFinding(
    P,
    { title: "Tombol masuk mati di Safari", severity: "major", occurrence: { taskId: task.id, localId: "T-1" } },
    "uji",
  );
  setCoverage(P, { area: "Login", subject: "admin", state: "tested", taskId: task.id }, "uji");

  // ---------- pagar ----------
  let response = await call("DELETE", `/api/tasks/${task.id}`, { confirm: task.id });
  check("tugas yang masih antre ditolak (409)", response.status === 409 && /batalkan dulu/.test(response.json?.error), response);
  check("tugas aktif tetap utuh", existsSync(reportPath(task.id)) && Boolean(getTask(task.id)));

  updateTask(task.id, { status: "cancelled" });
  response = await call("DELETE", `/api/tasks/${task.id}`, { confirm: "salah" });
  check("konfirmasi salah ditolak (400)", response.status === 400 && response.json?.error.includes(task.id), response);
  response = await call("DELETE", `/api/tasks/${task.id}`);
  check("tanpa konfirmasi ditolak (400)", response.status === 400, response);
  response = await call("DELETE", `/api/tasks/${task.id}`, { confirm: task.id.toLowerCase() });
  check("konfirmasi harus persis (huruf kecil ditolak)", response.status === 400, response);
  check("penolakan tidak menyentuh berkas", existsSync(join(assetsDir(task.id), "a.png")) && Boolean(getTask(task.id)));

  // ---------- hapus ----------
  const client = await connect();
  await client.subscribe(1, `task:${task.id}`);
  await client.subscribe(2, "global");
  await client.subscribe(3, `project:${P}`);

  response = await call("DELETE", `/api/tasks/${task.id}`, { confirm: ` ${task.id} ` });
  check("hapus berhasil, spasi di konfirmasi diabaikan", response.status === 200 && response.json?.projectId === P, response);

  check("folder tugas hilang", !existsSync(taskDir(task.id)));
  check("tidak ada sisa .deleted-*", !readdirSync(CONFIG.tasksDir).some((name) => name.startsWith(".deleted-")));
  check("tugas keluar dari indeks", getTask(task.id) === undefined && !listTasks().some((item) => item.id === task.id));
  check("tombstone tercatat", isDeleted(task.id));
  check("tugas lain di project tetap ada", Boolean(getTask(keep.id)) && existsSync(taskDir(keep.id)));

  const stored = JSON.parse(readFileSync(join(CONFIG.dataDir, "deleted-tasks.json"), "utf8")) as Array<Record<string, any>>;
  const tomb = stored.find((entry) => entry.id === task.id);
  check("tombstone menyimpan judul, project, dan status", tomb?.title === "Uji login" && tomb?.projectId === P && tomb?.status === "cancelled", tomb);
  check("tombstone menyimpan snapshot verdict", tomb?.recap?.verdict?.text === "LULUS DENGAN CATATAN", tomb?.recap);

  // ---------- realtime ----------
  await wait(450);
  check("task:<id> menerima task_deleted", client.events(1).includes("task_deleted"), client.events(1));
  check("global menerima tasks_changed", client.events(2).includes("tasks_changed"), client.events(2));
  const projectEvents = client.events(3);
  check(
    "project menerima project_tasks_changed dan project_changed",
    projectEvents.includes("project_tasks_changed") && projectEvents.includes("project_changed"),
    projectEvents,
  );
  client.ws.close();

  // ---------- HTTP sesudah hapus ----------
  response = await call("GET", `/api/tasks/${task.id}`);
  check("detail tugas yang dihapus → 410", response.status === 410 && /sudah dihapus/.test(response.json?.error), response);
  response = await call("GET", `/api/tasks/${task.id}/assets/a.png`);
  check("screenshot tidak bisa diambil lagi (404)", response.status === 404, response.status);
  response = await call("GET", `/api/tasks/${task.id}/report`);
  check("report.md tidak bisa diambil lagi (404)", response.status === 404, response.status);
  response = await call("DELETE", `/api/tasks/${task.id}`, { confirm: task.id });
  check("hapus kedua kali → 404", response.status === 404, response.status);
  response = await call("GET", "/api/tasks");
  check("daftar tugas tidak memuatnya", !response.json?.tasks.some((item: { id: string }) => item.id === task.id), response.json);

  // ---------- report project ----------
  const occurrence = readRegister(P).findings.find((item) => item.id === finding.id)?.occurrences[0];
  check("register tetap merujuk tugas itu", occurrence?.taskId === task.id, occurrence);
  check("cakupan tetap merujuk tugas itu", readCoverage(P)[0]?.taskId === task.id, readCoverage(P));

  const recap = buildProjectRecap(P, { fresh: true });
  const row = recap.deleted[0];
  check("rekap: tugas dihapus tidak ada di entries", !recap.entries.some((entry) => entry.taskId === task.id));
  check(
    "rekap: baris dihapus memuat snapshot",
    row?.taskId === task.id && row.verdict?.text === "LULUS DENGAN CATATAN" && Boolean(row.deletedAt) && row.findings.length === 1,
    row,
  );
  check("rekap: ringkasan terakhir ikut tersimpan", Boolean(row?.summary?.includes("Safari")), row?.summary);
  check("rekap: totals hanya menghitung tugas yang ada", recap.totals.reports === 0, recap.totals);

  response = await call("GET", `/api/projects/${P}/report`);
  check("report project: deletedTasks memuat tugas itu", response.json?.deletedTasks?.[task.id]?.title === "Uji login", response.json?.deletedTasks);
  check("report project: tugas lain tidak ditandai", response.json?.deletedTasks?.[keep.id] === undefined);
  check("report project: recap.deleted ikut", response.json?.recap?.deleted?.length === 1);
  check("report project: tidak ada temuan unlinked dari tugas dihapus", !response.json?.unlinked.some((item: { taskId: string }) => item.taskId === task.id));

  response = await call("GET", `/api/projects/${P}/report.md`);
  check("unduhan: rujukan bertanda (dihapus)", response.text.includes(`\`${task.id}\` (dihapus)`), response.text);
  check("unduhan: baris lampiran bertanda dihapus", response.text.includes("**Dihapus:**") && response.text.includes("lampiran tidak tersedia"));
  check("digest register untuk agen bertanda (dihapus)", registerDigest(P).includes(`${task.id} (dihapus)`), registerDigest(P));

  // ---------- tidak ada yang menghidupkan foldernya lagi ----------
  bus.emit(task.id, "qa", { type: "notice", text: "terlambat" });
  check("event terlambat tidak membuat ulang folder", !existsSync(taskDir(task.id)));
  check("updateTask pada tugas dihapus tidak menulis apa pun", updateTask(task.id, { title: "x" }) === undefined && !existsSync(taskDir(task.id)));
  response = await call("PUT", `/api/tasks/${task.id}/notes`, { text: "x" });
  check("catatan tidak bisa ditulis lagi", response.status === 404 && !existsSync(taskDir(task.id)), response.status);

  // ---------- ID tidak dipakai ulang ----------
  writeFileSync(CONFIG.counterPath, "{rusak");
  const fresh = createTask({ title: "Baru", description: "x", role: "qa", projectId: P });
  check("counter rusak: ID tugas dihapus dilewati", fresh.id !== task.id && fresh.id !== keep.id, { fresh: fresh.id, deleted: task.id });
  const next = createTask({ title: "Baru lagi", description: "x", role: "qa", projectId: P });
  check("counter normal: ID terus naik", next.id !== task.id && next.id > fresh.id, next.id);

  // ---------- start ulang: tuntaskan penghapusan yang terputus ----------
  const leftover = join(CONFIG.tasksDir, `.deleted-T-900-${Date.now()}`);
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, "task.json"), JSON.stringify({ ...getTask(keep.id), id: "T-900" }));
  mkdirSync(taskDir(task.id), { recursive: true });
  writeFileSync(join(taskDir(task.id), "task.json"), JSON.stringify({ ...getTask(keep.id), id: task.id }));
  loadTasks();
  check("loadTasks tidak menghidupkan tugas yang dihapus", getTask(task.id) === undefined && getTask("T-900") === undefined);
  check("loadTasks membersihkan sisa folder", !existsSync(leftover) && !existsSync(taskDir(task.id)));
  check("loadTasks tetap memuat tugas lain", Boolean(getTask(keep.id)) && Boolean(getTask(fresh.id)));
} finally {
  realtime.close();
  server.close();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} GAGAL` : "\nsemua lolos");
process.exit(failed ? 1 : 0);
