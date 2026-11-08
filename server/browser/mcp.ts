import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { chromium, type Browser, type CDPSession, type Locator, type Page } from "playwright";
import { z } from "zod";
import { CONFIG } from "../config.ts";
import { bus } from "../agent/bus.ts";
import { assetsDir, getTask, taskDir } from "../tasks.ts";
import { control, type OwnerInput } from "./control.ts";
import { describeDownload, DownloadTracker } from "./downloads.ts";
import { live, type Box, type BrowserAction } from "./live.ts";
import { KINDS, kindFromName, makeTestFile, type TestFileKind } from "./files.ts";
import { DialogWatcher, formatInspect, formatScroll, inspect, readText, scroll } from "./ops.ts";
import {
  clip,
  diffSnapshots,
  focusedElement,
  formatChanges,
  formatSettle,
  isHeavy,
  NetworkTracker,
  pageOverview,
  PopupTracker,
  refName,
  scrollInfo,
  sharedRefCount,
  SETTLE_FULL,
  SETTLE_HOVER,
  SETTLE_LIGHT,
  SETTLE_OPEN,
  SETTLE_SUGGEST,
  secretSnapshot,
  takeSnapshot,
  within,
  type SettleOptions,
  type SettleResult,
  type Snapshot,
} from "./outcome.ts";
import { cleanRef, failureText, resolveTarget, TargetError, targetLabel, type TargetArgs } from "./targets.ts";

type CallResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

const ok = (text: string): CallResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): CallResult => ({ content: [{ type: "text", text: `ERROR: ${text}` }], isError: true });

function viewportLabel(page: Page): string {
  const size = page.viewportSize();
  return size ? `${size.width}×${size.height}` : "(tidak diketahui)";
}

/** Elemen target sebuah aksi, untuk overlay tab Live. */
type Target = { box: Box; name: string; secret: boolean };

/** Batas mengukur elemen untuk overlay — jauh di bawah timeout aksi supaya tool tidak terasa melambat. */
const PROBE_TIMEOUT_MS = 1_000;

/**
 * Dijalankan DI halaman (diserialisasi Playwright), jadi harus mandiri. Nilai input tidak pernah
 * dibaca: nama diambil dari aria-label, <label>, placeholder, teks, atau atribut name.
 */
function describeElement(el: Element): Target {
  const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
  const rect = el.getBoundingClientRect();
  const input = el instanceof HTMLInputElement ? el : null;
  const field = input !== null || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  const labelled = (el as HTMLInputElement).labels?.[0];
  // Teks <label> tanpa kontrol di dalamnya: label yang membungkus <select> ikut memuat semua teks
  // opsinya ("Kota Bandung Jakarta"), dan yang membungkus <textarea> memuat isinya.
  const labelText = (label: HTMLLabelElement): string => {
    const copy = label.cloneNode(true) as HTMLElement;
    for (const control of copy.querySelectorAll("input, select, textarea, button")) control.remove();
    return clean(copy.textContent);
  };
  const name =
    clean(el.getAttribute("aria-label")) ||
    (labelled ? labelText(labelled) : "") ||
    clean(el.getAttribute("placeholder")) ||
    (field ? "" : clean((el as HTMLElement).innerText)) ||
    clean(el.getAttribute("name")) ||
    clean(el.getAttribute("title")) ||
    el.tagName.toLowerCase();
  return {
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    name: name.slice(0, 60),
    secret: input?.type === "password",
  };
}

type FieldState = { value: string; secret: boolean; rich: boolean; suggest: boolean };

/** Dijalankan DI halaman: isi field setelah `fill`, untuk dibandingkan dengan yang dikirim. */
function readField(el: Element): FieldState {
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  const autocomplete = el.getAttribute("aria-autocomplete") ?? "";
  return {
    value: field ? (el as HTMLInputElement).value : ((el as HTMLElement).innerText ?? ""),
    secret: el instanceof HTMLInputElement && el.type === "password",
    rich: !field,
    suggest: el.getAttribute("role") === "combobox" || el.hasAttribute("list") || autocomplete === "list" || autocomplete === "both",
  };
}

/**
 * Catatan kalau isi field berbeda dari yang diisi — maxlength, mask, atau format otomatis diam-diam
 * mengubahnya, dan itu sering justru yang sedang diuji. Isi field password tidak pernah ditulis.
 */
function fillNote(sent: string, field: FieldState | undefined): string | undefined {
  if (!field) return undefined;
  const length = (text: string) => [...text].length;
  const squash = (text: string) => text.replace(/\s+/g, " ").trim();
  const same = field.rich ? squash(field.value) === squash(sent) : field.value === sent;
  const notes: string[] = [];
  if (!same) {
    notes.push(
      field.secret
        ? `Catatan: isi field sekarang ${length(field.value)} karakter, bukan ${length(sent)} yang diisi — ada maxlength atau format?`
        : `Catatan: nilai field sekarang ${JSON.stringify(clip(field.value, 120))} (${length(field.value)} karakter), bukan yang diisi (${length(sent)} karakter) — maxlength, mask, atau format otomatis?`,
    );
  }
  if (field.suggest) notes.push("Field ini autocomplete/combobox: pilih sarannya dari daftar perubahan di bawah dengan click ref — jangan menekan Enter.");
  return notes.length > 0 ? notes.join("\n") : undefined;
}

type Special = { kind: "select" | "file"; options: string[] };

/** Dijalankan DI halaman: elemen yang tidak dipakai lewat klik biasa. */
function specialElement(el: Element): Special | undefined {
  if (el instanceof HTMLSelectElement) {
    return { kind: "select", options: Array.from(el.options).slice(0, 20).map((option) => option.label || option.value) };
  }
  if (el instanceof HTMLInputElement && el.type === "file") return { kind: "file", options: [] };
  return undefined;
}

function clickNote(special: Special | undefined): string | undefined {
  if (special?.kind === "select") {
    return `Catatan: ini <select> native — daftar opsinya tidak tampil di browser headless. Pakai select_option; opsinya: ${special.options.join(" | ") || "(kosong)"}`;
  }
  if (special?.kind === "file") return "Catatan: ini input berkas — pakai upload (berkas uji dibuat dengan make_file).";
  return undefined;
}

/** Sesi browser yang sedang hidup, supaya bisa ditutup dari luar saat tugas berakhir. */
const sessions = new Map<string, BrowserSession>();

// Kendali owner → keadaan Live (tombol & banner di UI) dan catatan di thread tugas.
control.onChange((taskId, since) => {
  live.setState(taskId, { controlledSince: since });
  const role = getTask(taskId)?.role;
  if (!role) return;
  bus.emit(taskId, role, {
    type: "notice",
    text: since ? "Owner mengambil alih browser — tool browser agen menunggu." : "Kendali browser dikembalikan ke agen.",
  });
});

/** Ada browser hidup untuk tugas ini (syarat ambil alih)? */
export function browserActiveFor(taskId: string): boolean {
  return sessions.get(taskId)?.hasPage() ?? false;
}

/** Teruskan input owner ke browser tugas. `false` kalau tidak ada browser yang hidup. */
export function ownerInput(taskId: string, input: OwnerInput): boolean {
  const session = sessions.get(taskId);
  if (!session?.hasPage()) return false;
  session.ownerInput(input);
  return true;
}

/**
 * Gambar `view` untuk agen dibatasi supaya API tidak memperkecilnya lagi — kalau diperkecil,
 * koordinat yang agen baca dari gambar tidak lagi cocok dengan halaman.
 */
const VIEW_MAX_EDGE = 1280;
const VIEW_MAX_PIXELS = 1_150_000;

/** Skala viewport → gambar `view`. Ditentukan dari ukuran viewport saja, jadi selalu bisa dihitung ulang. */
export function viewScale(viewport: { width: number; height: number }): number {
  const { width, height } = viewport;
  return Math.min(1, VIEW_MAX_EDGE / Math.max(width, height), Math.sqrt(VIEW_MAX_PIXELS / (width * height)));
}

