import type { Locator, Page, Request } from "playwright";

/**
 * Hasil sebuah aksi browser untuk agen: menunggu halaman tenang, lalu melaporkan apa yang berubah.
 * Idenya dari browser-use (pemeriksaan request yang masih berjalan, penanda elemen baru sejak
 * langkah sebelumnya); di sini dibangun di atas snapshot AI Playwright, yang memberi setiap elemen
 * ref yang tetap sama antar-snapshot.
 */

/** `undefined` kalau `promise` tidak selesai dalam `ms`. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 1234 → "1,2 s". */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------- menunggu halaman tenang ----------

export type SettleOptions = {
  /** Lama tanpa request relevan yang berjalan. */
  quietMs: number;
  /** Lama DOM tanpa mutasi. */
  domQuietMs: number;
  maxMs: number;
};

/** Klik, Enter, pilih opsi, drag: bisa memicu request dan render ulang. */
export const SETTLE_FULL: SettleOptions = { quietMs: 300, domQuietMs: 150, maxMs: 5_000 };
/** Mengisi, mengetik, hover: biasanya hanya validasi atau saran yang muncul. */
export const SETTLE_LIGHT: SettleOptions = { quietMs: 150, domQuietMs: 100, maxMs: 2_000 };
/**
 * Mengisi field autocomplete: sarannya diambil setelah debounce (umumnya 250–500 ms), jadi jeda
 * tenang jaringan harus lebih panjang dari debounce itu supaya request sarannya sempat tertangkap.
 */
export const SETTLE_SUGGEST: SettleOptions = { quietMs: 600, domQuietMs: 200, maxMs: 4_000 };
/**
 * Hover: tooltip dan menu sering sengaja ditunda (300–700 ms; tooltip Radix 700 ms). Jeda DOM diam
 * harus lebih panjang dari tundaan itu — kalau tidak, hasilnya "tidak ada perubahan" padahal
 * tooltip-nya muncul sesaat kemudian, dan agen bisa melaporkan temuan palsu.
 */
export const SETTLE_HOVER: SettleOptions = { quietMs: 300, domQuietMs: 500, maxMs: 3_000 };
/** Membuka halaman: SPA masih mengambil data setelah dokumennya selesai. */
export const SETTLE_OPEN: SettleOptions = { quietMs: 300, domQuietMs: 150, maxMs: 8_000 };

/**
 * `pending`: request yang masih ditunggu saat batas waktu habis. `lingering`: request yang tidak
 * ditunggu karena sudah menggantung lama sementara selebihnya tenang (long-polling, proses lama).
 */
export type SettleResult = { ms: number; settled: boolean; pending: string[]; lingering?: string[] };

/** Request yang menandakan halaman masih bekerja. Gambar, font, media, dan koneksi panjang tidak ditunggu. */
const BUSY_TYPES = new Set(["document", "xhr", "fetch", "script", "stylesheet"]);
/** Telemetri pihak ketiga: tidak mengubah halaman, dan sebagian terus mengirim selama halaman terbuka. */
const BACKGROUND_URL =
  /google-analytics\.com|googletagmanager\.com|doubleclick\.net|clarity\.ms|hotjar\.|sentry\.io|nr-data\.net|datadoghq\.|segment\.(io|com)|mixpanel\.com|amplitude\.com|posthog\.com|logrocket\.|fullstory\.com|facebook\.com\/tr/i;
/**
 * Request yang masih menggantung selama ini sementara jaringan selebihnya tenang dianggap
 * long-polling, streaming, atau proses lama: tidak ditunggu lagi, tetapi disebut di hasil.
 * Tanpa ini halaman ber-long-poll membuat setiap `open` habis sampai batas 8 s.
 */
const LINGER_MS = 3_000;
const FORGET_MS = 60_000;

/**
 * Dijalankan DI halaman: selesai saat DOM tidak berubah selama `quietMs` (true) atau saat batas
 * `maxMs` tercapai sementara DOM masih terus berubah (false).
 */
