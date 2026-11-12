/**
 * Satu WebSocket per tab browser, pengganti SSE dan polling.
 *
 * Klien → server:  {op:"sub", sid, topic, after?} · {op:"unsub", sid}
 *                  {op:"control", task, action:"take"|"release"} · {op:"input", task, input}
 * Server → klien:  {sid, event} · {sid, op:"ready"} · {sid, error} · {op:"hb"}
 *                  {op:"control", task, ok, error?}
 *
 * `sid` dipilih klien per langganan, jadi dua komponen boleh menyimak topik yang sama dengan
 * `after` berbeda. `ready` dikirim setelah langganan terpasang (dan replay selesai): klien yang
 * mengambil snapshot HTTP sesudah `ready` dijamin tidak kehilangan event di antaranya.
 *
 * Topik:
 * - `global`        attention (notifikasi browser) + `tasks_changed`
 * - `task:<id>`     status & permintaan terbuka, `live`, replay setelah `after`, event bus, `task_changed`,
 *                   `task_deleted` (tugasnya baru saja dihapus)
 * - `ask:<id>`      `snapshot` panel Tanya, lalu delta/answer/busy/error
 * - `project:<id>`  `project_changed` (temuan/kurator) dan `project_tasks_changed`
 * - `live:<id>`     `browser_action` — aksi agen untuk overlay tab Live (hanya selama tab itu terbuka)
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { ASK_MODELS, askHub } from "./agent/ask.ts";
import { bus } from "./agent/bus.ts";
import { scheduler } from "./agent/scheduler.ts";
import { control } from "./browser/control.ts";
import { live } from "./browser/live.ts";
import { browserActiveFor, ownerInput } from "./browser/mcp.ts";
import { onProjectChanged } from "./changes.ts";
import { rejectReason } from "./http-guard.ts";
import { getProject } from "./projects.ts";
import { threads } from "./store.ts";
import { getTask, onTaskRemoved, onTasksChanged } from "./tasks.ts";

export const REALTIME_PATH = "/api/ws";

const MAX_PAYLOAD = 64 * 1024;
const MAX_SUBS = 64;
const HEARTBEAT_MS = 25_000;
/** Ledakan perubahan (mis. kurator menulis 20 temuan) cukup satu pemberitahuan. */
const DEBOUNCE_MS = 300;
/** Di atas ini delta (token streaming) dilewati — teks lengkapnya tetap datang lewat event `assistant`. */
const SOFT_BUFFER = 4 * 1024 * 1024;
/** Klien selambat ini diputus; ia menyambung ulang dengan `after`, jadi event tersimpan tidak hilang. */
const HARD_BUFFER = 16 * 1024 * 1024;
/** Tertinggal lebih jauh dari ini: klien disuruh memuat ulang jendela, bukan dibanjiri replay. */
const REPLAY_MAX = 1_000;

const ID = "[A-Za-z0-9_-]{1,64}";
const TOPIC = new RegExp(`^(global|task:${ID}|ask:${ID}|project:${ID}|live:${ID})$`);
const Sid = z.number().int().min(1).max(1e9);
const TaskId = z.string().regex(new RegExp(`^${ID}$`));
/** Koordinat viewport dari UI; dijepit lagi ke ukuran viewport di sisi browser. */
const Coord = z.number().finite().min(-100_000).max(100_000);
const Button = z.enum(["left", "right", "middle"]);
const Clicks = z.number().int().min(1).max(3);
const Delta = z.number().finite().min(-10_000).max(10_000);
const OwnerInputSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("move"), x: Coord, y: Coord }),
  z.object({ t: z.literal("down"), x: Coord, y: Coord, button: Button, clicks: Clicks }),
  z.object({ t: z.literal("up"), x: Coord, y: Coord, button: Button, clicks: Clicks }),
  z.object({ t: z.literal("wheel"), x: Coord, y: Coord, dx: Delta, dy: Delta }),
  z.object({
    t: z.literal("key"),
    phase: z.enum(["down", "up"]),
    key: z.string().min(1).max(32),
    ctrl: z.boolean().optional(),
    meta: z.boolean().optional(),
  }),
  z.object({ t: z.literal("text"), text: z.string().min(1).max(5_000) }),
]);
const ClientMessage = z.discriminatedUnion("op", [
  z.object({ op: z.literal("sub"), sid: Sid, topic: z.string().regex(TOPIC), after: z.number().int().min(0).optional() }),
  z.object({ op: z.literal("unsub"), sid: Sid }),
  z.object({ op: z.literal("control"), task: TaskId, action: z.enum(["take", "release"]) }),
  z.object({ op: z.literal("input"), task: TaskId, input: OwnerInputSchema }),
]);
/** Batas input owner per sambungan per detik — mouse 60 Hz + ketikan cepat jauh di bawah ini. */
const MAX_INPUT_PER_SECOND = 400;

