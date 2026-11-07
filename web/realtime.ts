/**
 * Satu WebSocket per tab untuk seluruh aplikasi (pengganti SSE dan polling). Protokolnya
 * dijelaskan di server/realtime.ts.
 *
 * Dibuka saat langganan pertama dan menyambung ulang sendiri (backoff 0,5 → 10 detik + jitter).
 * Setiap kali tersambung, semua langganan dikirim ulang dengan `after()` terbaru milik masing-masing
 * pelanggan, jadi server me-replay event yang terlewat.
 */

export type SubscribeOptions = {
  /** Seq tersimpan terakhir yang sudah dimiliki; server me-replay sesudahnya. Dibaca tiap kali (ulang) berlangganan. */
  after?: () => number | undefined;
  /** Langganan terpasang di server (juga setelah tersambung ulang). Snapshot HTTP yang diambil sesudah ini tidak berceleh. */
  onReady?: () => void;
  /** Topik ditolak server (mis. tugas tidak ada). */
  onError?: (message: string) => void;
};

type Subscription = SubscribeOptions & { sid: number; topic: string; onEvent: (event: never) => void };

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 10_000;
/** Server mengirim `hb` tiap 25 detik; selama ini tanpa pesan apa pun = sambungan mati diam-diam. */
const SILENCE_MS = 60_000;

const subscriptions = new Map<number, Subscription>();
const connectionListeners = new Set<(connected: boolean) => void>();
let socket: WebSocket | undefined;
let open = false;
let nextSid = 1;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let silenceTimer: ReturnType<typeof setTimeout> | undefined;

function url(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`;
}

/** Dikabarkan juga saat percobaan sambung gagal (belum pernah terbuka), supaya penanda "terputus" muncul. */
function setOpen(value: boolean): void {
  open = value;
  for (const listener of connectionListeners) listener(value);
}

function write(message: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendSub(subscription: Subscription): void {
  const after = subscription.after?.();
  write({ op: "sub", sid: subscription.sid, topic: subscription.topic, ...(after !== undefined ? { after } : {}) });
}

function armSilence(ws: WebSocket): void {
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    if (socket === ws) drop(ws);
  }, SILENCE_MS);
}

/** Lepas sambungan ini (mati, diam, atau ditutup) dan jadwalkan sambungan baru. */
function drop(ws: WebSocket): void {
  if (socket !== ws) return;
  socket = undefined;
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = undefined;
  try {
    ws.close();
  } catch {
    // sudah tertutup
  }
  setOpen(false);
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (retryTimer || subscriptions.size === 0) return;
  const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt);
  attempt += 1;
  retryTimer = setTimeout(
    () => {
      retryTimer = undefined;
      connect();
    },
    base + Math.random() * base * 0.3,
  );
}

function connect(): void {
  if (socket || subscriptions.size === 0) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    attempt = 0;
    armSilence(ws);
    setOpen(true);
    for (const subscription of subscriptions.values()) sendSub(subscription);
  };
  ws.onmessage = (message) => {
    if (socket !== ws) return;
    armSilence(ws);
    let data: { sid?: number; op?: string; event?: unknown; error?: string; task?: string; ok?: boolean };
    try {
      data = JSON.parse(String(message.data)) as typeof data;
    } catch {
      return;
    }
    if (data.op === "control" && typeof data.task === "string") {
      controlWaiters.get(data.task)?.shift()?.({ ok: data.ok === true, error: data.error });
      return;
    }
    if (data.sid === undefined) return; // hb
    const subscription = subscriptions.get(data.sid);
    if (!subscription) return;
    if (data.op === "ready") subscription.onReady?.();
    else if (data.error !== undefined) subscription.onError?.(data.error);
    else if (data.event !== undefined) subscription.onEvent(data.event as never);
  };
  ws.onclose = () => drop(ws);
  ws.onerror = () => drop(ws);
}

// Kembali online atau tab terlihat lagi: jangan tunggu sisa backoff.
function reconnectNow(): void {
  if (socket || subscriptions.size === 0) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  attempt = 0;
  connect();
}
if (typeof window !== "undefined") {
  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconnectNow();
  });
}

/** Berlangganan satu topik. Hasilnya fungsi untuk berhenti. */
export function subscribe<T>(topic: string, onEvent: (event: T) => void, options: SubscribeOptions = {}): () => void {
  const subscription: Subscription = { ...options, sid: nextSid++, topic, onEvent: onEvent as (event: never) => void };
  subscriptions.set(subscription.sid, subscription);
  if (open) sendSub(subscription);
  else connect();
  return () => {
    if (!subscriptions.delete(subscription.sid)) return;
    write({ op: "unsub", sid: subscription.sid });
  };
}

export type ControlAnswer = { ok: boolean; error?: string };
const controlWaiters = new Map<string, Array<(answer: ControlAnswer) => void>>();
/** Jawaban server yang tidak datang dalam selang ini dianggap gagal (sambungan sedang bermasalah). */
const CONTROL_TIMEOUT_MS = 5_000;

/**
 * Ambil alih / serahkan browser bot sebuah tugas (tab Live). Kendali melekat ke sambungan ini:
 * kalau sambungannya putus, server mengembalikan kendali ke agen.
 */
export function requestControl(task: string, action: "take" | "release"): Promise<ControlAnswer> {
  if (!socket || !open) return Promise.resolve({ ok: false, error: "tidak tersambung ke server" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: ControlAnswer) => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    const list = controlWaiters.get(task) ?? [];
    list.push(finish);
    controlWaiters.set(task, list);
    write({ op: "control", task, action });
    setTimeout(() => {
      const waiting = controlWaiters.get(task);
      const index = waiting?.indexOf(finish) ?? -1;
      if (waiting && index >= 0) waiting.splice(index, 1);
      finish({ ok: false, error: "server tidak menjawab" });
    }, CONTROL_TIMEOUT_MS);
  });
}

/** Input owner ke browser bot; diabaikan server kalau sambungan ini tidak memegang kendali. */
export type OwnerInput =
  | { t: "move"; x: number; y: number }
  | { t: "down" | "up"; x: number; y: number; button: "left" | "right" | "middle"; clicks: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "key"; phase: "down" | "up"; key: string; ctrl?: boolean; meta?: boolean }
  | { t: "text"; text: string };

export function sendInput(task: string, input: OwnerInput): void {
  write({ op: "input", task, input });
}

/** Status sambungan, untuk penanda "terputus": `true` saat tersambung, `false` tiap kali putus atau gagal menyambung. */
export function onConnection(listener: (connected: boolean) => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

export function isConnected(): boolean {
  return open;
}
