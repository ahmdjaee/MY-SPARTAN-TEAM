import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { EPHEMERAL_EVENTS, type RoleId, type StoredEvent, type UiEvent } from "./types.ts";

/** Transcript per tugas: data/tasks/<id>/thread.jsonl */
class ThreadStore {
  private lastSeq = new Map<string, number>();

  private path(taskId: string): string {
    return join(CONFIG.tasksDir, taskId, "thread.jsonl");
  }

  private nextSeq(taskId: string): number {
    let seq = this.lastSeq.get(taskId);
    if (seq === undefined) {
      seq = 0;
      for (const event of this.read(taskId)) seq = Math.max(seq, event.seq);
    }
    seq += 1;
    this.lastSeq.set(taskId, seq);
    return seq;
  }

  append(taskId: string, role: RoleId, event: UiEvent): StoredEvent {
    const stored = { ...event, seq: this.nextSeq(taskId), ts: new Date().toISOString(), taskId, role } as StoredEvent;
    if (EPHEMERAL_EVENTS.has(event.type)) return stored;
    const dir = join(CONFIG.tasksDir, taskId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(this.path(taskId), `${JSON.stringify(stored)}\n`);
    return stored;
  }

  read(taskId: string, limit = 2000): StoredEvent[] {
    const path = this.path(taskId);
    if (!existsSync(path)) return [];
    const events: StoredEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-limit)) {
      try {
        events.push(JSON.parse(line) as StoredEvent);
      } catch {
        // baris rusak dilewati
      }
    }
    return events;
  }
}

export const threads = new ThreadStore();
