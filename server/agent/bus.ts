import { threads } from "../store.ts";
import type { AttentionEvent, RoleId, StoredEvent, UiEvent } from "../types.ts";

/**
 * Saluran event per tugas. Hidup terpisah dari runner, supaya UI tetap bisa
 * menyimak tugas yang agennya sedang tidak berjalan (antre, idle, atau selesai).
 */
class TaskBus {
  private readonly listeners = new Map<string, Set<(event: StoredEvent) => void>>();
  private readonly watchers = new Set<(event: AttentionEvent) => void>();

  subscribe(taskId: string, listener: (event: StoredEvent) => void): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(taskId);
    };
  }

  /** Penyimak lintas tugas: dipakai notifikasi browser lewat topik `global` di WebSocket. */
  subscribeAll(listener: (event: AttentionEvent) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  /** Hal yang menunggu keputusan atau perhatian pemilik produk, dari tugas mana pun. */
  publishAttention(event: AttentionEvent): void {
    for (const watcher of this.watchers) {
      try {
        watcher(event);
      } catch {
        // satu penyimak yang error tidak boleh menjatuhkan agen
      }
    }
  }

  /** Simpan ke transcript tugas lalu siarkan ke penyimak yang sedang membuka. */
  emit(taskId: string, role: RoleId, event: UiEvent): StoredEvent {
    const stored = threads.append(taskId, role, event);
    for (const listener of this.listeners.get(taskId) ?? []) {
      try {
        listener(stored);
      } catch {
        // satu penyimak yang error tidak boleh menjatuhkan agen
      }
    }
    return stored;
  }
}

export const bus = new TaskBus();
