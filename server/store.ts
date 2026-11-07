import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { EPHEMERAL_EVENTS, type RoleId, type StoredEvent, type UiEvent } from "./types.ts";

/** `dir`: folder tugas sudah pasti ada — mkdirSync tidak perlu diulang di setiap event. */
type CachedThread = { events: StoredEvent[]; bytes: number; lastSeq: number; dir: boolean };

/** Transcript yang sedang dibuka saja yang ditahan di memori; sisanya dibaca ulang saat dibutuhkan. */
const MAX_CACHED_TASKS = 6;
const MAX_CACHED_BYTES = 30 * 1024 * 1024;

export type ThreadWindow = { events: StoredEvent[]; hasMore: boolean };

/**
 * Transcript per tugas: data/tasks/<id>/thread.jsonl.
 * Berkasnya hanya di-parse sekali per masa cache (urutan Map = LRU); event baru
 * ditambahkan ke cache dan ke disk bersamaan, jadi GET detail tidak membaca ulang 3 MB.
 */
class ThreadStore {
  private readonly cache = new Map<string, CachedThread>();

  private path(taskId: string): string {
    return join(CONFIG.tasksDir, taskId, "thread.jsonl");
  }

  private load(taskId: string): CachedThread {
    const path = this.path(taskId);
    const entry: CachedThread = { events: [], bytes: 0, lastSeq: 0, dir: false };
    if (existsSync(path)) {
      entry.dir = true;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as StoredEvent;
          entry.events.push(event);
          entry.bytes += line.length;
          if (event.seq > entry.lastSeq) entry.lastSeq = event.seq;
        } catch {
          // baris rusak dilewati
        }
      }
    }
    this.cache.set(taskId, entry);
    this.evict(taskId);
    return entry;
  }

  private touch(taskId: string): CachedThread {
    const existing = this.cache.get(taskId);
    if (existing) {
      // Map.set pada kunci yang sudah ada tidak memindahkannya ke akhir — hapus dulu.
      this.cache.delete(taskId);
      this.cache.set(taskId, existing);
      return existing;
    }
    return this.load(taskId);
  }

  private evict(keep: string): void {
    let total = 0;
    for (const entry of this.cache.values()) total += entry.bytes;
    for (const key of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHED_TASKS && total <= MAX_CACHED_BYTES) break;
      if (key === keep) continue;
      total -= this.cache.get(key)?.bytes ?? 0;
      this.cache.delete(key);
    }
  }

  append(taskId: string, role: RoleId, event: UiEvent): StoredEvent {
    const cached = this.touch(taskId);
    cached.lastSeq += 1;
    const stored = { ...event, seq: cached.lastSeq, ts: new Date().toISOString(), taskId, role } as StoredEvent;
    if (EPHEMERAL_EVENTS.has(event.type)) return stored;
    const line = JSON.stringify(stored);
    cached.events.push(stored);
    cached.bytes += line.length;
    if (!cached.dir) {
      mkdirSync(join(CONFIG.tasksDir, taskId), { recursive: true });
      cached.dir = true;
    }
    appendFileSync(this.path(taskId), `${line}\n`);
    return stored;
  }

  read(taskId: string, limit = 2000): StoredEvent[] {
    return this.window(taskId, { limit }).events;
  }

  /** Jendela event terakhir (sebelum `before` kalau diisi) — untuk tampilan awal dan "Muat lebih lama". */
  window(taskId: string, options: { limit: number; before?: number }): ThreadWindow {
    const all = this.touch(taskId).events;
    let end = all.length;
    if (options.before !== undefined) {
      end = 0;
      while (end < all.length && (all[end]?.seq ?? 0) < options.before) end += 1;
    }
    const start = Math.max(0, end - Math.max(0, options.limit));
    return { events: all.slice(start, end), hasMore: start > 0 };
  }

  /** Event terakhir yang cocok, dicari mundur di seluruh transcript tanpa menyalinnya. */
  findLast(taskId: string, predicate: (event: StoredEvent) => boolean): StoredEvent | undefined {
    const all = this.touch(taskId).events;
    for (let index = all.length - 1; index >= 0; index -= 1) {
      const event = all[index]!;
      if (predicate(event)) return event;
    }
    return undefined;
  }

  /** Event setelah seq tertentu — untuk replay saat klien menyambung ulang. */
  readAfter(taskId: string, afterSeq: number): StoredEvent[] {
    const all = this.touch(taskId).events;
    let start = all.length;
    while (start > 0 && (all[start - 1]?.seq ?? 0) > afterSeq) start -= 1;
    return all.slice(start);
  }

  lastSeqOf(taskId: string): number {
    return this.touch(taskId).lastSeq;
  }
}

export const threads = new ThreadStore();
