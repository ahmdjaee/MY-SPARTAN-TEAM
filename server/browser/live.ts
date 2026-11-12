export type Viewport = { width: number; height: number };

export type LiveState = {
  active: boolean;
  url?: string;
  title?: string;
  lastFrameAt?: number;
  /** Ukuran viewport halaman (px CSS) — UI memetakan koordinat aksi ke gambar Live dengan ini. */
  viewport?: Viewport;
  /** Owner sedang memegang kendali browser sejak waktu ini (ms epoch); agen menunggu. */
  controlledSince?: number;
};

/** Yang dilihat UI: berubah hanya saat sesi mulai/berhenti, pindah halaman, atau frame pertama datang. */
export type LiveView = {
  active: boolean;
  url?: string;
  title?: string;
  hasFrame: boolean;
  viewport?: Viewport;
  controlledSince?: number;
};

/** Kotak elemen dalam px CSS viewport (sama dengan getBoundingClientRect). */
export type Box = { x: number; y: number; width: number; height: number };

export type BrowserActionKind =
  | "open"
  | "click"
  | "fill"
  | "press"
  | "hover"
  | "select"
  | "scroll"
  | "upload"
  | "shot"
  | "read";

/**
 * Satu aksi agen di browser, untuk overlay tab Live (kursor, sorotan, keterangan).
 * Hanya disiarkan ke penonton yang sedang membuka Live — tidak disimpan di thread.
 */
export type BrowserAction = {
  kind: BrowserActionKind;
  /** Keterangan untuk manusia, mis. "Mengklik tombol Masuk". */
  label: string;
  box?: Box;
  /** Titik persis (tool berbasis koordinat); kursor overlay ke sini, bukan ke tengah kotak. */
  point?: { x: number; y: number };
  /** Isi yang diketik; field password selalu dimask sebelum sampai sini. */
  text?: string;
  /** Tombol keyboard untuk `press`. */
  key?: string;
  at: number;
};

/** Cukup `write` (+ `drain` bila ada) — di praktiknya ini objek Response milik Express. */
export type Viewer = {
  write(chunk: Buffer): boolean;
  writableLength?: number;
  once?(event: "drain", listener: () => void): unknown;
};

/** Penonton yang antreannya sebesar ini (jaringan lambat, tab di latar) dilewati sampai antreannya surut. */
const VIEWER_BACKLOG_BYTES = 1.5 * 1024 * 1024;
/**
 * Penonton terakhir pergi → screencast dimatikan setelah jeda ini. Jedanya batal kalau ada yang
 * menyambung lagi, jadi <img> yang dipasang ulang tidak mematikan lalu menyalakan screencast.
 */
const IDLE_GRACE_MS = 3_000;
/** Frame terakhir disimpan untuk beberapa tugas saja supaya memori tidak menumpuk. */
const MAX_CACHED_FRAMES = 20;

export const BOUNDARY = "frame";

/**
 * Header satu bagian MJPEG. Chrome baru menampilkan sebuah bagian setelah header bagian BERIKUTNYA
 * datang, karena batas bagian ditentukan boundary, bukan Content-Length. Karena itu header berikutnya
 * langsung ditulis di belakang setiap frame. Tanpanya gambar selalu tertinggal satu frame, dan keadaan
 * akhir halaman yang sudah diam baru muncul saat frame berikutnya atau heartbeat datang.
 */