type Emit = (event: unknown, droppable?: boolean) => void;
type Client = {
  id: string;
  ws: WebSocket;
  subs: Map<number, () => void>;
  alive: boolean;
  inputWindow: number;
  inputCount: number;
};

function send(client: Client, message: unknown, droppable = false): void {
  const { ws } = client;
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > HARD_BUFFER) {
    ws.terminate();
    return;
  }
  if (droppable && ws.bufferedAmount > SOFT_BUFFER) return;
  ws.send(JSON.stringify(message));
}

/** Panggilan pertama menjadwalkan, panggilan berikutnya dalam jendela yang sama digabung. */
function coalesce(fn: () => void): { trigger: () => void; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    trigger: () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, DEBOUNCE_MS);
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function globalTopic(emit: Emit): () => void {
  const offAttention = bus.subscribeAll((attention) => emit({ type: "attention", attention }));
  const tasksChanged = coalesce(() => emit({ type: "tasks_changed" }));
  const offTasks = onTasksChanged(() => tasksChanged.trigger());
  const offRemoved = onTaskRemoved(() => tasksChanged.trigger());
  // Browser bot mulai/berhenti tidak menulis task.json, tapi daftar tugas menampilkan "● live".
  const offLive = live.onActiveChange(() => tasksChanged.trigger());
  return () => {
    offAttention();
    offTasks();
    offRemoved();
    offLive();
    tasksChanged.cancel();
  };
}

function taskTopic(taskId: string, after: number | undefined, emit: Emit): (() => void) | string {
  const task = getTask(taskId);
  if (!task) return "tugas tidak ditemukan";
  const ts = new Date().toISOString();
  const runner = scheduler.getRunner(taskId);
  emit({ type: "status", status: runner?.status ?? "idle", seq: 0, ts, taskId, role: task.role });
  for (const request of runner?.openRequests() ?? []) emit({ ...request, seq: 0, ts, taskId, role: task.role });
  emit({ type: "live", ...live.view(taskId) });

  // Replay lalu langsung berlangganan — keduanya sinkron berurutan, jadi tanpa celah dan tanpa duplikat.
  if (after !== undefined) {
    const missed = threads.readAfter(taskId, after);
    if (missed.length > REPLAY_MAX) emit({ type: "resync" });
    else for (const event of missed) emit(event);
  }
  const offBus = bus.subscribe(taskId, (event) => emit(event, event.type === "delta"));
  const offLive = live.watch(taskId, (view) => emit({ type: "live", ...view }));
  // Header (status tugas, biaya, lampiran) disegarkan klien saat task.json tugas ini ditulis.
  const taskChanged = coalesce(() => emit({ type: "task_changed" }));
  const offTask = onTasksChanged((changed) => {
    if (changed.id === taskId) taskChanged.trigger();
  });
  // Tidak digabung: setelah ini tidak ada lagi task_changed yang bisa menyusul.
  const offRemoved = onTaskRemoved((removed) => {
    if (removed.id !== taskId) return;
    taskChanged.cancel();
    emit({ type: "task_deleted" });
  });
  return () => {
    offBus();
    offLive();
    offTask();
    offRemoved();
    taskChanged.cancel();
  };
}

function askTopic(taskId: string, emit: Emit): (() => void) | string {
  if (!getTask(taskId)) return "tugas tidak ditemukan";
  emit({ type: "snapshot", ...askHub.state(taskId), models: ASK_MODELS });
  return askHub.subscribe(taskId, (event) => emit(event, event.type === "delta"));
}

function projectTopic(projectId: string, emit: Emit): (() => void) | string {
  if (!getProject(projectId)) return "project tidak ditemukan";
  const data = coalesce(() => emit({ type: "project_changed" }));
  // Status tugas ikut menentukan rekap (sumber tertunda, sedang dikerjakan) — dipisah supaya
  // laporan tugas tidak ikut memuat ulang setiap tugas lain di project bergerak.
  const tasks = coalesce(() => emit({ type: "project_tasks_changed" }));
  const offData = onProjectChanged((id) => {
    if (id === projectId) data.trigger();
  });
  const offTasks = onTasksChanged((task) => {
    if (task.projectId === projectId) tasks.trigger();
  });
  const offRemoved = onTaskRemoved((task) => {
    if (task.projectId === projectId) tasks.trigger();
  });
  return () => {
    offData();
    offTasks();
    offRemoved();
    data.cancel();
    tasks.cancel();
  };
}

/** Aksi agen di browser untuk overlay Live. Boleh dibuang saat klien lambat — itu hanya animasi. */
function liveTopic(taskId: string, emit: Emit): (() => void) | string {
  if (!getTask(taskId)) return "tugas tidak ditemukan";
  return live.watchActions(taskId, (action) => emit({ type: "browser_action", ...action }, true));
}