function domQuiet([quietMs, maxMs]: [number, number]): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver((records) => {
      // Animasi JS (marquee, carousel, framer-motion, transisi grafik SVG) mengubah style atau
      // atribut SVG di setiap frame. Itu bukan perubahan isi, dan menunggunya membuat setiap aksi
      // di halaman seperti itu habis sampai batas waktu.
      const animation = records.every(
        (record) => record.type === "attributes" && (record.attributeName === "style" || record.target instanceof SVGElement),
      );
      if (animation) return;
      clearTimeout(timer);
      timer = setTimeout(() => finish(true), quietMs);
    });
    const cap = setTimeout(() => finish(false), maxMs);
    function finish(quiet: boolean): void {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve(quiet);
    }
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(() => finish(true), quietMs);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Request jaringan yang belum selesai di satu halaman. */
export class NetworkTracker {
  private readonly pending = new Map<Request, number>();
  private lastChange = 0;

  attach(page: Page): void {
    page.on("request", (request) => {
      if (!BUSY_TYPES.has(request.resourceType()) || BACKGROUND_URL.test(request.url())) return;
      this.pending.set(request, Date.now());
      this.lastChange = Date.now();
    });
    const done = (request: Request): void => {
      if (this.pending.delete(request)) this.lastChange = Date.now();
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  }

  /** Request yang masih berjalan dan dimulai sejak `since`. */
  private busy(now: number, since: number): Array<[Request, number]> {
    const list: Array<[Request, number]> = [];
    for (const [request, started] of this.pending) {
      if (now - started > FORGET_MS) this.pending.delete(request);
      else if (started >= since) list.push([request, started]);
    }
    return list;
  }

  /**
   * Tunggu sampai tidak ada request relevan selama `quietMs`, lalu DOM diam selama `domQuietMs`.
   * Jeda tenang dihitung mulai sekarang, jadi request yang dipicu sedikit terlambat (debounce,
   * setTimeout) tetap tertangkap. Navigasi di tengah jalan diukur ulang di dokumen yang baru.
   * Hanya request yang dimulai sejak `since` (awal aksi) yang ditunggu: long-polling atau request
   * lambat dari aksi sebelumnya bukan akibat aksi ini.
   */
  async settle(page: Page, options: SettleOptions, since?: number): Promise<SettleResult> {
    const start = Date.now();
    const from = since ?? start;
    const deadline = start + options.maxMs;
    this.lastChange = Math.max(this.lastChange, start);
    for (let round = 0; round < 3; round += 1) {
      let lingering: string[] = [];
      for (;;) {
        const now = Date.now();
        const busy = this.busy(now, from);
        const waiting = busy.filter(([, started]) => now - started < LINGER_MS);
        if (waiting.length === 0 && now - this.lastChange >= options.quietMs) {
          lingering = describePending(busy, now, page);
          break;
        }
        if (now >= deadline) return { ms: now - start, settled: false, pending: describePending(busy, now, page) };
        await sleep(25);
      }
      const left = deadline - Date.now();
      if (left <= 0) return { ms: Date.now() - start, settled: false, pending: lingering };
      try {
        const quiet = await page.evaluate(domQuiet, [options.domQuietMs, left] as [number, number]);
        return { ms: Date.now() - start, settled: quiet, pending: [], ...(lingering.length > 0 ? { lingering } : {}) };
      } catch {
        if (page.isClosed()) return { ms: Date.now() - start, settled: true, pending: [] };
        await page
          .waitForLoadState("domcontentloaded", { timeout: Math.max(1, deadline - Date.now()) })
          .catch(() => undefined);
      }
    }
    return { ms: Date.now() - start, settled: false, pending: [] };
  }
}

function describePending(busy: Array<[Request, number]>, now: number, page: Page): string[] {
  let origin = "";
  try {
    origin = new URL(page.url()).origin;
  } catch {
    // halaman kosong
  }
  return busy
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([request, since]) => {
      let where = request.url();
      try {
        const url = new URL(where);
        where = url.origin === origin ? `${url.pathname}${url.search}` : `${url.host}${url.pathname}`;
      } catch {
        // URL aneh: tampilkan apa adanya
      }
      return `${request.method()} ${clip(where, 80)} (${seconds(now - since)})`;
    });
}

