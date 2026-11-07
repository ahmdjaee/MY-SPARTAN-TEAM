/**
 * Uji WebSocket realtime: pagar Host/Origin, replay `after`, urutan `ready`, topik global/task/ask/project.
 * Deterministik, tanpa model dan tanpa menyentuh data asli: bun run check:realtime
 */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-realtime-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");
process.env.PORT = "4320";
process.env.ALLOWED_HOSTS = "ai-team.lan";
process.env.ALLOWED_ORIGINS = "https://tim.example";

const { ensureDirs } = await import("../server/config.ts");
ensureDirs();
const { createProject } = await import("../server/projects.ts");
const { createTask, updateTask } = await import("../server/tasks.ts");
const { bus } = await import("../server/agent/bus.ts");
const { live } = await import("../server/browser/live.ts");
const { appendInbox, upsertFinding } = await import("../server/findings.ts");
const { attachRealtime } = await import("../server/realtime.ts");
const { LOCAL_ALIAS, allowedHost, allowedOrigin, hostsMapsToLoopback, rejectReason } = await import("../server/http-guard.ts");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- pagar Host/Origin ----------
check(
  "Host lokal dan tambahan diizinkan",
  allowedHost("127.0.0.1:4320") && allowedHost("localhost") && allowedHost("[::1]:4320") && allowedHost("ai-team.lan:4320"),
);
check(
  "berkas hosts dibaca dengan benar",
  hostsMapsToLoopback("127.0.0.1 localhost\n127.0.0.1\tai-team.local # alias\n", LOCAL_ALIAS) &&
    hostsMapsToLoopback("::1 ip6-localhost ai-team.local", LOCAL_ALIAS) &&
    !hostsMapsToLoopback("# 127.0.0.1 ai-team.local\n192.168.1.5 ai-team.local\n", LOCAL_ALIAS) &&
    !hostsMapsToLoopback("127.0.0.1 ai-team.local.evil.example", LOCAL_ALIAS),
);
{
  // Mesin ini sendiri: dipercaya persis kalau /etc/hosts-nya mengarahkan alias ke loopback.
  const mapped = hostsMapsToLoopback(existsSync("/etc/hosts") ? readFileSync("/etc/hosts", "utf8") : "", LOCAL_ALIAS);
  check(
    `ai-team.local hanya dipercaya bila /etc/hosts mengarahkannya ke loopback (di sini: ${mapped ? "ya" : "tidak"})`,
    allowedHost(LOCAL_ALIAS) === mapped && allowedOrigin(`http://${LOCAL_ALIAS}`) === mapped,
  );
}
check("Host asing ditolak (DNS rebinding)", !allowedHost("evil.example:4320") && !allowedHost("127.0.0.1.evil.example"));
check(
  "Origin aplikasi diizinkan",
  allowedOrigin(undefined) &&
    allowedOrigin("http://127.0.0.1:4320") &&
    allowedOrigin("http://localhost:4321") &&
    allowedOrigin("http://ai-team.lan") &&
    allowedOrigin("https://tim.example/"),
);
check(
  "Origin asing ditolak",
  !allowedOrigin("http://evil.example") &&
    !allowedOrigin("null") &&
    !allowedOrigin("http://localhost") &&
    !allowedOrigin("http://127.0.0.1:3000") &&
    !allowedOrigin("chrome-extension://abc"),
);
check(
  "POST lintas situs ditolak, GET tanpa Origin lolos",
  rejectReason({ host: "127.0.0.1:4320", "sec-fetch-site": "cross-site" }, "POST") !== undefined &&
    rejectReason({ host: "127.0.0.1:4320" }, "GET") === undefined,
);