/** Elemen teratas di sebuah titik viewport, untuk keterangan aksi. Tidak pernah melempar. */
async function describeAt(page: Page, x: number, y: number): Promise<Target | undefined> {
  try {
    const handle = await page.evaluateHandle(([px, py]) => document.elementFromPoint(px, py), [x, y] as const);
    const element = handle.asElement();
    const target = element ? await element.evaluate(describeElement) : undefined;
    await handle.dispose();
    return target;
  } catch {
    return undefined;
  }
}

async function describeFocused(page: Page): Promise<Target | undefined> {
  try {
    const handle = await page.evaluateHandle(() => document.activeElement);
    const element = handle.asElement();
    const target = element ? await element.evaluate(describeElement) : undefined;
    await handle.dispose();
    return target;
  } catch {
    return undefined;
  }
}

const MOUSE_NOTE: Record<string, string> = { left: "klik", right: "klik kanan", middle: "klik tengah" };
/** Tombol non-karakter yang layak dicatat di ringkasan owner (panah, Backspace, dll. terlalu ramai). */
const NOTED_KEYS = new Set(["Enter", "Escape", "Tab"]);

/**
 * Screencast tab Live: setiap gambar Chromium headless (60 per detik), hanya saat halaman berubah.
 * `everyNthFrame` > 1 tidak dipakai: perubahan terakhir sebuah animasi bisa jatuh di gambar yang
 * dilewati, lalu halaman diam dan tab Live membeku di keadaan lama (terukur: 10 dari 20 kali pada
 * nilai 2). Penghematannya pun kecil, karena biaya utama screencast adalah biaya tetap selama menyala.
 */
const SCREENCAST = {
  format: "jpeg",
  quality: 55,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 1,
} as const;
/** Batas tunggu screenshot penutup saat sesi browser ditutup tanpa penonton. */
const FINAL_FRAME_TIMEOUT_MS = 2_000;
/** Halaman yang memuntahkan error terus-menerus tidak boleh menumbuhkan memori tanpa batas. */
const MAX_LOGS = 500;
/** Batas aksi setelah sasarannya sudah ditemukan dan terlihat. */
const ACTION_TIMEOUT_MS = 5_000;

const sameDocument = (a: string, b: string): boolean => a.split("#")[0] === b.split("#")[0];

/** Tutup browser milik satu tugas (dipanggil runner saat tugas ditutup/dioper/dibatalkan). */
export async function closeBrowserFor(taskId: string): Promise<void> {
  const session = sessions.get(taskId);
  if (!session) return;
  await session.close();
}

/** Satu sesi browser per tugas, dipakai ulang antar tool call. */
export class BrowserSession {
  private browser?: Browser;
  private page?: Page;
  private cdp?: CDPSession;
  /** Screencast sedang menyala — ada yang menonton tab Live. */
  private casting = false;
  private offDemand?: () => void;
  private taskId?: string;
  private logs: string[] = [];
  /** Log lama yang dibuang karena melewati MAX_LOGS sejak drain terakhir. */
  private droppedLogs = 0;
  readonly dialogs = new DialogWatcher();
  readonly downloads = new DownloadTracker(() => this.downloadDir());
  readonly popups = new PopupTracker();
  /** Request jaringan halaman sekarang, untuk menunggu halaman tenang setelah aksi. */
  private network?: NetworkTracker;
  /** Halaman yang snapshot-nya terlalu berat untuk diambil di setiap aksi; ringkasan perubahannya dimatikan. */
  private heavyUrl?: string;
  /** Input owner dijalankan berurutan; gerakan mouse yang menumpuk dibuang. */
  private inputChain: Promise<void> = Promise.resolve();
  private queuedMoves = 0;
  /** Nama field yang sedang diketik owner (direset saat klik/Tab) — hanya untuk menghitung karakter. */
  private typingField?: string;

  constructor(private readonly getTaskId: () => string | undefined) {}

  hasPage(): boolean {
    return Boolean(this.page && !this.page.isClosed());
  }

  ownerInput(input: OwnerInput): void {
    if (!this.hasPage()) return;
    if (input.t === "move") {
      if (this.queuedMoves >= 2) return;
      this.queuedMoves += 1;
    }
    this.inputChain = this.inputChain
      .then(() => this.applyInput(input))
      .catch(() => undefined)
      .finally(() => {
        if (input.t === "move") this.queuedMoves -= 1;
      });
  }

  private async applyInput(input: OwnerInput): Promise<void> {
    const page = this.page;
    const taskId = this.taskId;
    if (!page || page.isClosed() || !taskId) return;
    const size = page.viewportSize() ?? { width: 1_000_000, height: 1_000_000 };
    const clampX = (x: number) => Math.min(Math.max(0, x), size.width - 1);
    const clampY = (y: number) => Math.min(Math.max(0, y), size.height - 1);

    switch (input.t) {
      case "move":
        await page.mouse.move(clampX(input.x), clampY(input.y));
        return;
      case "down": {
        const x = clampX(input.x);
        const y = clampY(input.y);
        await page.mouse.move(x, y);
        const target = await describeAt(page, x, y);
        const verb = input.clicks > 1 && input.button === "left" ? "klik ganda" : MOUSE_NOTE[input.button];
        control.note(taskId, `${verb} “${target?.name ?? "halaman"}”`);
        this.typingField = undefined;
        await page.mouse.down({ button: input.button, clickCount: input.clicks });
        return;
      }
      case "up":
        await page.mouse.move(clampX(input.x), clampY(input.y));
        await page.mouse.up({ button: input.button, clickCount: input.clicks });
        return;
      case "wheel":
        await page.mouse.move(clampX(input.x), clampY(input.y));
        await page.mouse.wheel(input.dx, input.dy);
        control.note(taskId, "menggulung halaman");
        return;
      case "key": {
        if (input.phase === "up") {
          await page.keyboard.up(input.key).catch(() => undefined);
          return;
        }
        const printable = [...input.key].length === 1 && !input.ctrl && !input.meta;
        if (printable) await this.countTyping(page, taskId, 1);
        else if (NOTED_KEYS.has(input.key)) control.note(taskId, `menekan ${input.key}`);
        if (input.key === "Tab") this.typingField = undefined;
        try {
          await page.keyboard.down(input.key);
        } catch {
          // Karakter di luar tata letak papan ketik Playwright (mis. é): sisipkan sebagai teks.
          if (printable) await page.keyboard.insertText(input.key);
        }
        return;
      }
      case "text":
        await this.countTyping(page, taskId, [...input.text].length);
        await page.keyboard.insertText(input.text);
        return;
    }
  }

  /** Hanya jumlah karakter yang dicatat, per field — isinya tidak pernah disimpan. */
  private async countTyping(page: Page, taskId: string, characters: number): Promise<void> {
    if (!this.typingField) {
      const focused = await describeFocused(page);
      this.typingField = `“${focused?.name ?? "halaman"}”`;
    }
    control.typed(taskId, this.typingField, characters);
  }