/** "tenang setelah 0,5 s" — dipakai di tengah kalimat. */
export function formatSettle(result: SettleResult): string {
  const lingering = result.lingering?.length ? `, kecuali request yang masih berjalan lama: ${result.lingering.join(", ")}` : "";
  if (result.settled) return `tenang setelah ${seconds(result.ms)}${lingering}`;
  if (result.pending.length > 0) return `belum tenang setelah ${seconds(result.ms)} — masih menunggu ${result.pending.join(", ")}`;
  return `masih berubah setelah ${seconds(result.ms)} (animasi atau polling) — tunggu dengan wait({ text }) bila perlu`;
}

// ---------- tab baru ----------

export type PopupRecord = { seq: number; url: string; title: string; done: Promise<void> };

/**
 * Tab yang dibuka halaman (target=_blank, window.open). Tool hanya bekerja di tab utama, jadi tab
 * baru dicatat alamatnya lalu ditutup — agen membukanya dengan `open` bila perlu diuji. Tanpa ini
 * tab itu tak terlihat agen dan terus memakan CPU.
 */
export class PopupTracker {
  private records: PopupRecord[] = [];
  private seq = 0;

  attach(page: Page): void {
    page.on("popup", (popup) => this.capture(popup));
  }

  count(): number {
    return this.seq;
  }

  private capture(popup: Page): void {
    this.seq += 1;
    const record: PopupRecord = { seq: this.seq, url: popup.url(), title: "", done: Promise.resolve() };
    popup.on("request", (request) => {
      try {
        if (request.isNavigationRequest() && request.frame() === popup.mainFrame()) record.url = request.url();
      } catch {
        // request tanpa frame (service worker)
      }
    });
    record.done = (async () => {
      await popup.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      const url = popup.url();
      if (url && url !== "about:blank") record.url = url;
      record.title = (await within(popup.title().catch(() => ""), 1_000)) ?? "";
      await popup.close().catch(() => undefined);
    })();
    this.records.push(record);
    if (this.records.length > 20) this.records.shift();
  }

  /** Tab baru sejak `seq`, setelah ditunggu sebentar supaya alamat dan judulnya diketahui. */
  async since(seq: number, waitMs = 2_000): Promise<PopupRecord[]> {
    const fresh = this.records.filter((record) => record.seq > seq);
    if (fresh.length > 0) await within(Promise.all(fresh.map((record) => record.done)), waitMs);
    return fresh;
  }
}

// ---------- snapshot ----------

export type Snapshot = { text: string; ms: number };

/** Di atas ini ringkasan perubahan dimatikan untuk halaman itu: biayanya mulai terasa di setiap aksi. */
const HEAVY_MS = 700;
const HEAVY_CHARS = 200_000;

export function isHeavy(snapshot: Snapshot): boolean {
  return snapshot.ms > HEAVY_MS || snapshot.text.length > HEAVY_CHARS;
}

/** Nilai field password di semua frame — snapshot aria Playwright menuliskannya apa adanya. */
export async function passwordValues(page: Page): Promise<string[]> {
  const values = new Set<string>();
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate(() =>
        Array.from(document.querySelectorAll("input[type=password]"), (el) => (el as HTMLInputElement).value).filter(Boolean),
      )
      .catch(() => [] as string[]);
    for (const value of found) values.add(value);
  }
  return [...values];
}

const MASK = "••••••";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Samarkan nilai password di teks snapshot. Nilai pendek (< 4 karakter) hanya disamarkan di posisi
 * nilai textbox, supaya huruf yang sama di tempat lain tidak ikut hilang.
 */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      if (!form) continue;
      if (form.length >= 4) out = out.split(form).join(MASK);
      else out = out.replace(new RegExp(`(textbox\\b[^\\n]*: )"?${escapeRegExp(form)}"?$`, "gm"), `$1${MASK}`);
    }
  }
  return out;
}