function openTopic(topic: string, after: number | undefined, emit: Emit): (() => void) | string {
  const colon = topic.indexOf(":");
  const kind = colon < 0 ? topic : topic.slice(0, colon);
  const id = colon < 0 ? "" : topic.slice(colon + 1);
  if (kind === "global") return globalTopic(emit);
  if (kind === "task") return taskTopic(id, after, emit);
  if (kind === "ask") return askTopic(id, emit);
  if (kind === "project") return projectTopic(id, emit);
  if (kind === "live") return liveTopic(id, emit);
  return "topik tidak dikenal";
}

function text(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function onMessage(client: Client, raw: RawData, isBinary: boolean): void {
  if (isBinary) return;
  let parsed;
  try {
    parsed = ClientMessage.safeParse(JSON.parse(text(raw)));
  } catch {
    return;
  }
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.op === "control") {
    onControl(client, message.task, message.action);
    return;
  }
  if (message.op === "input") {
    onInput(client, message.task, message.input);
    return;
  }
  const previous = client.subs.get(message.sid);
  if (previous) {
    client.subs.delete(message.sid);
    previous();
  }
  if (message.op === "unsub") return;

  const { sid } = message;
  if (client.subs.size >= MAX_SUBS) {
    send(client, { sid, error: "terlalu banyak langganan di satu sambungan" });
    return;
  }
  const emit: Emit = (event, droppable) => send(client, { sid, event }, droppable);
  let result: (() => void) | string;
  try {
    result = openTopic(message.topic, message.after, emit);
  } catch (error) {
    result = error instanceof Error ? error.message : String(error);
  }
  if (typeof result === "string") {
    send(client, { sid, error: result });
    return;
  }
  client.subs.set(sid, result);
  send(client, { sid, op: "ready" });
}

/** Ambil alih / serahkan browser tugas. Hanya untuk tugas yang browsernya sedang hidup. */
function onControl(client: Client, taskId: string, action: "take" | "release"): void {
  const answer = (error?: string) => send(client, { op: "control", task: taskId, ok: !error, ...(error ? { error } : {}) });
  if (action === "release") {
    control.release(taskId, client.id);
    answer();
    return;
  }
  if (!getTask(taskId)) return answer("tugas tidak ditemukan");
  if (!browserActiveFor(taskId)) return answer("browser bot sedang tidak berjalan");
  control.take(taskId, client.id);
  answer();
}

/** Input owner hanya diteruskan dari sambungan yang memegang kendali tugas itu. */
function onInput(client: Client, taskId: string, input: z.infer<typeof OwnerInputSchema>): void {
  if (control.holderOf(taskId) !== client.id) return;
  const now = Date.now();
  if (now - client.inputWindow >= 1_000) {
    client.inputWindow = now;
    client.inputCount = 0;
  }
  client.inputCount += 1;
  // Gerakan mouse boleh dibuang; tombol & ketikan tidak, supaya tidak ada key yang "nyangkut".
  if (client.inputCount > MAX_INPUT_PER_SECOND && input.t === "move") return;
  ownerInput(taskId, input);
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export type Realtime = { close: () => void; clientCount: () => number };

export function attachRealtime(server: Server): Realtime {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const clients = new Set<Client>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== REALTIME_PATH) {
      reject(socket, "404 Not Found");
      return;
    }
    // Wajib: WebSocket tidak dilindungi CORS, halaman mana pun boleh mencoba menyambung.
    if (rejectReason(req.headers)) {
      reject(socket, "403 Forbidden");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { id: randomUUID(), ws, subs: new Map(), alive: true, inputWindow: 0, inputCount: 0 };
      clients.add(client);
      ws.on("pong", () => {
        client.alive = true;
      });
      ws.on("message", (raw, isBinary) => onMessage(client, raw, isBinary));
      ws.on("close", () => {
        clients.delete(client);
        // Tab yang memegang kendali tertutup/terputus: browser kembali ke agen, agen tidak menunggu sia-sia.
        control.releaseHolder(client.id);
        for (const off of client.subs.values()) off();
        client.subs.clear();
      });
      ws.on("error", () => ws.terminate());
    });
  });

  // Ping (protokol) mendeteksi klien yang hilang; `hb` (pesan biasa) memberi tahu browser bahwa
  // servernya masih hidup — browser tidak bisa melihat ping.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        // sambungan sedang ditutup
      }
      send(client, { op: "hb" });
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close: () => {
      clearInterval(heartbeat);
      for (const client of clients) client.ws.close(1001, "server berhenti");
      wss.close();
    },
    clientCount: () => clients.size,
  };
}
