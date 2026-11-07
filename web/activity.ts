import type { StoredEvent, TaskStatus, WorkerStatus } from "./api.ts";

export function commandOf(input: unknown): string {
  const record = input as Record<string, unknown> | null;
  if (record && typeof record.command === "string") return record.command;
  if (record && typeof record.file_path === "string") return String(record.file_path);
  return JSON.stringify(input, null, 2);
}

/** Baris pertama perintah, cukup untuk satu baris UI. */
export function toolSummary(input: unknown): string {
  return commandOf(input).split("\n")[0]?.slice(0, 110) ?? "";
}

/** mcp__browser__screenshot → browser.screenshot */
export function toolLabel(name: string): string {
  return name.replace(/^mcp__([^_]+(?:_[^_]+)*)__/, (_match, server: string) => `${server}.`);
}

export type Activity = {
  label: string;
  /** "waiting" = bola di tangan pemilik; yang lain agen sedang jalan. */
  tone: "active" | "waiting";
  /** Waktu mulai, dari transcript supaya tetap benar setelah refresh. */
  since?: string;
};

/** Event yang menandai turn baru: tool sebelum titik ini tidak mungkin masih berjalan. */
const TURN_BOUNDARY = new Set(["result", "handoff", "init"]);

function runningTools(events: StoredEvent[]): Array<Extract<StoredEvent, { type: "tool" }>> {
  const running: Array<Extract<StoredEvent, { type: "tool" }>> = [];
  const finished = new Set<string>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (TURN_BOUNDARY.has(event.type)) break;
    if (event.type === "tool_result") finished.add(event.toolUseId);
    else if (event.type === "tool" && !finished.has(event.toolUseId)) running.push(event);
  }
  return running; // terbaru lebih dulu
}

function lastEventTime(events: StoredEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.seq > 0 && event.ts) return event.ts;
  }
  return undefined;
}

/**
 * Apa yang sedang dilakukan agen, diturunkan dari keadaan yang sudah ada. "Berpikir" sengaja bukan
 * dari thinking_delta: model bisa saja tidak mengirim isi pikirannya, dan justru jeda itu yang
 * terlihat seperti macet.
 */
export function deriveActivity(input: {
  status: WorkerStatus;
  taskStatus?: TaskStatus;
  streaming: boolean;
  events: StoredEvent[];
}): Activity | undefined {
  const { status, taskStatus, streaming, events } = input;
  const since = lastEventTime(events);

  if (status === "waiting") return { label: "Menunggu keputusan Anda", tone: "waiting", since };
  if (status === "starting") return { label: "Menyiapkan agen…", tone: "active", since };
  if (status === "idle" && taskStatus === "queued") return { label: "Mengantre giliran…", tone: "active", since };
  if (status !== "working") return undefined;

  const tools = runningTools(events);
  const newest = tools[0];
  if (newest) {
    // Perintahnya sudah terlihat di baris tool tepat di atas indikator ini.
    const others = tools.length - 1;
    return {
      label: `Menjalankan ${toolLabel(newest.name)}${others > 0 ? ` +${others} lainnya` : ""}…`,
      tone: "active",
      since: newest.ts || since,
    };
  }
  if (streaming) return { label: "Menulis jawaban…", tone: "active", since };
  return { label: "Berpikir…", tone: "active", since };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} dtk`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} mnt`;
  return `${Math.floor(minutes / 60)} jam ${minutes % 60} mnt`;
}

/** Jumlah token ringkas: 950, 12k, 620k, 1M, 1.5M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 999_500) return `${Math.round(tokens / 1_000)}k`;
  return `${Number((tokens / 1_000_000).toFixed(1))}M`;
}