/**
 * Snapshot AI halaman (atau satu bagiannya) dengan password disamarkan. Nilai password dibaca
 * sebelum DAN sesudah snapshot: field yang berubah di antaranya tetap tidak lolos.
 */
export async function secretSnapshot(page: Page, target: Page | Locator, timeout: number): Promise<{ text: string; ms: number }> {
  const early = await passwordValues(page);
  const start = Date.now();
  const text = await target.ariaSnapshot({ mode: "ai", timeout });
  const ms = Date.now() - start;
  const late = await passwordValues(page);
  return { text: redact(text, [...new Set([...early, ...late])]), ms };
}

/** Snapshot AI seluruh halaman, dengan password disamarkan. `undefined` kalau gagal — tidak pernah melempar. */
export async function takeSnapshot(page: Page, timeout = 5_000): Promise<Snapshot | undefined> {
  try {
    return await secretSnapshot(page, page, timeout);
  } catch {
    return undefined;
  }
}

/** "gulir 0 dari 1.600 px — ±1,6 layar lagi di bawah". */
export async function scrollInfo(page: Page): Promise<string | undefined> {
  const metrics = await page
    .evaluate(() => ({ y: scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight }))
    .catch(() => undefined);
  if (!metrics || metrics.viewport <= 0) return undefined;
  const room = metrics.height - metrics.viewport;
  if (room <= 1) return "seluruh halaman muat di layar";
  const fmt = (value: number) => value.toFixed(1).replace(".", ",");
  const above = metrics.y / metrics.viewport;
  const below = Math.max(0, room - metrics.y) / metrics.viewport;
  return `gulir ${Math.round(metrics.y)} dari ${room} px — ±${fmt(above)} layar di atas, ±${fmt(below)} layar di bawah`;
}

// ---------- membaca snapshot ----------

const REF_IN_LINE = /\[ref=([^\]\s]+)\]/;
const QUOTED = /"(?:[^"\\]|\\.)*"/;
const FIELD_ROLES = /^(textbox|searchbox|combobox|spinbutton)\b/;

/** Satu baris snapshot sebagai teks ringkas: tanpa "- ", [active], ref, cursor, dan ":" penutup. */
function describeLine(line: string): string {
  const text = line
    .trim()
    .replace(/^- /, "")
    .replace(/ \[active\]/g, "")
    .replace(/\s*\[(?:ref|cursor)=[^\]]*\]/g, "")
    .replace(/:$/, "");
  const valued = text.match(/^(.*?):\s(.*)$/);
  if (!valued) return clip(text, 80);
  const [, head = "", value = ""] = valued;
  return FIELD_ROLES.test(head) ? clip(head, 80) : clip(`${head}: ${value}`, 80);
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Nama elemen ber-ref dari snapshot, plus konteks yang membedakannya dari kembarannya:
 * `button "Edit" (baris "Sari")`. `undefined` kalau ref tidak ada di snapshot.
 */
export function refName(text: string | undefined, ref: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes(`[ref=${ref}]`));
  if (at < 0) return undefined;
  const name = describeLine(lines[at]!);
  let indent = indentOf(lines[at]!);
  for (let i = at - 1; i >= 0 && indent > 0; i -= 1) {
    const line = lines[i]!;
    const lineIndent = indentOf(line);
    if (lineIndent >= indent) continue;
    indent = lineIndent;
    const trimmed = line.trim();
    if (/^- row\b/.test(trimmed)) {
      // Baris tabel: sel pertama yang bernama biasanya pengenal barisnya.
      for (let j = i + 1; j < lines.length && indentOf(lines[j]!) > lineIndent; j += 1) {
        const cell = lines[j]!.trim().match(/^- (?:cell|gridcell|rowheader) ("(?:[^"\\]|\\.)*")/);
        if (cell?.[1] && j !== at) return `${name} (baris ${clip(cell[1], 50)})`;
      }
      continue;
    }
    const named = trimmed.match(
      /^- (listitem|dialog|alertdialog|form|region|article|group|tabpanel|menu|navigation) ("(?:[^"\\]|\\.)*")/,
    );
    if (named) return `${name} (dalam ${named[1]} ${clip(named[2]!, 50)})`;
  }
  return name;
}

