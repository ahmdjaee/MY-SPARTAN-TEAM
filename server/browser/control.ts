/**
 * Ambil alih browser bot dari tab Live.
 *
 * Selama owner memegang kendali, setiap tool browser agen MENUNGGU (bukan gagal, bukan interupsi
 * model) sampai kendali diserahkan kembali, lalu hasil tool-nya diawali ringkasan apa yang owner
 * lakukan — supaya agen tahu halaman mungkin sudah berubah.
 *
 * Privasi: isi yang owner ketik TIDAK PERNAH dicatat. Ringkasan hanya memuat jumlah karakter dan
 * nama field-nya; tidak ada yang masuk ke model, transcript, atau log selain itu.
 */

/** Batas tool agen menunggu owner; sesudahnya tool menjawab bahwa owner masih memegang browser. */
export const CONTROL_WAIT_MS = 10 * 60_000;
/** Ringkasan aksi owner dibatasi supaya tidak membanjiri konteks agen. */
const MAX_NOTES = 12;

type Held = {
  holder: string;
  since: number;
  notes: string[];
  /** Nama field → jumlah karakter yang diketik owner di sana. */
  typed: Map<string, number>;
  waiters: Set<(report: string) => void>;
};

export type WaitResult =
  /** Tidak ada yang memegang kendali: tool jalan seperti biasa. */
  | { kind: "free" }
  /** Owner sempat memegang lalu menyerahkan; `report` diselipkan di depan hasil tool. */
  | { kind: "returned"; report: string }
  /** Masih dipegang setelah batas waktu, atau penantian dibatalkan. */
  | { kind: "held"; message: string };

function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds} dtk`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m${rest}s` : `${minutes} mnt`;
}

export class ControlHub {
  private readonly held = new Map<string, Held>();
  private readonly listeners = new Set<(taskId: string, since: number | undefined) => void>();

  /** Perubahan siapa yang memegang kendali (untuk keadaan Live dan notice di thread). */
  onChange(listener: (taskId: string, since: number | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(taskId: string, since: number | undefined): void {
    for (const listener of this.listeners) {
      try {
        listener(taskId, since);
      } catch {
        // penyimak yang error tidak boleh mengunci kendali
      }
    }
  }

  isHeld(taskId: string): boolean {
    return this.held.has(taskId);
  }

  holderOf(taskId: string): string | undefined {
    return this.held.get(taskId)?.holder;
  }

  since(taskId: string): number | undefined {
    return this.held.get(taskId)?.since;
  }

  /** Ambil kendali; kalau sudah dipegang klien lain, kendali berpindah tanpa membangunkan agen. */
  take(taskId: string, holder: string): void {
    const current = this.held.get(taskId);
    if (current) {
      current.holder = holder;
      return;
    }
    const since = Date.now();
    this.held.set(taskId, { holder, since, notes: [], typed: new Map(), waiters: new Set() });
    this.changed(taskId, since);
  }

  /**
   * Serahkan kembali ke agen. `holder` (kalau diisi) harus pemegangnya sekarang, supaya tab lama
   * yang menutup diri tidak mencabut kendali yang sudah dipindah ke tab lain.
   */
  release(taskId: string, holder?: string, reason?: string): boolean {
    const current = this.held.get(taskId);
    if (!current || (holder !== undefined && current.holder !== holder)) return false;
    this.held.delete(taskId);
    const report = this.report(current, reason);
    for (const wake of current.waiters) wake(report);
    current.waiters.clear();
    this.changed(taskId, undefined);
    return true;
  }

  /** Sambungan pemegang putus: kendali kembali ke agen untuk semua tugas yang ia pegang. */
  releaseHolder(holder: string): void {
    for (const [taskId, current] of [...this.held]) {
      if (current.holder === holder) this.release(taskId, holder, "sambungan owner terputus");
    }
  }

  /** Catatan aksi owner untuk ringkasan, mis. `klik “Masuk”`. Duplikat berurutan digabung. */
  note(taskId: string, text: string): void {
    const current = this.held.get(taskId);
    if (!current) return;
    const last = current.notes.at(-1);
    const match = last?.match(/^(.*) \(×(\d+)\)$/);
    if (last === text) current.notes[current.notes.length - 1] = `${text} (×2)`;
    else if (match && match[1] === text) current.notes[current.notes.length - 1] = `${text} (×${Number(match[2]) + 1})`;
    else current.notes.push(text);
    if (current.notes.length > MAX_NOTES) current.notes.splice(0, current.notes.length - MAX_NOTES);
  }

  /** Hanya JUMLAH karakter yang dicatat — isinya tidak pernah disimpan. */
  typed(taskId: string, field: string, characters: number): void {
    const current = this.held.get(taskId);
    if (!current || characters <= 0) return;
    current.typed.set(field, (current.typed.get(field) ?? 0) + characters);
  }

  private report(held: Held, reason?: string): string {
    const parts = [...held.notes];
    for (const [field, count] of held.typed) parts.push(`mengetik ${count} karakter di ${field}`);
    const actions = parts.length > 0 ? `Aksi owner: ${parts.join("; ")}.` : "Owner tidak melakukan aksi yang tercatat.";
    return (
      `[Owner sempat mengambil alih browser selama ${duration(Date.now() - held.since)}` +
      `${reason ? ` (dikembalikan karena ${reason})` : ""}. ${actions} ` +
      "Isi ketikan owner tidak disertakan. Keadaan halaman mungkin sudah berubah — panggil `snapshot` dulu sebelum melanjutkan.]"
    );
  }

  /**
   * Dipanggil di awal setiap tool browser. Kalau owner memegang kendali, tunggu sampai diserahkan
   * kembali (paling lama `maxMs`), atau sampai `signal` dibatalkan (Stop / sesi ditutup).
   */
  async waitIfHeld(taskId: string | undefined, signal?: AbortSignal, maxMs = CONTROL_WAIT_MS): Promise<WaitResult> {
    if (!taskId) return { kind: "free" };
    const current = this.held.get(taskId);
    if (!current) return { kind: "free" };
    if (signal?.aborted) return { kind: "held", message: "Dibatalkan saat owner memegang browser." };

    return await new Promise<WaitResult>((resolve) => {
      const done = (result: WaitResult) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        current.waiters.delete(wake);
        resolve(result);
      };
      const wake = (report: string) => done({ kind: "returned", report });
      const onAbort = () => done({ kind: "held", message: "Dibatalkan saat owner memegang browser." });
      const timer = setTimeout(
        () =>
          done({
            kind: "held",
            message:
              `Owner masih memegang browser setelah ${duration(maxMs)}. Jangan memakai browser dulu: ` +
              "lanjutkan pekerjaan lain, atau tanyakan ke owner apakah ia sudah selesai.",
          }),
        maxMs,
      );
      timer.unref?.();
      current.waiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export const control = new ControlHub();

/** Input owner dari tab Live, dalam koordinat CSS viewport (sudah dipetakan di UI). */
export type OwnerInput =
  | { t: "move"; x: number; y: number }
  | { t: "down" | "up"; x: number; y: number; button: "left" | "right" | "middle"; clicks: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "key"; phase: "down" | "up"; key: string; ctrl?: boolean; meta?: boolean }
  | { t: "text"; text: string };
