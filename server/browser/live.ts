export type LiveState = {
  active: boolean;
  url?: string;
  title?: string;
  lastFrameAt?: number;
};

/** Cukup `write`/`end` — di praktiknya ini objek Response milik Express. */
type Viewer = { write(chunk: string | Buffer): boolean; end(): void };

/** Maksimal ±10 fps; burst repaint tidak perlu diteruskan semuanya. */
const THROTTLE_MS = 100;
/** Frame terakhir disimpan untuk beberapa tugas saja supaya memori tidak menumpuk. */
const MAX_CACHED_FRAMES = 20;

export const BOUNDARY = "frame";

/**
 * Menampung frame screencast per tugas dan menyiarkannya ke penonton.
 * Hidup terpisah dari sesi browser, jadi UI tetap bisa menyambung sebelum
 * frame pertama datang dan tetap melihat frame terakhir setelah sesi berhenti.
 */
class LiveHub {
  private readonly frames = new Map<string, Buffer>();
  private readonly states = new Map<string, LiveState>();
  private readonly viewers = new Map<string, Set<Viewer>>();
  private readonly lastPublish = new Map<string, number>();

  publishFrame(taskId: string, jpeg: Buffer): void {
    const now = Date.now();
    if (now - (this.lastPublish.get(taskId) ?? 0) < THROTTLE_MS) return;
    this.lastPublish.set(taskId, now);

    // Hapus dulu supaya urutan Map (dipakai sebagai LRU) ikut diperbarui.
    this.frames.delete(taskId);
    this.frames.set(taskId, jpeg);
    this.trimCache(taskId);
    this.setState(taskId, { active: true, lastFrameAt: now });

    for (const viewer of this.viewers.get(taskId) ?? []) this.write(viewer, jpeg);
  }

  private trimCache(keep: string): void {
    for (const key of this.frames.keys()) {
      if (this.frames.size <= MAX_CACHED_FRAMES) break;
      if (key === keep) continue;
      this.frames.delete(key);
    }
  }

  private write(viewer: Viewer, jpeg: Buffer): void {
    try {
      viewer.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      viewer.write(jpeg);
      viewer.write("\r\n");
    } catch {
      // penonton sudah pergi; dibersihkan lewat req.on("close")
    }
  }

  sendLastFrame(taskId: string, viewer: Viewer): void {
    const frame = this.frames.get(taskId);
    if (frame) this.write(viewer, frame);
  }

  lastFrame(taskId: string): Buffer | undefined {
    return this.frames.get(taskId);
  }

  setState(taskId: string, patch: Partial<LiveState>): void {
    this.states.set(taskId, { ...(this.states.get(taskId) ?? { active: false }), ...patch });
  }

  state(taskId: string): LiveState {
    return this.states.get(taskId) ?? { active: false };
  }

  subscribe(taskId: string, viewer: Viewer): () => void {
    let set = this.viewers.get(taskId);
    if (!set) {
      set = new Set();
      this.viewers.set(taskId, set);
    }
    set.add(viewer);
    return () => {
      set.delete(viewer);
      if (set.size === 0) this.viewers.delete(taskId);
    };
  }

  viewerCount(taskId: string): number {
    return this.viewers.get(taskId)?.size ?? 0;
  }

  /** Sesi browser berhenti: tandai tidak aktif, tapi biarkan frame terakhir membeku di layar. */
  stop(taskId: string): void {
    this.setState(taskId, { active: false });
    this.lastPublish.delete(taskId);
  }
}

export const live = new LiveHub();