/**
 * Elemen yang sedang fokus menurut snapshot (penanda `[active]`), untuk hasil `press` — audit
 * keyboard (Tab/Shift+Tab) bisa membaca urutan fokus tanpa screenshot di setiap langkah. Baris
 * `[active]` terakhir adalah yang terdalam: di dalam iframe, elemen fokus ada setelah baris iframe-nya.
 */
export function focusedElement(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text
    .split("\n")
    .filter((candidate) => candidate.includes("[active]"))
    .at(-1);
  if (!line) return undefined;
  if (indentOf(line) === 0) return "Fokus sekarang: tidak di elemen mana pun (halaman).";
  const ref = line.match(REF_IN_LINE)?.[1];
  return `Fokus sekarang: ${ref ? `${refName(text, ref) ?? describeLine(line)} [${ref}]` : describeLine(line)}`;
}

/** Ringkasan halaman setelah pindah halaman atau open: heading dan jumlah elemen interaktif. */
export function pageOverview(text: string): string {
  const headings: string[] = [];
  let links = 0;
  let buttons = 0;
  let fields = 0;
  let refs = 0;
  for (const line of text.split("\n")) {
    if (line.includes("[ref=")) refs += 1;
    const heading = line.match(/- heading ("(?:[^"\\]|\\.)*") \[level=(\d)\]/);
    if (heading && Number(heading[2]) <= 3 && headings.length < 6) headings.push(`H${heading[2]} ${clip(heading[1]!, 60)}`);
    if (/^\s*- link\b/.test(line)) links += 1;
    else if (/^\s*- button\b/.test(line)) buttons += 1;
    else if (/^\s*- (textbox|searchbox|combobox|checkbox|radio|spinbutton|slider|switch|listbox)\b/.test(line)) fields += 1;
  }
  if (refs <= 2 && headings.length === 0 && links + buttons + fields === 0) {
    return 'Halaman tampak kosong — mungkin masih memuat. Tunggu dengan wait({ text: "…" }) atau panggil snapshot lagi.';
  }
  return `Isi: ${headings.length > 0 ? `${headings.join(" · ")} — ` : ""}${links} tautan, ${buttons} tombol, ${fields} field. Panggil snapshot untuk ref-nya.`;
}

// ---------- perubahan antar-snapshot ----------

type Entry = { index: number; indent: number; text: string; ref?: string; owner?: string };
type Node = { entry: Entry; parent?: string; own: string[]; end: number };

function parse(text: string): Entry[] {
  const entries: Entry[] = [];
  const stack: Array<{ indent: number; ref?: string }> = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const indent = indentOf(raw);
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    let owner: string | undefined;
    for (let i = stack.length - 1; i >= 0 && !owner; i -= 1) owner = stack[i]!.ref;
    const ref = raw.match(REF_IN_LINE)?.[1];
    // [active] hanya menandai fokus, dan ":" penutup hanya menandai elemen yang punya isi —
    // berpindahnya fokus atau bertambahnya anak pertama bukan perubahan elemen itu sendiri.
    const line = raw.trim().replace(/^- /, "").replace(/ \[active\]/g, "").replace(/:$/, "");
    entries.push({ index: entries.length, indent, text: line, ref, owner });
    stack.push({ indent, ref });
  }
  return entries;
}

/** Elemen ber-ref, masing-masing dengan baris tanpa ref yang menjadi isinya sendiri (teks, opsi, /url). */
function nodesOf(entries: Entry[]): Map<string, Node> {
  const nodes = new Map<string, Node>();
  entries.forEach((entry, i) => {
    if (!entry.ref) {
      if (entry.owner) nodes.get(entry.owner)?.own.push(entry.text);
      return;
    }
    let end = i + 1;
    while (end < entries.length && entries[end]!.indent > entry.indent) end += 1;
    nodes.set(entry.ref, { entry, parent: entry.owner, own: [], end });
  });
  return nodes;
}