  /**
   * Gambar viewport saat ini untuk agen, diperkecil ke `viewScale`. Lewat CDP karena Playwright
   * tidak bisa memperkecil screenshot; clip memakai koordinat dokumen, jadi geser gulungan ikut dihitung.
   */
  async captureView(): Promise<{ data: string; width: number; height: number; scale: number; viewport: { width: number; height: number } }> {
    const page = this.requirePage();
    const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    const scale = viewScale(viewport);
    const own = this.cdp;
    const client = own ?? (await page.context().newCDPSession(page));
    try {
      const metrics = (await client.send("Page.getLayoutMetrics")) as { cssVisualViewport?: { pageX: number; pageY: number } };
      const shot = await client.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
        clip: {
          x: metrics.cssVisualViewport?.pageX ?? 0,
          y: metrics.cssVisualViewport?.pageY ?? 0,
          width: viewport.width,
          height: viewport.height,
          scale,
        },
      });
      return {
        data: shot.data,
        width: Math.round(viewport.width * scale),
        height: Math.round(viewport.height * scale),
        scale,
        viewport,
      };
    } finally {
      if (!own) await client.detach().catch(() => undefined);
    }
  }

  async getPage(viewport?: { width: number; height: number }): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    if (!this.page || this.page.isClosed()) {
      const context = await this.browser.newContext({
        viewport: viewport ?? { width: 1440, height: 900 },
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          this.log(`[console.${message.type()}] ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => this.log(`[pageerror] ${error.message}`));
      page.on("requestfailed", (request) =>
        this.log(`[requestfailed] ${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "?"}`),
      );
      page.on("response", (response) => {
        if (response.status() >= 400) this.log(`[http ${response.status()}] ${response.url()}`);
      });
      this.dialogs.attach(page);
      this.network = new NetworkTracker();
      this.network.attach(page);
      this.downloads.attach(page);
      this.popups.attach(page);
      this.heavyUrl = undefined;
      this.page = page;
      await this.startLive(page);
    } else if (viewport) {
      // Tanpa ini `open` kedua dengan ukuran lain diam-diam tetap memakai ukuran lama.
      await this.page.setViewportSize(viewport);
      if (this.taskId) live.setState(this.taskId, { viewport });
    }
    return this.page;
  }

  /**
   * Alirkan isi halaman ke panel Live lewat CDP screencast — hanya selama ada yang menonton.
   * Screencast yang menyala memakan ±1 core Chromium selama halaman bergerak, walau tidak ada yang
   * melihat hasilnya; saat penonton datang, frame keadaan sekarang tiba ±25 ms setelah dinyalakan.
   * Kegagalan di sini tidak boleh menjatuhkan pengujian — fitur menonton itu tambahan.
   */
  private async startLive(page: Page): Promise<void> {
    const taskId = this.getTaskId();
    if (!taskId) return;
    this.taskId = taskId;
    sessions.set(taskId, this);
    this.offDemand?.();
    this.offDemand = undefined;
    this.casting = false;

    try {
      const client = await page.context().newCDPSession(page);
      this.cdp = client;
      client.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
        // ACK langsung = izin untuk frame berikutnya. Menundanya membuat Chromium melewatkan frame
        // terakhir sebuah animasi, sehingga tab Live membeku di keadaan setengah jalan.
        void client.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
        if (this.cdp === client) live.publishFrame(taskId, Buffer.from(frame.data, "base64"));
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) live.setState(taskId, { url: frame.url() });
      });
      page.on("close", () => live.stop(taskId));
      live.setState(taskId, { active: true, url: page.url(), viewport: page.viewportSize() ?? undefined });
      this.offDemand = live.onDemand(taskId, (watched) => (watched ? this.startCast(client) : this.stopCast(client)));
      if (live.viewerCount(taskId) > 0) this.startCast(client);
    } catch {
      this.cdp = undefined;
      live.setState(taskId, { active: false });
    }
  }

  private startCast(client: CDPSession): void {
    if (this.cdp !== client || this.casting) return;
    this.casting = true;
    client.send("Page.startScreencast", SCREENCAST).catch(() => {
      if (this.cdp === client) this.casting = false;
    });
  }

  private stopCast(client: CDPSession): void {
    if (this.cdp !== client || !this.casting) return;
    this.casting = false;
    void client.send("Page.stopScreencast").catch(() => undefined);
  }

  /**
   * Frame yang membeku di tab Live setelah sesi selesai harus keadaan akhir halaman. Selama screencast
   * menyala frame terakhirnya sudah terkini; tanpa penonton, ambil satu screenshot.
   */
  private async captureFinalFrame(taskId: string): Promise<void> {
    const client = this.cdp;
    if (this.casting || !client || !this.page || this.page.isClosed()) return;
    try {
      const shot = await within(
        client.send("Page.captureScreenshot", { format: "jpeg", quality: SCREENCAST.quality }),
        FINAL_FRAME_TIMEOUT_MS,
      );
      if (shot) live.publishFrame(taskId, Buffer.from(shot.data, "base64"));
    } catch {
      // halaman sudah rusak — frame terakhir yang ada tetap dipakai
    }
  }

  requirePage(): Page {
    if (!this.page || this.page.isClosed()) throw new Error("belum ada halaman terbuka — panggil open() dulu");
    return this.page;
  }

  private log(line: string): void {
    this.logs.push(line);
    if (this.logs.length > MAX_LOGS) {
      this.logs.shift();
      this.droppedLogs += 1;
    }
  }

  drainLogs(): string[] {
    const logs = this.droppedLogs > 0 ? [`(${this.droppedLogs} log lama dibuang — hanya ${MAX_LOGS} terakhir yang disimpan)`, ...this.logs] : this.logs;
    this.logs = [];
    this.droppedLogs = 0;
    return logs;
  }

  /** Unduhan tugas tinggal di `<folder tugas>/downloads/`, yang otomatis tampil di tab Lampiran. */
  /** Folder unduhan tugas (tampil di tab Lampiran); tanpa tugas, folder sementara di luar data/. */
  private downloadDir(): string {
    const id = this.getTaskId();
    return id ? join(taskDir(id), "downloads") : join(tmpdir(), "ai-team-downloads");
  }

  async settle(page: Page, options: SettleOptions, since?: number): Promise<SettleResult> {
    return this.network ? this.network.settle(page, options, since) : { ms: 0, settled: true, pending: [] };
  }

  /** Ringkasan isi halaman (heading, jumlah elemen) — sekaligus mencatat halaman yang terlalu berat. */
  async overview(page: Page): Promise<string | undefined> {
    const snapshot = await takeSnapshot(page);
    if (!snapshot) return undefined;
    if (isHeavy(snapshot)) this.heavyUrl = page.url();
    return pageOverview(snapshot.text);
  }

  /**
   * Jalankan satu aksi lalu susun laporannya: dialog native, unduhan, tab baru, dan perubahan halaman
   * setelah halaman tenang. `run` menerima snapshot sebelum aksi, untuk menamai ref yang dituju.
   */
  async act<T>(
    page: Page,
    run: (before: Snapshot | undefined) => Promise<T>,
    options: { settle?: SettleOptions | ((value: T) => SettleOptions); focus?: boolean } = {},
  ): Promise<{ value: T; report: string[] }> {
    const marks = { dialogs: this.dialogs.count(), downloads: this.downloads.count(), popups: this.popups.count() };
    const startUrl = page.url();
    const before = this.heavyUrl === startUrl ? undefined : await takeSnapshot(page);
    if (before && isHeavy(before)) this.heavyUrl = startUrl;
    const began = Date.now();
    const value = await run(before);
    const settle = typeof options.settle === "function" ? options.settle(value) : options.settle;
    const settled = await this.settle(page, settle ?? SETTLE_FULL, began);
    const [downloads, popups] = await Promise.all([this.downloads.since(marks.downloads), this.popups.since(marks.popups)]);
    const dialogs = this.dialogs.takeSince(marks.dialogs);

    const report: string[] = [];
    if (dialogs.length > 0) {
      report.push(`Dialog native yang muncul:\n${dialogs.join("\n")}\n(pakai tool \`dialog\` sebelum aksi kalau ingin menekan OK)`);
    }
    report.push(...downloads.map(describeDownload));
    const downloaded = new Set(downloads.map((download) => download.url));
    for (const popup of popups) {
      if (!popup.url || popup.url === "about:blank" || downloaded.has(popup.url)) continue;
      report.push(
        `Tab baru dibuka: ${popup.title ? `“${clip(popup.title, 80)}” — ` : ""}${popup.url}. Tool hanya bekerja di tab utama, ` +
          "jadi tab itu sudah ditutup; buka URL-nya dengan open bila perlu diuji.",
      );
    }
    const { text, after } = await this.describeChanges(page, before, startUrl, settled);
    // Fokus hanya berarti di dokumen yang sama; setelah submit yang pindah halaman, itu cuma noise.
    const sameDoc = after !== undefined && (!before || sharedRefCount(before.text, after.text) > 0);
    const focus = options.focus && sameDoc ? focusedElement(after.text) : undefined;
    if (focus) report.push(focus);
    report.push(text);
    return { value, report };
  }

  private async describeChanges(
    page: Page,
    before: Snapshot | undefined,
    startUrl: string,
    settled: SettleResult,
  ): Promise<{ text: string; after?: Snapshot }> {
    const calm = formatSettle(settled);
    if (page.isClosed()) return { text: `Halaman ${calm}.` };
    const url = page.url();
    const moved = !sameDocument(url, startUrl);
    if (this.heavyUrl === url && !moved) {
      return {
        text: `Halaman ${calm}. Ringkasan perubahan dilewati: halaman ini terlalu besar untuk dipotret di setiap aksi — pakai snapshot dengan selector.`,
      };
    }
    const after = await takeSnapshot(page);
    if (!after) return { text: `Halaman ${calm}.` };
    if (isHeavy(after)) this.heavyUrl = url;
    return { text: await this.changesText(page, before, after, url, moved, calm), after };
  }

  private async changesText(page: Page, before: Snapshot | undefined, after: Snapshot, url: string, moved: boolean, calm: string): Promise<string> {
    const arrived = async (how: string) =>
      `${how} (${calm}): “${clip(await page.title().catch(() => ""), 80)}” — ${url}\n${pageOverview(after.text)}`;
    if (!before) return moved ? arrived("Pindah halaman") : `Halaman ${calm}.`;
    // Dokumen baru (navigasi penuh, submit form, muat ulang): tidak ada elemen yang sama, jadi
    // ringkasan halaman lebih berguna daripada "semua hilang, semua muncul".
    if (sharedRefCount(before.text, after.text) === 0) return arrived(moved ? "Pindah halaman" : "Halaman dimuat ulang");
    const changes = diffSnapshots(before.text, after.text);
    if (changes.length === 0) return moved ? arrived("Pindah halaman") : `Tidak ada perubahan di halaman (${calm}).`;
    const { text, omitted } = formatChanges(changes);
    if (moved && omitted > 0) return arrived("Pindah halaman");
    return `${moved ? `URL berubah ke ${url}. ` : ""}Perubahan halaman (${calm}; + muncul, ~ berubah, − hilang — ref-nya langsung bisa dipakai):\n${text}`;
  }

  async close(): Promise<void> {
    if (this.taskId) {
      // Browser hilang: tool agen yang menunggu owner harus bangun, kendali tidak berarti lagi.
      control.release(this.taskId, undefined, "browser ditutup");
      await this.captureFinalFrame(this.taskId);
      this.offDemand?.();
      this.offDemand = undefined;
      live.stop(this.taskId);
      sessions.delete(this.taskId);
    }
    const cdp = this.cdp;
    this.cdp = undefined;
    this.casting = false;
    await cdp?.detach().catch(() => undefined);
    await this.page?.context().close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
    this.browser = undefined;
  }
}

/**
 * MCP server in-process berisi tool browser untuk QA.
 * `getTaskId` dievaluasi saat tool dipanggil, sehingga screenshot selalu
 * mendarat di folder tugas yang sedang dikerjakan.
 */
export function createBrowserServer(session: BrowserSession, getTaskId: () => string | undefined) {

  const shotDir = (): string => {
    const id = getTaskId();
    const dir = id ? assetsDir(id) : join(CONFIG.tasksDir, "_adhoc", "assets");
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  /** Berkas uji unggahan hidup di run_dir/uploads — ikut tampil di tab Lampiran sebagai bukti. */
  const uploadDir = (): string => {
    const id = getTaskId();
    const dir = id ? join(assetsDir(id), "..", "uploads") : join(CONFIG.tasksDir, "_adhoc", "uploads");
    mkdirSync(dir, { recursive: true });
    return resolve(dir);
  };

  /** Hanya berkas di dalam folder uploads yang boleh diserahkan ke halaman (penutup path traversal). */
  const resolveUpload = (name: string): string => {
    const dir = uploadDir();
    const target = resolve(dir, basename(name));
    if (!target.startsWith(`${dir}/`)) throw new Error(`${name}: di luar folder uploads`);
    if (!existsSync(target)) throw new Error(`${name}: tidak ada di ./uploads/ — buat dulu dengan make_file`);
    return target;
  };

  /** Cari sasaran aksi. Kalau gagal, aksinya tetap disiarkan ke overlay Live (tanpa kotak) sebelum tool gagal. */
  const aim = async (page: Page, args: TargetArgs, failed: Omit<BrowserAction, "at">): Promise<Locator> => {
    try {
      return await resolveTarget(page, args);
    } catch (error) {
      announce(failed);
      throw error;
    }
  };

  /** Nama sasaran sebelum ditemukan: dari snapshot untuk ref, selain itu selector/teksnya. */
  const hintOf = (args: TargetArgs, before: Snapshot | undefined): string =>
    (args.ref ? refName(before?.text, cleanRef(args.ref)) : undefined) ?? targetLabel(args);

  /** Nama sasaran di hasil tool, supaya agen bisa memastikan yang kena memang yang dimaksud. */
  const nameOf = async (element: Locator, args: TargetArgs, before: Snapshot | undefined, probed: Target | undefined): Promise<string> => {
    const ref = args.ref ? cleanRef(args.ref) : undefined;
    const known = ref ? refName(before?.text, ref) : undefined;
    if (ref && known) return `${known} [${ref}]`;
    const hit = probed ?? (await element.evaluate(describeElement).catch(() => undefined));
    if (ref) return `“${hit?.name ?? "?"}” [${ref}]`;
    return hit ? `“${hit.name}” (${targetLabel(args)})` : targetLabel(args);
  };

  /** Tugas yang overlay Live-nya sedang ditonton; tanpa penonton aksi tidak diukur sama sekali. */
  const watchedTask = (): string | undefined => {
    const id = getTaskId();
    return id && live.actionWatcherCount(id) > 0 ? id : undefined;
  };

  const announce = (action: Omit<BrowserAction, "at">): void => {
    const id = watchedTask();
    if (id) live.publishAction(id, { ...action, at: Date.now() });
  };

  /**
   * Posisi & nama elemen target untuk overlay. Tidak pernah menggagalkan tool.
   * `scrollFirst` hanya untuk aksi yang memang menggulung elemennya ke layar sendiri (click, hover,
   * fill), jadi keadaan akhir halaman sama persis — ditonton atau tidak.
   */
  const probe = async (locator: Locator, scrollFirst: boolean): Promise<Target | undefined> => {
    if (!watchedTask()) return undefined;
    try {
      if ((await locator.count()) === 0) return undefined;
      if (scrollFirst) await locator.scrollIntoViewIfNeeded({ timeout: PROBE_TIMEOUT_MS });
      return await locator.evaluate(describeElement, undefined, { timeout: PROBE_TIMEOUT_MS });
    } catch {
      return undefined;
    }
  };

  const named = (target: Target | undefined, fallback: string): string => `“${target?.name || fallback}”`;

  /**
   * Setiap tool browser menunggu selama owner memegang kendali (tab Live → Ambil alih), lalu
   * hasilnya diawali ringkasan apa yang owner lakukan. Tanpa owner, tool berjalan seperti biasa.
   */
  const gate = (definitions: Array<SdkMcpToolDefinition<any>>): Array<SdkMcpToolDefinition<any>> =>
    definitions.map((definition) => ({
      ...definition,
      handler: async (args: unknown, extra: unknown) => {
        const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
        const wait = await control.waitIfHeld(getTaskId(), signal);
        if (wait.kind === "held") return fail(wait.message);
        const result = await definition.handler(args as never, extra);
        if (wait.kind !== "returned") return result;
        return { ...result, content: [{ type: "text" as const, text: wait.report }, ...result.content] };
      },
    }));

  /** Koordinat gambar `view` → viewport (px CSS). Skalanya dihitung ulang dari viewport sekarang. */
  const fromView = (page: Page, x: number, y: number): { x: number; y: number } => {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("ukuran viewport tidak diketahui — panggil open() dulu");
    const scale = viewScale(viewport);
    const point = { x: x / scale, y: y / scale };
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
      throw new Error(
        `(${x}, ${y}) di luar gambar ${Math.round(viewport.width * scale)}×${Math.round(viewport.height * scale)} — panggil view untuk melihat layar sekarang`,
      );
    }
    return point;
  };

  const pointSchema = z.object({ x: z.number().min(0), y: z.number().min(0) });

  return createSdkMcpServer({
    name: "browser",
    version: "0.1.0",
    instructions:
      "Browser Chromium headless untuk pengujian QA dan audit UI/UX. Alur yang disarankan: open → snapshot → (click/fill/press/hover/select_option dengan `ref` dari snapshot) → scroll/inspect → screenshot → console. Screenshot otomatis disimpan ke folder bukti laporan. " +
      "Hasil setiap aksi sudah menunggu halaman tenang dan mencantumkan perubahan halaman (+ muncul, ~ berubah, − hilang, lengkap dengan ref barunya), dialog, unduhan, dan tab baru — tidak perlu `wait` jeda tetap atau screenshot hanya untuk melihat hasil aksi. " +
      "Unduhan (tombol Ekspor, URL ekspor) tersimpan di ./downloads/ dan dilaporkan isinya. " +
      "Sebelum melaporkan apa pun sebagai terpotong/tidak terlihat/hilang, panggil `inspect` — isi yang bisa di-scroll (scrollWidth > clientWidth dengan overflow auto|scroll) bukan teks terpotong, dan `scroll` bisa menggesernya. " +
      "Dialog native confirm/alert/prompt dibatalkan otomatis kecuali Anda memasang `dialog` lebih dulu. " +
      "Untuk canvas, widget kustom, drag & drop, atau pemeriksaan visual ada tool berbasis layar: `view` lalu `click_at`/`type_text`/`scroll_at`/`drag`/`move` dengan koordinat gambar view. " +
      "Kalau owner sedang memegang browser, tool menunggu sampai kendali dikembalikan.",
    tools: gate([
      tool(
        "open",
        "Buka URL di browser dan kembalikan judul, status halaman, viewport, dan ringkasan isinya (heading, jumlah tautan/tombol/field). Tool menunggu sampai halaman tenang (data SPA ikut termuat) — tidak perlu wait sesudahnya. " +
          "URL yang langsung mengunduh berkas (ekspor) dilaporkan sebagai unduhan di ./downloads/. Isi `width` dan `height` berdua untuk mengganti ukuran viewport; ukuran itu bertahan sampai diganti lagi.",
        {
          url: z.string().describe("URL lengkap termasuk http/https"),
          width: z.number().int().min(320).max(3840).optional(),
          height: z.number().int().min(320).max(2160).optional(),
        },
        async (args) => {
          try {
            const page = await session.getPage(
              args.width && args.height ? { width: args.width, height: args.height } : undefined,
            );
            announce({ kind: "open", label: `Membuka ${args.url}` });
            const downloadsBefore = session.downloads.count();
            const began = Date.now();
            let response: Awaited<ReturnType<Page["goto"]>> = null;
            try {
              response = await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            } catch (error) {
              if (!/Download is starting/i.test(error instanceof Error ? error.message : String(error))) throw error;
              await session.downloads.started(downloadsBefore, 5_000);
              const downloads = await session.downloads.since(downloadsBefore);
              return ok(
                [`URL ini langsung mengunduh berkas, bukan membuka halaman. Browser tetap di ${page.url() || "halaman kosong"}.`, ...downloads.map(describeDownload)].join("\n"),
              );
            }
            const settled = await session.settle(page, SETTLE_OPEN, began);
            const overview = await session.overview(page);
            const downloads = await session.downloads.since(downloadsBefore);
            const title = await page.title();
            const taskId = getTaskId();
            if (taskId) live.setState(taskId, { url: page.url(), title });
            return ok(
              [
                `Terbuka: ${page.url()}`,
                `Status HTTP: ${response?.status() ?? "(tidak ada respons)"}`,
                `Judul: ${title}`,
                `Viewport: ${viewportLabel(page)}`,
                `Halaman ${formatSettle(settled)}.`,
                ...(overview ? [overview] : []),
                ...downloads.map(describeDownload),
              ].join("\n"),
            );
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "snapshot",
        "Struktur halaman untuk beraksi: setiap elemen punya [ref=…] (mis. e12 atau f2e7) — pakai ref itu di click/fill/hover/press/select_option. Lebih tepat daripada selector atau teks: tombol kembar di baris tabel pun jelas mana yang dituju. " +
          "Elemen tersembunyi tidak tercantum; [cursor=pointer] menandai elemen kustom yang bisa diklik. Ref tetap berlaku selama elemennya masih ada. " +
          "`selector` membatasi ke satu bagian (form, tabel, .modal) — hemat untuk halaman besar. Isi field password disamarkan.",
        {
          selector: z.string().optional().describe("batasi ke bagian ini, mis. form, table, .modal"),
          maxChars: z.number().int().min(500).max(40_000).optional(),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            announce({ kind: "read", label: "Membaca struktur halaman" });
            const { text: snapshot } = await secretSnapshot(page, args.selector ? page.locator(args.selector).first() : page, 10_000);
            const max = args.maxChars ?? 12_000;
            const position = await scrollInfo(page);
            return ok(
              [
                `URL: ${page.url()}`,
                `Judul: ${await page.title()}`,
                ...(position ? [`Posisi: ${position}`] : []),
                ...(args.selector ? [`Bagian: ${args.selector}`] : []),
                "",
                snapshot.length > max
                  ? `${snapshot.slice(0, max)}\n… (dipotong — pakai selector untuk membatasi ke bagian yang dibutuhkan)`
                  : snapshot,
              ].join("\n"),
            );
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "click",
        "Klik elemen. Pakai `ref` dari snapshot (paling tepat), atau `selector`/`text` — keduanya hanya mengenai elemen yang TERLIHAT. " +
          "Hasilnya sudah menunggu halaman tenang dan mencantumkan perubahan halaman beserta ref barunya, dialog, unduhan, dan tab baru.",
        {
          ref: z.string().optional().describe("ref dari snapshot, mis. e12"),
          selector: z.string().optional(),
          text: z.string().optional().describe("teks yang terlihat, cocok sebagian"),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const { value, report } = await session.act(page, async (before) => {
              const hint = hintOf(args, before);
              const element = await aim(page, args, { kind: "click", label: `Mengklik “${hint}”` });
              const target = await probe(element, true);
              announce({ kind: "click", label: `Mengklik ${named(target, hint)}`, box: target?.box });
              const name = await nameOf(element, args, before, target);
              const special = await element.evaluate(specialElement).catch(() => undefined);
              await element.click({ timeout: ACTION_TIMEOUT_MS });
              return { name, note: clickNote(special) };
            });
            return ok([`Diklik: ${value.name}`, ...(value.note ? [value.note] : []), `URL sekarang: ${page.url()}`, ...report].join("\n"));
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "fill",
        "Isi input/textarea/contenteditable (isi lama diganti). Pakai `ref` dari snapshot atau `selector`. " +
          "Isi field dibaca ulang: kalau berbeda dari yang diisi (maxlength, mask, format otomatis) hasilnya memberi tahu. Pesan validasi atau saran autocomplete yang muncul tercantum di perubahan halaman.",
        {
          ref: z.string().optional().describe("ref dari snapshot, mis. e12"),
          selector: z.string().optional(),
          value: z.string(),
        },
        async (args) => {
          try {
            if (!args.ref && !args.selector) return fail("butuh `ref` (dari snapshot) atau `selector`");
            const page = session.requirePage();
            const where: TargetArgs = { ref: args.ref, selector: args.selector };
            const { value, report } = await session.act(
              page,
              async (before) => {
                const hint = hintOf(where, before);
                const element = await aim(page, where, { kind: "fill", label: `Mengisi “${hint}”` });
                const target = await probe(element, true);
                // Tanpa target (gagal diukur) isinya tidak ditampilkan: bisa saja itu field password.
                const typed = target && !target.secret ? args.value.slice(0, 120) : target ? "••••••" : undefined;
                announce({ kind: "fill", label: `Mengisi ${named(target, hint)}`, box: target?.box, text: typed });
                const name = await nameOf(element, where, before, target);
                await element.fill(args.value, { timeout: ACTION_TIMEOUT_MS });
                const field = await element.evaluate(readField).catch(() => undefined);
                return { name, note: fillNote(args.value, field), suggest: field?.suggest === true };
              },
              { settle: (filled) => (filled.suggest ? SETTLE_SUGGEST : SETTLE_LIGHT) },
            );
            return ok([`Terisi: ${value.name}`, ...(value.note ? [value.note] : []), ...report].join("\n"));
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "press",
        "Tekan tombol keyboard (contoh: Enter, Tab, Escape, Control+A) — di elemen yang sedang fokus, atau di `ref`/`selector`. Hasilnya menyebut elemen yang fokus sesudahnya (untuk audit urutan Tab) dan perubahan halaman seperti click.",
        {
          key: z.string(),
          ref: z.string().optional().describe("ref dari snapshot, mis. e12"),
          selector: z.string().optional(),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const where: TargetArgs = { ref: args.ref, selector: args.selector };
            const { value, report } = await session.act(
              page,
              async (before) => {
                if (!where.ref && !where.selector) {
                  announce({ kind: "press", label: `Menekan ${args.key}`, key: args.key });
                  await page.keyboard.press(args.key);
                  return undefined;
                }
                const hint = hintOf(where, before);
                const element = await aim(page, where, { kind: "press", label: `Menekan ${args.key}`, key: args.key });
                const target = await probe(element, false);
                announce({ kind: "press", label: `Menekan ${args.key}`, key: args.key, box: target?.box });
                const name = await nameOf(element, where, before, target);
                await element.press(args.key, { timeout: ACTION_TIMEOUT_MS });
                return name;
              },
              { focus: true },
            );
            return ok([`Tombol ${args.key} ditekan${value ? ` di ${value}` : ""}`, `URL sekarang: ${page.url()}`, ...report].join("\n"));
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "wait",
        "Tunggu teks atau selector muncul/hilang, atau tunggu sejumlah milidetik. Aksi sudah menunggu halaman tenang sendiri — pakai ini hanya untuk hal yang datang belakangan (toast, proses panjang). " +
          "`text` menunggu teks itu TERLIHAT (atau hilang dengan state hidden).",
        {
          text: z.string().optional().describe("teks yang ditunggu, cocok sebagian"),
          selector: z.string().optional(),
          state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
          ms: z.number().int().min(100).max(30_000).optional(),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            if (args.text) {
              const shown = page.getByText(args.text, { exact: false }).visible().first();
              const gone = args.state === "hidden" || args.state === "detached";
              await shown.waitFor({ state: gone ? "detached" : "attached", timeout: 15_000 });
              return ok(`Teks "${args.text}" sudah ${gone ? "tidak terlihat" : "terlihat"}`);
            }
            if (args.selector) {
              await page.locator(args.selector).first().waitFor({ state: args.state ?? "visible", timeout: 15_000 });
              return ok(`Selector ${args.selector} sudah ${args.state ?? "visible"}`);
            }
            await page.waitForTimeout(args.ms ?? 1_000);
            return ok(`Menunggu ${args.ms ?? 1_000}ms`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "scroll",
        "Gulung halaman atau isi sebuah container (termasuk HORIZONTAL). Tunjuk `selector` elemen yang isinya ingin digeser — tool mencari sendiri elemen yang benar-benar menggulung di atasnya (mis. .table-responsive / .dataTables_scrollBody). Tanpa to/dx/dy ia hanya melaporkan posisi sekarang.",
        {
          selector: z.string().optional().describe("elemen yang isinya ingin digeser; kosong = seluruh halaman"),
          to: z.enum(["left", "right", "top", "bottom"]).optional().describe("gulung sampai mentok ke satu sisi"),
          dx: z.number().optional().describe("geser horizontal relatif dalam px (negatif = ke kiri)"),
          dy: z.number().optional().describe("geser vertikal relatif dalam px"),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const target = args.selector ? await probe(page.locator(args.selector).first(), false) : undefined;
            const where = args.selector ? named(target, args.selector) : "halaman";
            announce({ kind: "scroll", label: `Menggulung ${where}`, box: target?.box });
            const report = await scroll(page, args);
            return ok(formatScroll(report));
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "inspect",
        "WAJIB sebelum melaporkan sesuatu sebagai terpotong/tidak terlihat. Melaporkan ukuran, scrollWidth vs clientWidth, overflow, text-overflow, scroller terdekat, dan TEKS PENUH elemen — sehingga jelas apakah isinya cuma perlu di-scroll atau benar-benar terpotong. " +
          "Juga melaporkan warna, background efektif, tipografi, dan rasio kontras WCAG. Background dibaca dari elemen dan ancestor DOM-nya: elemen yang ditumpuk secara absolut di atas elemen lain perlu dicek juga dengan screenshot.",
        {
          selector: z.string().describe("CSS selector; boleh cocok ke beberapa elemen"),
          limit: z.number().int().min(1).max(20).optional().describe("berapa elemen dilaporkan (bawaan 3)"),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const target = await probe(page.locator(args.selector).first(), false);
            announce({ kind: "read", label: `Memeriksa ${named(target, args.selector)}`, box: target?.box });
            const reports = await inspect(page, args.selector, args.limit);
            return ok(formatInspect(reports, args.selector));
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "text",
        "Ambil teks penuh (textContent) elemen-elemen yang cocok — mis. seluruh isi baris tabel — tanpa bergantung pada apa yang terlihat di screenshot.",
        {
          selector: z.string(),
          limit: z.number().int().min(1).max(200).optional().describe("bawaan 20"),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const target = await probe(page.locator(args.selector).first(), false);
            announce({ kind: "read", label: `Membaca teks ${named(target, args.selector)}`, box: target?.box });
            const { texts, total } = await readText(page, args.selector, args.limit);
            const lines = texts.map((text, index) => `${index + 1}. ${text || "(kosong)"}`);
            return ok(
              `${args.selector} — ${total} elemen cocok${texts.length < total ? `, ${texts.length} ditampilkan` : ""}\n${lines.join("\n")}`,
            );
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "hover",
        "Taruh kursor di atas elemen (untuk tooltip, menu, atau tombol yang baru muncul saat di-hover). Pakai `ref` dari snapshot, atau `selector`/`text`. Isi yang muncul tercantum di perubahan halaman, lengkap dengan ref-nya.",
        {
          ref: z.string().optional().describe("ref dari snapshot, mis. e12"),
          selector: z.string().optional(),
          text: z.string().optional(),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const { value, report } = await session.act(
              page,
              async (before) => {
                const hint = hintOf(args, before);
                const element = await aim(page, args, { kind: "hover", label: `Mengarahkan kursor ke “${hint}”` });
                const target = await probe(element, true);
                announce({ kind: "hover", label: `Mengarahkan kursor ke ${named(target, hint)}`, box: target?.box });
                const name = await nameOf(element, args, before, target);
                await element.hover({ timeout: ACTION_TIMEOUT_MS });
                return name;
              },
              { settle: SETTLE_HOVER },
            );
            return ok([`Hover di: ${value}`, ...report].join("\n"));
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "select_option",
        "Pilih opsi pada <select> native berdasarkan value atau label yang terlihat. Pakai `ref` dari snapshot (combobox) atau `selector`. " +
          "Opsi yang tidak ada dilaporkan beserta daftar opsi yang tersedia. Dropdown kustom (bukan <select>): click untuk membukanya, lalu click opsinya.",
        {
          ref: z.string().optional().describe("ref dari snapshot, mis. e12"),
          selector: z.string().optional(),
          value: z.string().optional(),
          label: z.string().optional(),
        },
        async (args) => {
          try {
            if (!args.value && !args.label) return fail("butuh `value` atau `label`");
            if (!args.ref && !args.selector) return fail("butuh `ref` (dari snapshot) atau `selector`");
            const page = session.requirePage();
            const where: TargetArgs = { ref: args.ref, selector: args.selector };
            const choice = args.label ?? args.value ?? "";
            const { value, report } = await session.act(page, async (before) => {
              const hint = hintOf(where, before);
              const element = await aim(page, where, { kind: "select", label: `Memilih “${choice}” di “${hint}”` });
              const target = await probe(element, false);
              announce({ kind: "select", label: `Memilih “${choice}” di ${named(target, hint)}`, box: target?.box });
              const name = await nameOf(element, where, before, target);
              try {
                const selected = await element.selectOption(args.value ? { value: args.value } : { label: args.label as string }, {
                  timeout: ACTION_TIMEOUT_MS,
                });
                return { name, selected };
              } catch (error) {
                if (!/did not find some options/.test(error instanceof Error ? error.message : String(error))) throw error;
                const options = await element
                  .evaluate((el) =>
                    el instanceof HTMLSelectElement
                      ? Array.from(el.options)
                          .slice(0, 40)
                          .map((option) => (option.label === option.value ? option.label : `${option.label} (value=${option.value})`))
                      : [],
                  )
                  .catch(() => [] as string[]);
                throw new TargetError(`opsi ${JSON.stringify(choice)} tidak ada di ${name}. Opsi yang tersedia: ${options.join(" | ") || "(kosong)"}`);
              }
            });
            return ok([`Terpilih pada ${value.name}: ${value.selected.join(", ") || "(tidak ada)"}`, ...report].join("\n"));
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "dialog",
        "Tentukan apa yang dilakukan pada dialog native (confirm/alert/prompt) BERIKUTNYA, lalu baru panggil click. Tanpa ini dialog selalu dibatalkan (dismiss) — itu sebabnya tombol hapus yang memakai confirm() tidak pernah jadi. Jangan ganti klik konfirmasi dengan curl.",
        {
          action: z.enum(["accept", "dismiss"]).describe("accept = tekan OK, dismiss = tekan Cancel"),
          promptText: z.string().optional().describe("isi untuk dialog prompt()"),
          forNext: z.number().int().min(1).max(20).optional().describe("berlaku untuk N dialog berikutnya (bawaan 1)"),
        },
        async (args) => {
          const count = args.forNext ?? 1;
          session.dialogs.arm(args.action, args.promptText, count);
          const seen = session.dialogs.drain();
          return ok(
            `${count} dialog berikutnya akan di-${args.action}${args.promptText ? ` dengan teks "${args.promptText}"` : ""}. Sekarang panggil click pada tombol yang memunculkannya.${
              seen.length > 0 ? `\n\nDialog sebelum ini:\n${seen.join("\n")}` : ""
            }`,
          );
        },
      ),
      tool(
        "console",
        "Ambil error console, page error, request gagal, respons HTTP >= 400, dan dialog native yang muncul sejak panggilan terakhir.",
        {},
        async () => {
          const logs = [...session.drainLogs(), ...session.dialogs.drain()];
          return ok(logs.length === 0 ? "Tidak ada error console/jaringan/dialog baru." : logs.join("\n"));
        },
      ),
      tool(
        "screenshot",
        "Simpan screenshot sebagai bukti laporan. File masuk ke folder assets run yang aktif dan gambarnya dikembalikan ke Anda. " +
          "Perhatian: `fullPage` hanya memperbesar TINGGI dokumen — isi container yang bisa di-scroll (tabel lebar di dalam overflow-x: auto) tetap terpotong di gambar, dan scrollbar overlay tidak dilukis di headless. " +
          "Untuk area yang bisa di-scroll, ambil beberapa screenshot: satu di posisi awal, lalu `scroll` ke ujung dan ambil lagi.",
        {
          name: z.string().describe("nama deskriptif tanpa ekstensi, contoh: login-error-kredensial-salah"),
          fullPage: z.boolean().optional(),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const safeName = args.name.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 60) || "shot";
            const file = join(shotDir(), `${safeName}.png`);
            announce({ kind: "shot", label: `Mengambil screenshot ${safeName}` });
            const buffer = await page.screenshot({ fullPage: args.fullPage ?? false, timeout: 20_000 });
            writeFileSync(file, buffer);
            return {
              content: [
                { type: "text", text: `Screenshot disimpan: ./assets/${safeName}.png (URL: ${page.url()})` },
                { type: "image", data: buffer.toString("base64"), mimeType: "image/png" },
              ],
            };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "discard_screenshot",
        "Hapus satu screenshot dari folder bukti run ini, untuk bukti yang ternyata tidak valid (mis. salah langkah). Hanya berlaku di folder bukti run yang aktif.",
        {
          name: z.string().describe("nama file tanpa path, dengan atau tanpa .png"),
          reason: z.string().describe("kenapa bukti ini dibuang — sebutkan juga di laporan"),
        },
        async (args) => {
          try {
            const dir = shotDir();
            const file = basename(args.name.endsWith(".png") ? args.name : `${args.name}.png`);
            const target = resolve(dir, file);
            // Penjaga: hanya file di dalam folder bukti run yang aktif yang boleh dihapus.
            if (!target.startsWith(`${resolve(dir)}/`)) return fail("di luar folder bukti run");
            if (!existsSync(target)) return fail(`tidak ada file ${file} di folder bukti`);
            unlinkSync(target);
            return ok(`Bukti ${file} dihapus. Alasan: ${args.reason}`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "make_file",
        "Buat berkas uji dummy di folder ./uploads/ tugas untuk dipakai `upload`. PNG/JPG/PDF valid, CSV/TXT/JSON berisi contoh, `bin` acak untuk uji tipe tak didukung. " +
          "`sizeKb` memadatkan berkas ke ukuran itu (uji batas ukuran) tanpa merusak formatnya.",
        {
          name: z.string().describe("nama berkas dengan ekstensi, mis. foto.png, data.csv, besar.pdf"),
          kind: z.enum(KINDS as [TestFileKind, ...TestFileKind[]]).optional().describe("bawaan: dari ekstensi nama"),
          sizeKb: z.number().int().min(1).max(50_000).optional().describe("ukuran akhir dalam KB"),
          text: z.string().optional().describe("isi untuk csv/txt/json (bawaan: contoh kecil yang valid)"),
          width: z.number().int().min(1).max(4096).optional().describe("png/jpg, bawaan 320"),
          height: z.number().int().min(1).max(4096).optional().describe("png/jpg, bawaan 240"),
        },
        async (args) => {
          try {
            const kind = args.kind ?? kindFromName(args.name);
            if (!kind) return fail(`ekstensi ${args.name} tidak dikenal — isi \`kind\` (${KINDS.join("/")})`);
            const safeName = basename(args.name).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || `uji.${kind}`;
            let jpeg: Buffer | undefined;
            if (kind === "jpg") {
              // Node tidak punya encoder JPEG; render halaman polos lewat Chromium.
              const page = await session.getPage();
              const scratch = await page.context().newPage();
              try {
                await scratch.setViewportSize({ width: args.width ?? 320, height: args.height ?? 240 });
                await scratch.setContent(
                  `<body style="margin:0;background:linear-gradient(135deg,#dbeafe,#2383e2);font:20px sans-serif;color:#fff;display:grid;place-items:center">${safeName}</body>`,
                );
                jpeg = await scratch.screenshot({ type: "jpeg", quality: 80 });
              } finally {
                await scratch.close().catch(() => undefined);
              }
            }
            const { buffer, mime } = makeTestFile({ ...args, name: safeName, kind, jpeg });
            const file = join(uploadDir(), safeName);
            writeFileSync(file, buffer);
            return ok(`Berkas uji dibuat: ./uploads/${safeName} (${buffer.length} byte, ${mime}). Pakai \`upload\` dengan files: ["${safeName}"].`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "upload",
        "Serahkan berkas dari ./uploads/ (buat dulu dengan make_file) ke input file halaman. Beri `selector` <input type=file> (boleh tersembunyi), " +
          "ATAU `clickRef`/`clickSelector`/`clickText` tombol kustom yang membuka dialog pilih berkas. Tanpa keduanya dipakai input file pertama di halaman. `files: []` mengosongkan pilihan. " +
          "Hasilnya menunggu unggahan yang langsung berjalan dan mencantumkan perubahan halaman (nama berkas, pratinjau, pesan galat).",
        {
          files: z.array(z.string()).max(20).describe("nama berkas di ./uploads/"),
          selector: z.string().optional(),
          clickRef: z.string().optional().describe("ref tombol unggah dari snapshot"),
          clickSelector: z.string().optional(),
          clickText: z.string().optional(),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const paths = args.files.map(resolveUpload);
            const button: TargetArgs = { ref: args.clickRef, selector: args.clickSelector, text: args.clickText };
            const clicking = Boolean(button.ref || button.selector || button.text);
            const label = paths.length === 0 ? "Mengosongkan pilihan berkas" : `Mengunggah ${args.files.join(", ")}`;
            const { value: target, report } = await session.act(page, async (before) => {
              const element = clicking
                ? await aim(page, button, { kind: "upload", label })
                : page.locator(args.selector ?? 'input[type="file"]').first();
              const probed = await probe(element, false);
              announce({ kind: "upload", label, box: probed?.box });
              if (clicking) {
                const [chooser] = await Promise.all([
                  page.waitForEvent("filechooser", { timeout: 10_000 }),
                  element.click({ timeout: 10_000 }),
                ]);
                if (paths.length > 1 && !chooser.isMultiple()) {
                  throw new TargetError("input ini hanya menerima satu berkas (tanpa atribut multiple) — kirim satu nama saja");
                }
                await chooser.setFiles(paths);
                return `dialog pilih berkas dari ${await nameOf(element, button, before, probed)}`;
              }
              const selector = args.selector ?? 'input[type="file"]';
              if ((await element.count()) === 0) {
                throw new TargetError(
                  args.selector
                    ? `tidak ada elemen ${selector}`
                    : "tidak ada <input type=file> di halaman — pakai clickRef/clickSelector/clickText pada tombol unggahnya",
                );
              }
              await element.setInputFiles(paths, { timeout: 10_000 });
              return selector;
            });
            return ok(
              [
                paths.length === 0 ? "Pilihan berkas dikosongkan" : `Terunggah ke ${target}: ${args.files.join(", ")}`,
                `URL sekarang: ${page.url()}`,
                ...report,
              ].join("\n"),
            );
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "view",
        "Lihat layar browser SEKARANG sebagai gambar (bukan bukti laporan — pakai `screenshot` untuk bukti). " +
          "Gambarnya diperkecil ke ukuran tetap; koordinat untuk click_at/type_text/scroll_at/drag/move memakai piksel gambar ini, (0,0) = kiri atas. " +
          "Pakai untuk hal yang tidak bisa dijangkau selector: canvas, peta, grafik, widget kustom, drag & drop, atau memeriksa tampilan secara visual. " +
          "Untuk form dan tombol biasa tetap utamakan snapshot + click/fill: lebih presisi dan lebih hemat.",
        {},
        async () => {
          try {
            const page = session.requirePage();
            announce({ kind: "read", label: "Melihat layar" });
            const shot = await session.captureView();
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Layar ${shot.width}×${shot.height} px (viewport ${shot.viewport.width}×${shot.viewport.height}, skala ${shot.scale.toFixed(3)})\n` +
                    `URL: ${page.url()}\nKoordinat untuk click_at/scroll_at/drag/move memakai piksel gambar ini.`,
                },
                { type: "image", data: shot.data, mimeType: "image/jpeg" },
              ],
            };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "click_at",
        "Klik di titik (x, y) pada gambar `view` terakhir. Panggil `view` dulu dan sesudah halaman berubah — titik dari gambar lama bisa sudah menunjuk elemen lain. " +
          "Hasilnya menyebut elemen yang kena; kalau bukan yang dimaksud, lihat lagi dengan `view`.",
        {
          x: z.number().min(0).describe("piksel horizontal pada gambar view"),
          y: z.number().min(0).describe("piksel vertikal pada gambar view"),
          button: z.enum(["left", "right", "middle"]).optional().describe("bawaan left"),
          double: z.boolean().optional().describe("klik ganda"),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const point = fromView(page, args.x, args.y);
            const { value: target, report } = await session.act(page, async () => {
              const target = await describeAt(page, point.x, point.y);
              announce({ kind: "click", label: `Mengklik ${named(target, `titik (${args.x}, ${args.y})`)}`, point, box: target?.box });
              await page.mouse.click(point.x, point.y, { button: args.button ?? "left", clickCount: args.double ? 2 : 1 });
              return target;
            });
            return ok(
              [`Diklik di (${args.x}, ${args.y}) → ${target ? `“${target.name}”` : "(tidak ada elemen)"}`, `URL sekarang: ${page.url()}`, ...report].join("\n"),
            );
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "type_text",
        "Ketik teks ke elemen yang sedang fokus (klik dulu field-nya dengan click_at atau click). Mengetik per karakter seperti manusia, jadi event keydown/input ikut terpicu. " +
          "Untuk Enter/Tab/Escape pakai `press`.",
        { text: z.string().max(5_000) },
        async (args) => {
          try {
            const page = session.requirePage();
            const { value: typed, report } = await session.act(
              page,
              async () => {
                const focused = await describeFocused(page);
                announce({
                  kind: "fill",
                  label: `Mengetik di ${named(focused, "halaman")}`,
                  box: focused?.box,
                  text: focused && !focused.secret ? args.text.slice(0, 120) : "••••••",
                });
                await page.keyboard.type(args.text);
                const suggest = await page
                  .evaluate(() => {
                    const el = document.activeElement;
                    const autocomplete = el?.getAttribute("aria-autocomplete") ?? "";
                    return Boolean(el && (el.getAttribute("role") === "combobox" || el.hasAttribute("list") || autocomplete === "list" || autocomplete === "both"));
                  })
                  .catch(() => false);
                return { focused, suggest };
              },
              { settle: (typed) => (typed.suggest ? SETTLE_SUGGEST : SETTLE_LIGHT) },
            );
            return ok([`Diketik ${[...args.text].length} karakter ke ${named(typed.focused, "elemen yang fokus")}`, ...report].join("\n"));
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "scroll_at",
        "Gulung roda mouse di titik (x, y) pada gambar `view` — menggulung container yang ada di bawah titik itu. dx/dy dalam piksel gambar (dy positif = ke bawah).",
        {
          x: z.number().min(0),
          y: z.number().min(0),
          dx: z.number().optional(),
          dy: z.number().optional(),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const point = fromView(page, args.x, args.y);
            const scale = viewScale(page.viewportSize()!);
            const target = await describeAt(page, point.x, point.y);
            announce({ kind: "scroll", label: `Menggulung ${named(target, "halaman")}`, point, box: target?.box });
            await page.mouse.move(point.x, point.y);
            await page.mouse.wheel((args.dx ?? 0) / scale, (args.dy ?? 0) / scale);
            await page.waitForTimeout(250);
            return ok(`Digulung di (${args.x}, ${args.y}) sebesar (${args.dx ?? 0}, ${args.dy ?? 0}) px gambar. Panggil view untuk melihat hasilnya.`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "drag",
        "Seret dari satu titik ke titik lain pada gambar `view` (slider, drag & drop, menggambar di canvas).",
        { from: pointSchema, to: pointSchema },
        async (args) => {
          try {
            const page = session.requirePage();
            const start = fromView(page, args.from.x, args.from.y);
            const end = fromView(page, args.to.x, args.to.y);
            const { report } = await session.act(page, async () => {
              const source = await describeAt(page, start.x, start.y);
              announce({ kind: "click", label: `Menyeret ${named(source, "titik")} ke (${args.to.x}, ${args.to.y})`, point: end });
              await page.mouse.move(start.x, start.y);
              await page.mouse.down();
              await page.mouse.move(end.x, end.y, { steps: 15 });
              await page.mouse.up();
            });
            return ok(
              [`Diseret dari (${args.from.x}, ${args.from.y}) → (${args.to.x}, ${args.to.y}). Panggil view untuk melihat posisinya.`, ...report].join("\n"),
            );
          } catch (error) {
            return fail(failureText(error));
          }
        },
      ),
      tool(
        "move",
        "Pindahkan kursor ke titik (x, y) pada gambar `view` tanpa mengklik (tooltip, menu hover).",
        { x: z.number().min(0), y: z.number().min(0) },
        async (args) => {
          try {
            const page = session.requirePage();
            const point = fromView(page, args.x, args.y);
            const target = await describeAt(page, point.x, point.y);
            announce({ kind: "hover", label: `Mengarahkan kursor ke ${named(target, "titik")}`, point, box: target?.box });
            await page.mouse.move(point.x, point.y);
            return ok(`Kursor di (${args.x}, ${args.y}) → ${target ? `“${target.name}”` : "(tidak ada elemen)"}`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool("close", "Tutup browser dan bebaskan resource.", {}, async () => {
        await session.close();
        return ok("Browser ditutup.");
      }),
    ]),
  });
}