// ---------- server uji ----------
const project = createProject({ name: "Uji realtime" });
const other = createProject({ name: "Project lain" });
const task = createTask({ title: "uji", description: "uji", role: "qa", projectId: project.id });
const server = createServer();
const realtime = attachRealtime(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const base = `ws://127.0.0.1:${port}/api/ws`;

type Message = { sid?: number; op?: string; event?: Record<string, any>; error?: string };

async function connect(headers?: Record<string, string>) {
  const ws = new WebSocket(base, { headers } as never);
  const inbox: Message[] = [];
  ws.onmessage = (message) => inbox.push(JSON.parse(String(message.data)) as Message);
  const opened = await new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
  const of = (sid: number) => inbox.filter((message) => message.sid === sid);
  return {
    ws,
    opened,
    inbox,
    of,
    events: (sid: number) => of(sid).filter((message) => message.event).map((message) => message.event!),
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    until: async (predicate: () => boolean, ms = 2_000) => {
      const end = Date.now() + ms;
      while (!predicate() && Date.now() < end) await wait(5);
      return predicate();
    },
  };
}

{
  const evil = await connect({ Origin: "http://evil.example" });
  check("WebSocket dari Origin asing ditolak (CSWSH)", !evil.opened);
  const rebinding = await connect({ Host: `evil.example:${port}` });
  check("WebSocket dengan Host asing ditolak", !rebinding.opened);
}

const client = await connect({ Origin: "http://127.0.0.1:4320" });
check("WebSocket dari Origin aplikasi tersambung", client.opened);

// ---------- task: replay setelah `after`, lalu live, tanpa duplikat ----------
{
  const first = bus.emit(task.id, "qa", { type: "notice", text: "satu" });
  bus.emit(task.id, "qa", { type: "delta", kind: "text", text: "sementara" }); // ephemeral: tidak tersimpan
  const second = bus.emit(task.id, "qa", { type: "notice", text: "dua" });
  bus.emit(task.id, "qa", { type: "notice", text: "tiga" });

  client.send({ op: "sub", sid: 1, topic: `task:${task.id}`, after: first.seq });
  await client.until(() => client.of(1).some((message) => message.op === "ready"));
  const beforeReady = client.of(1).slice(0, client.of(1).findIndex((message) => message.op === "ready"));
  const kinds = beforeReady.map((message) => message.event?.type);
  check("task: status dan live dikirim dulu", kinds[0] === "status" && kinds.includes("live"), kinds);
  const replayed = beforeReady.filter((message) => message.event?.type === "notice").map((message) => message.event!.text);
  check("task: replay hanya event sesudah `after`", JSON.stringify(replayed) === '["dua","tiga"]', replayed);
  check("task: event ephemeral tidak ikut di-replay", !kinds.includes("delta"), kinds);

  bus.emit(task.id, "qa", { type: "notice", text: "empat" });
  bus.emit(task.id, "qa", { type: "delta", kind: "text", text: "live" });
  await client.until(() => client.events(1).some((event) => event.type === "delta"));
  const notices = client
    .events(1)
    .filter((event) => event.type === "notice")
    .map((event) => event.seq);
  check("task: live setelah replay, tanpa duplikat", new Set(notices).size === notices.length && notices.length === 3, notices);
  check("task: delta live tetap sampai", client.events(1).some((event) => event.type === "delta" && event.text === "live"));
  check("task: seq tetap naik", notices.every((seq, index) => index === 0 || seq > notices[index - 1]!) && notices[0]! > second.seq - 1);

  // live.watch: hanya perubahan tampilan, bukan tiap frame.
  live.setState(task.id, { active: true, url: "http://demo/a" });
  live.setState(task.id, { active: true, url: "http://demo/a", lastFrameAt: Date.now() });
  live.setState(task.id, { url: "http://demo/b" });
  await client.until(() => client.events(1).filter((event) => event.type === "live").length >= 3);
  const views = client.events(1).filter((event) => event.type === "live").map((event) => event.url ?? "-");
  check("task: event live hanya saat tampilan berubah", JSON.stringify(views) === '["-","http://demo/a","http://demo/b"]', views);

  // task.json ditulis → task_changed (digabung).
  updateTask(task.id, { title: "uji 2" });
  updateTask(task.id, { title: "uji 3" });
  await wait(450);
  const changed = client.events(1).filter((event) => event.type === "task_changed").length;
  check("task: perubahan task.json digabung jadi satu task_changed", changed === 1, changed);

  client.send({ op: "unsub", sid: 1 });
  await wait(30);
  const count = client.of(1).length;
  bus.emit(task.id, "qa", { type: "notice", text: "lima" });
  await wait(50);
  check("task: unsub menghentikan aliran", client.of(1).length === count);
}

{
  client.send({ op: "sub", sid: 2, topic: "task:T-999" });
  await client.until(() => client.of(2).length > 0);
  check("task: tugas tak dikenal → error, bukan ready", client.of(2)[0]?.error !== undefined && !client.of(2).some((m) => m.op === "ready"));
  client.send({ op: "sub", sid: 3, topic: "task:../../etc" });
  client.send("bukan json");
  await wait(50);
  check("pesan tidak sah diabaikan", client.of(3).length === 0 && client.ws.readyState === WebSocket.OPEN);
}

// ---------- global: attention + tasks_changed digabung ----------
{
  client.send({ op: "sub", sid: 4, topic: "global" });
  await client.until(() => client.of(4).some((message) => message.op === "ready"));
  bus.publishAttention({ kind: "approval", taskId: task.id, role: "qa", title: "izin", at: new Date().toISOString() });
  updateTask(task.id, { title: "a" });
  updateTask(task.id, { title: "b" });
  updateTask(task.id, { title: "c" });
  await wait(450);
  const events = client.events(4);
  check("global: attention diteruskan", events.some((event) => event.type === "attention" && event.attention.title === "izin"));
  check(
    "global: tiga penulisan tugas → satu tasks_changed",
    events.filter((event) => event.type === "tasks_changed").length === 1,
    events.map((event) => event.type),
  );
  // Browser bot berhenti/mulai (titik "● live" di daftar) juga memicu tasks_changed.
  live.setState(task.id, { active: false });
  await wait(450);
  live.setState(task.id, { url: "http://demo/c" }); // bukan perubahan aktif
  await wait(450);
  check(
    "global: sesi browser berhenti → tasks_changed, ganti URL tidak",
    client.events(4).filter((event) => event.type === "tasks_changed").length === 2,
    client.events(4).map((event) => event.type),
  );
}

// ---------- project: temuan & kotak masuk → project_changed; tugas → project_tasks_changed ----------
{
  client.send({ op: "sub", sid: 5, topic: `project:${project.id}` });
  await client.until(() => client.of(5).some((message) => message.op === "ready"));
  upsertFinding(project.id, { title: "Tombol simpan mati", severity: "major", taskId: task.id } as never, "uji");
  appendInbox(project.id, task.id, "catatan");
  appendInbox(other.id, task.id, "project lain");
  await wait(450);
  let events = client.events(5).map((event) => event.type);
  check("project: perubahan temuan → satu project_changed", events.filter((type) => type === "project_changed").length === 1, events);
  updateTask(task.id, { title: "d" });
  await wait(450);
  events = client.events(5).map((event) => event.type);
  check("project: tugas di project bergerak → project_tasks_changed", events.includes("project_tasks_changed"), events);
  const otherTask = createTask({ title: "lain", description: "lain", role: "qa", projectId: other.id });
  updateTask(otherTask.id, { title: "lain 2" });
  await wait(450);
  check(
    "project: project lain tidak ikut",
    client.events(5).filter((event) => event.type === "project_tasks_changed").length === 1,
    client.events(5).map((event) => event.type),
  );
}

// ---------- ask: snapshot dulu ----------
{
  client.send({ op: "sub", sid: 6, topic: `ask:${task.id}` });
  await client.until(() => client.of(6).some((message) => message.op === "ready"));
  const first = client.of(6)[0]?.event;
  check(
    "ask: diawali snapshot berisi model",
    first?.type === "snapshot" && Array.isArray(first.messages) && first.models?.length === 2,
    first,
  );
}

// ---------- shutdown ----------
{
  const closed = new Promise<number>((resolve) => (client.ws.onclose = (event) => resolve(event.code)));
  realtime.close();
  const code = await Promise.race([closed, wait(1_000).then(() => -1)]);
  check("shutdown menutup klien dengan 1001", code === 1001, code);
  await wait(30);
  check("langganan dibersihkan saat klien tutup", realtime.clientCount() === 0, realtime.clientCount());
}

server.close();
rmSync(sandbox, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} pengujian gagal`);
  process.exit(1);
}
console.log("Semua pengujian lulus.");
process.exit(0);