/** Jumlah ref yang ada di kedua snapshot. Nol berarti dokumennya berganti (navigasi atau muat ulang). */
export function sharedRefCount(beforeText: string, afterText: string): number {
  const refs = (text: string) => new Set(Array.from(text.matchAll(/\[ref=([^\]\s]+)\]/g), (match) => match[1]));
  const before = refs(beforeText);
  let shared = 0;
  for (const ref of refs(afterText)) if (before.has(ref)) shared += 1;
  return shared;
}

export type Change = { kind: "+" | "~" | "−"; lines: string[]; order: number };

const ADDED_CHILD_LINES = 8;
const CHANGED_CHILD_LINES = 4;

/** Baris elemen tanpa ref, kursor, dan isinya: `paragraph [ref=e38]: "Hasil: 3"` → `paragraph`. */
function bareLine(text: string): string {
  const plain = text.replace(/ \[ref=[^\]]+\]/g, "").replace(/ \[cursor=pointer\]/g, "");
  let quoted = false;
  for (let i = 0; i < plain.length; i += 1) {
    const char = plain[i];
    if (char === "\\") i += 1;
    else if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) return plain.slice(0, i).trimEnd();
  }
  return plain;
}

/** Ambil satu kemunculan `item` dari `list`; true kalau ada. */
function take(list: string[], item: string): boolean {
  const at = list.indexOf(item);
  if (at < 0) return false;
  list.splice(at, 1);
  return true;
}

/** Baris isi sendiri yang baru dan yang hilang (multiset — baris kembar dihitung masing-masing). */
function ownDelta(old: string[], now: string[]): { added: string[]; removed: string[] } {
  const removed = [...old];
  const added = now.filter((line) => !take(removed, line));
  return { added, removed };
}

/**
 * Perubahan antara dua snapshot AI, dicocokkan per ref (ref elemen yang sama tetap sama antar-snapshot):
 * `+` elemen baru teratas beserta isinya, `~` elemen yang barisnya atau teks/opsinya berubah,
 * `−` elemen teratas yang hilang. Murni — tanpa browser.
 */