const PART_HEADER = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\n`);
const PART_TAIL = Buffer.concat([Buffer.from("\r\n"), PART_HEADER]);

type ViewerSlot = { viewer: Viewer; waiting: boolean };
type DemandListener = (watched: boolean) => void;

/**
 * Menampung frame screencast per tugas dan menyiarkannya ke penonton.
 * Hidup terpisah dari sesi browser, jadi UI tetap bisa menyambung sebelum
 * frame pertama datang dan tetap melihat frame terakhir setelah sesi berhenti.
 */
export class LiveHub {
  private readonly idleGraceMs: number;
  private readonly frames = new Map<string, Buffer>();
  /** Tugas yang frame cache-nya masih sama dengan halaman sekarang (screencast menyala sejak frame itu). */
  private readonly fresh = new Set<string>();
  private readonly states = new Map<string, LiveState>();
  private readonly viewers = new Map<string, Set<ViewerSlot>>();
  private readonly demand = new Map<string, DemandListener>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly watchers = new Map<string, Set<(view: LiveView) => void>>();
  /** Kunci tampilan terakhir yang diumumkan; frame biasa (lastFrameAt) tidak memicu apa pun. */
  private readonly announced = new Map<string, string>();
  private readonly activeListeners = new Set<(taskId: string) => void>();
  private readonly actionWatchers = new Map<string, Set<(action: BrowserAction) => void>>();

  constructor(options: { idleGraceMs?: number } = {}) {
    this.idleGraceMs = options.idleGraceMs ?? IDLE_GRACE_MS;
  }

  /** Semua frame diteruskan — lajunya diatur di sumber (everyNthFrame) dan oleh antrean tiap penonton. */
  publishFrame(taskId: string, jpeg: Buffer): void {
    // Hapus dulu supaya urutan Map (dipakai sebagai LRU) ikut diperbarui.
    this.frames.delete(taskId);
    this.frames.set(taskId, jpeg);
    this.fresh.add(taskId);
    this.trimCache(taskId);
    // Tidak menyentuh `active`: frame yang masih di jalan setelah sesi ditutup tidak boleh menyalakannya lagi.
    this.setState(taskId, { lastFrameAt: Date.now() });

    for (const slot of this.viewers.get(taskId) ?? []) this.deliver(taskId, slot);
  }

  private trimCache(keep: string): void {
    for (const key of this.frames.keys()) {
      if (this.frames.size <= MAX_CACHED_FRAMES) break;
      if (key === keep) continue;
      this.frames.delete(key);
      this.fresh.delete(key);
      this.announce(key);
    }
  }

  /**
   * Frame terbaru ke satu penonton. Penonton yang antreannya penuh dilewati, lalu begitu antreannya
   * kosong (`drain`) ia menerima frame TERBARU — keadaan akhir halaman tidak pernah tertinggal.
   */
  private deliver(taskId: string, slot: ViewerSlot): void {
    if (slot.waiting) return;
    const frame = this.frames.get(taskId);
    if (!frame) return;
    const { viewer } = slot;
    if ((viewer.writableLength ?? 0) > VIEWER_BACKLOG_BYTES) {
      if (!viewer.once) return;
      slot.waiting = true;
      viewer.once("drain", () => {
        slot.waiting = false;
        if (this.viewers.get(taskId)?.has(slot)) this.deliver(taskId, slot);
      });
      return;
    }
    this.write(viewer, Buffer.concat([frame, PART_TAIL]));
  }

  private write(viewer: Viewer, chunk: Buffer): void {
    try {
      viewer.write(chunk);
    } catch {
      // penonton sudah pergi; dibersihkan lewat req.on("close")
    }
  }

  /** Heartbeat route MJPEG: kirim ulang frame terakhir supaya koneksi tetap hidup selama halaman diam. */
  sendLastFrame(taskId: string, viewer: Viewer): void {
    const frame = this.frames.get(taskId);
    if (!frame || (viewer.writableLength ?? 0) > VIEWER_BACKLOG_BYTES) return;
    this.write(viewer, Buffer.concat([frame, PART_TAIL]));
  }

  lastFrame(taskId: string): Buffer | undefined {
    return this.frames.get(taskId);
  }

  setState(taskId: string, patch: Partial<LiveState>): void {
    this.states.set(taskId, { ...(this.states.get(taskId) ?? { active: false }), ...patch });
    this.announce(taskId);
  }

  state(taskId: string): LiveState {
    return this.states.get(taskId) ?? { active: false };
  }

  view(taskId: string): LiveView {
    const state = this.state(taskId);
    return {
      active: state.active,
      url: state.url,
      title: state.title,
      hasFrame: this.frames.has(taskId),
      viewport: state.viewport,
      controlledSince: state.controlledSince,
    };
  }

  /** Penyimak aksi agen untuk overlay Live (topik WebSocket `live:<id>`). */
  watchActions(taskId: string, listener: (action: BrowserAction) => void): () => void {
    let set = this.actionWatchers.get(taskId);
    if (!set) {
      set = new Set();
      this.actionWatchers.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.actionWatchers.get(taskId) === set) this.actionWatchers.delete(taskId);
    };
  }

  /** Ada yang menyimak overlay? Kalau tidak, tool browser tidak perlu mengukur posisi elemen. */
  actionWatcherCount(taskId: string): number {
    return this.actionWatchers.get(taskId)?.size ?? 0;
  }

  publishAction(taskId: string, action: BrowserAction): void {
    for (const listener of this.actionWatchers.get(taskId) ?? []) {
      try {
        listener(action);
      } catch {
        // overlay hanya tambahan; tool browser tidak boleh ikut gagal
      }
    }
  }

  /** Perubahan tampilan live (bukan tiap frame) — dipakai WebSocket, pengganti polling /live/status. */
  watch(taskId: string, listener: (view: LiveView) => void): () => void {
    let set = this.watchers.get(taskId);
    if (!set) {
      set = new Set();
      this.watchers.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.watchers.delete(taskId);
    };
  }

  /** Sesi browser tugas mana pun mulai/berhenti — titik "● live" di daftar tugas ikut diperbarui. */
  onActiveChange(listener: (taskId: string) => void): () => void {
    this.activeListeners.add(listener);
    return () => this.activeListeners.delete(listener);
  }

  /** Dicatat walau belum ada penyimak: penyimak baru membandingkan dengan keadaan yang sebenarnya. */
  private announce(taskId: string): void {
    const view = this.view(taskId);
    const size = view.viewport ? `${view.viewport.width}x${view.viewport.height}` : "";
    const key = `${view.active}|${view.hasFrame}|${view.url ?? ""}|${view.title ?? ""}|${size}|${view.controlledSince ?? ""}`;
    const previous = this.announced.get(taskId);
    if (previous === key) return;
    this.announced.set(taskId, key);
    if ((previous?.startsWith("true|") ?? false) !== view.active) {
      for (const listener of this.activeListeners) {
        try {
          listener(taskId);
        } catch {
          // satu penyimak yang error tidak boleh menghentikan screencast
        }
      }
    }
    for (const listener of this.watchers.get(taskId) ?? []) {
      try {
        listener(view);
      } catch {
        // satu penyimak yang error tidak boleh menghentikan screencast
      }
    }
  }

  /**
   * Penonton MJPEG baru: header bagian pembuka, lalu frame cache kalau masih sama dengan halaman.
   * Frame basi (screencast sempat mati karena tak ada penonton) tidak dikirim; frame segar menyusul
   * ±25 ms setelah screencast menyala. Sesi yang sudah berhenti tetap menampilkan frame terakhirnya.
   */
  subscribe(taskId: string, viewer: Viewer): () => void {
    let set = this.viewers.get(taskId);
    if (!set) {
      set = new Set();
      this.viewers.set(taskId, set);
    }
    const slot: ViewerSlot = { viewer, waiting: false };
    set.add(slot);
    this.write(viewer, PART_HEADER);
    if (this.fresh.has(taskId) || !this.state(taskId).active) this.deliver(taskId, slot);
    if (set.size === 1) this.wanted(taskId);
    return () => {
      if (!set.delete(slot) || set.size > 0) return;
      if (this.viewers.get(taskId) === set) this.viewers.delete(taskId);
      this.scheduleIdle(taskId);
    };
  }

  viewerCount(taskId: string): number {
    return this.viewers.get(taskId)?.size ?? 0;
  }

  /**
   * Sesi browser mendaftar di sini supaya screencast hanya menyala selama ada penonton:
   * `true` seketika saat penonton pertama datang, `false` setelah jeda saat penonton terakhir pergi.
   * Satu pendaftar per tugas; fungsi pelepasnya tidak menghapus pendaftar yang datang belakangan.
   */
  onDemand(taskId: string, listener: DemandListener): () => void {
    this.demand.set(taskId, listener);
    return () => {
      if (this.demand.get(taskId) === listener) this.demand.delete(taskId);
    };
  }

  private wanted(taskId: string): void {
    const timer = this.idleTimers.get(taskId);
    if (timer) {
      // Masih dalam jeda: screencast belum dimatikan.
      clearTimeout(timer);
      this.idleTimers.delete(taskId);
      return;
    }
    this.notifyDemand(taskId, true);
  }

  private scheduleIdle(taskId: string): void {
    if (this.idleTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(taskId);
      if (this.viewerCount(taskId) > 0) return;
      this.fresh.delete(taskId);
      this.notifyDemand(taskId, false);
    }, this.idleGraceMs);
    timer.unref();
    this.idleTimers.set(taskId, timer);
  }

  private notifyDemand(taskId: string, watched: boolean): void {
    try {
      this.demand.get(taskId)?.(watched);
    } catch {
      // gagal menyalakan/mematikan screencast tidak boleh mengganggu penonton
    }
  }

  /** Sesi browser berhenti: tandai tidak aktif, tapi biarkan frame terakhir membeku di layar. */
  stop(taskId: string): void {
    this.fresh.delete(taskId);
    this.setState(taskId, { active: false });
  }

  /**
   * Tugasnya dihapus: buang frame terakhir dan statusnya. Penonton dan penyimak yang masih
   * tersambung dilepas sendiri saat kliennya pindah halaman.
   */
  forget(taskId: string): void {
    this.stop(taskId);
    this.frames.delete(taskId);
    this.states.delete(taskId);
    this.announced.delete(taskId);
    const timer = this.idleTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(taskId);
  }
}

export const live = new LiveHub();