export function diffSnapshots(beforeText: string, afterText: string): Change[] {
  const afterEntries = parse(afterText);
  const before = nodesOf(parse(beforeText));
  const after = nodesOf(afterEntries);

  const added = new Set([...after.keys()].filter((ref) => !before.has(ref)));
  const removed = new Set([...before.keys()].filter((ref) => !after.has(ref)));

  // Elemen kosong (paragraf hasil, listbox saran) belum punya ref dan tampil sebagai baris biasa di
  // induknya; begitu berisi ia mendapat ref, dan kehilangannya lagi saat kosong. Baris lama di induk
  // itu bukan perubahan tersendiri — elemennya sudah tercantum sebagai + atau −.
  const headsByParent = (refs: Set<string>, nodes: Map<string, Node>): Map<string, string[]> => {
    const heads = new Map<string, string[]>();
    for (const ref of refs) {
      const node = nodes.get(ref)!;
      if (!node.parent) continue;
      heads.set(node.parent, [...(heads.get(node.parent) ?? []), bareLine(node.entry.text)]);
    }
    return heads;
  };
  const promoted = headsByParent(added, after);
  const demoted = headsByParent(removed, before);
  const deltas = new Map<string, { added: string[]; removed: string[] }>();
  for (const [ref, node] of after) {
    const old = before.get(ref);
    if (!old) continue;
    const delta = ownDelta(old.own, node.own);
    const gained = [...(promoted.get(ref) ?? [])];
    const lost = [...(demoted.get(ref) ?? [])];
    delta.removed = delta.removed.filter((line) => !take(gained, bareLine(line)));
    delta.added = delta.added.filter((line) => !take(lost, bareLine(line)));
    if (old.entry.text !== node.entry.text || delta.added.length > 0 || delta.removed.length > 0) deltas.set(ref, delta);
  }
  const changed = new Set(deltas.keys());

  // Leluhur yang namanya ikut berubah hanya karena isi turunannya berubah (row "Budi … aktif" saat
  // sel "aktif" berganti) tidak dilaporkan: perubahannya sudah tampak di turunan itu.
  const aboveChange = new Set<string>();
  const climb = (nodes: Map<string, Node>, ref: string): void => {
    let parent = nodes.get(ref)?.parent;
    while (parent && !aboveChange.has(parent)) {
      aboveChange.add(parent);
      parent = nodes.get(parent)?.parent;
    }
  };
  for (const ref of added) climb(after, ref);
  for (const ref of changed) climb(after, ref);
  for (const ref of removed) climb(before, ref);
  const withoutName = (text: string) => text.replace(QUOTED, '""');
  for (const ref of [...changed]) {
    const old = before.get(ref)!;
    const node = after.get(ref)!;
    const delta = deltas.get(ref)!;
    const sameOwn = delta.added.length === 0 && delta.removed.length === 0;
    if (aboveChange.has(ref) && sameOwn && withoutName(old.entry.text) === withoutName(node.entry.text)) changed.delete(ref);
  }

  const changes: Change[] = [];
  for (const ref of added) {
    const node = after.get(ref)!;
    if (node.parent && added.has(node.parent)) continue;
    const lines = [node.entry.text];
    const children = afterEntries.slice(node.entry.index + 1, node.end);
    for (const child of children.slice(0, ADDED_CHILD_LINES)) {
      lines.push(`${"  ".repeat(Math.max(1, (child.indent - node.entry.indent) / 2))}- ${child.text}`);
    }
    if (children.length > ADDED_CHILD_LINES) lines.push(`  … ${children.length - ADDED_CHILD_LINES} baris lagi`);
    changes.push({ kind: "+", lines, order: node.entry.index });
  }
  for (const ref of changed) {
    const node = after.get(ref)!;
    const { added: fresh, removed: gone } = deltas.get(ref)!;
    const lines = [node.entry.text];
    // Isi barunya cukup (opsi yang kini [selected], teks yang berganti); isi yang hilang ditampilkan
    // hanya bila tidak ada penggantinya — mis. pesan galat berupa teks lepas yang lenyap.
    for (const line of fresh.slice(0, CHANGED_CHILD_LINES)) lines.push(`  - ${line}`);
    if (fresh.length === 0) for (const line of gone.slice(0, CHANGED_CHILD_LINES)) lines.push(`  − ${line}`);
    changes.push({ kind: "~", lines, order: node.entry.index });
  }
  for (const ref of removed) {
    const node = before.get(ref)!;
    if (node.parent && removed.has(node.parent)) continue;
    changes.push({ kind: "−", lines: [node.entry.text], order: 1_000_000_000 + node.entry.index });
  }
  return changes.sort((a, b) => a.order - b.order);
}

/** Daftar perubahan yang dibatasi panjangnya; sisanya disebut jumlahnya saja. */
export function formatChanges(changes: Change[], maxLines = 40, maxChars = 3_000): { text: string; omitted: number } {
  const out: string[] = [];
  let chars = 0;
  let shown = 0;
  for (const change of changes) {
    const block = change.lines.map((line, i) => clip(i === 0 ? `${change.kind} ${line}` : `  ${line}`, 200));
    const size = block.reduce((sum, line) => sum + line.length + 1, 0);
    if (shown > 0 && (out.length + block.length > maxLines || chars + size > maxChars)) break;
    out.push(...block.slice(0, maxLines));
    chars += size;
    shown += 1;
  }
  const omitted = changes.length - shown;
  if (omitted > 0) out.push(`… ${omitted} perubahan lain — panggil snapshot untuk melihat semuanya`);
  return { text: out.join("\n"), omitted };
}
