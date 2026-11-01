/**
 * Operasi halaman yang butuh diperiksa di dalam DOM: scroll, inspeksi overflow, baca teks.
 * Dipisah dari `mcp.ts` supaya bisa diuji tanpa menjalankan agen (`npm run check:browser`).
 */
import type { Page } from "playwright";

export type ScrollerInfo = {
  name: string;
  clientWidth: number;
  scrollWidth: number;
  clientHeight: number;
  scrollHeight: number;
  overflowX: string;
  overflowY: string;
  scrollableX: boolean;
  scrollableY: boolean;
  maxLeft: number;
  maxTop: number;
};

export type ScrollReport = {
  /** Selector yang diminta, atau "dokumen" kalau tidak ada. */
  target: string;
  /** Elemen yang benar-benar menggulung — sering kali nenek-moyang dari target. */
  scroller: string;
  left: number;
  maxLeft: number;
  top: number;
  maxTop: number;
};

export type ElementReport = {
  name: string;
  box: { x: number; y: number; width: number; height: number };
  clientWidth: number;
  scrollWidth: number;
  clientHeight: number;
  scrollHeight: number;
  overflowX: string;
  overflowY: string;
  whiteSpace: string;
  textOverflow: string;
  /** Elemen ini sendiri bisa digulung (overflow auto|scroll + isinya lebih besar). */
  scrollableX: boolean;
  scrollableY: boolean;
  /** Isinya lebih besar tapi overflow-nya `hidden` — hanya bisa digulung lewat JS. */
  hiddenOverflowX: boolean;
  hiddenOverflowY: boolean;
  clippedByEllipsis: boolean;
  /** Scroller terdekat ke atas, kalau elemen ini bukan scroller-nya sendiri. */
  scroller?: ScrollerInfo;
  text: string;
};

type ProbeArgs = {
  mode: "scroll" | "inspect" | "text";
  selector?: string;
  dx?: number;
  dy?: number;
  to?: "left" | "right" | "top" | "bottom";
  limit?: number;
};

type ProbeResult =
  | { kind: "scroll"; report: ScrollReport }
  | { kind: "inspect"; reports: ElementReport[] }
  | { kind: "text"; texts: string[]; total: number }
  | { kind: "error"; message: string };

/**
 * Satu-satunya tempat logika DOM ditulis; dijalankan di dalam halaman.
 * Semua mode memakai pencari scroller yang sama supaya hasil `scroll` dan `inspect` konsisten.
 */
function probe(args: ProbeArgs): ProbeResult {
  const name = (el: Element): string => {
    const id = el.id ? `#${el.id}` : "";
    const className = typeof el.className === "string" ? el.className.trim() : "";
    const cls = className ? `.${className.split(/\s+/).slice(0, 2).join(".")}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  /**
   * Teks elemen. `innerText` dipakai lebih dulu karena ia menyisipkan pemisah antar sel/baris
   * (tab jadi " | ") dan tetap memuat teks yang hanya terpotong secara visual.
   */
  const textOf = (el: Element): string => {
    const inner = el instanceof HTMLElement ? el.innerText : "";
    const raw = inner.trim() ? inner : (el.textContent ?? "");
    return raw.replace(/\t/g, " | ").replace(/\s+/g, " ").trim().slice(0, 2_000);
  };

  const overflows = (el: Element, axis: "x" | "y"): boolean =>
    axis === "x" ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1;

  const canScroll = (el: Element, axis: "x" | "y"): boolean => {
    const style = getComputedStyle(el);
    const overflow = axis === "x" ? style.overflowX : style.overflowY;
    return /(auto|scroll)/.test(overflow) && overflows(el, axis);
  };

  const root = (): Element => document.scrollingElement ?? document.documentElement;

  /** Naik dari elemen target sampai ketemu yang benar-benar menggulung. */
  const findScroller = (el: Element): Element => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (canScroll(node, "x") || canScroll(node, "y")) return node;
    }
    return root();
  };

  const describeScroller = (el: Element): ScrollerInfo => {
    const style = getComputedStyle(el);
    return {
      name: name(el),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollableX: canScroll(el, "x"),
      scrollableY: canScroll(el, "y"),
      maxLeft: Math.max(0, el.scrollWidth - el.clientWidth),
      maxTop: Math.max(0, el.scrollHeight - el.clientHeight),
    };
  };

  if (args.mode === "scroll") {
    const target = args.selector ? document.querySelector(args.selector) : null;
    if (args.selector && !target) return { kind: "error", message: `tidak ada elemen ${args.selector}` };
    const el = target ? findScroller(target) : root();

    if (args.to === "left") el.scrollLeft = 0;
    if (args.to === "right") el.scrollLeft = el.scrollWidth;
    if (args.to === "top") el.scrollTop = 0;
    if (args.to === "bottom") el.scrollTop = el.scrollHeight;
    if (args.dx) el.scrollLeft += args.dx;
    if (args.dy) el.scrollTop += args.dy;

    return {
      kind: "scroll",
      report: {
        target: target ? name(target) : "dokumen",
        scroller: name(el),
        left: Math.round(el.scrollLeft),
        maxLeft: Math.max(0, el.scrollWidth - el.clientWidth),
        top: Math.round(el.scrollTop),
        maxTop: Math.max(0, el.scrollHeight - el.clientHeight),
      },
    };
  }

  if (!args.selector) return { kind: "error", message: "butuh `selector`" };
  const all = Array.from(document.querySelectorAll(args.selector));
  if (all.length === 0) return { kind: "error", message: `tidak ada elemen ${args.selector}` };

  if (args.mode === "text") {
    const limit = args.limit ?? 20;
    return {
      kind: "text",
      total: all.length,
      texts: all.slice(0, limit).map(textOf),
    };
  }

  const limit = args.limit ?? 3;
  const reports = all.slice(0, limit).map((el): ElementReport => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const scroller = findScroller(el);
    return {
      name: name(el),
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      scrollableX: canScroll(el, "x"),
      scrollableY: canScroll(el, "y"),
      hiddenOverflowX: style.overflowX === "hidden" && overflows(el, "x"),
      hiddenOverflowY: style.overflowY === "hidden" && overflows(el, "y"),
      clippedByEllipsis: style.textOverflow === "ellipsis" && overflows(el, "x"),
      scroller: scroller === el ? undefined : describeScroller(scroller),
      text: textOf(el),
    };
  });

  return { kind: "inspect", reports };
}

/**
 * tsx/esbuild memakai `keepNames`, jadi fungsi yang diserialisasi ke dalam halaman
 * memuat pemanggilan helper `__name` yang tidak ada di browser. Sediakan helper itu
 * lebih dulu (sebagai string, supaya tidak ikut ditransformasi) setiap kali dipakai —
 * nilainya hilang tiap kali halaman bernavigasi.
 */
const ESBUILD_SHIM = "globalThis.__name = globalThis.__name || ((fn) => fn);";

async function run(page: Page, args: ProbeArgs): Promise<ProbeResult> {
  await page.evaluate(ESBUILD_SHIM);
  return await page.evaluate(probe, args);
}

/**
 * Gulung halaman atau container. Tanpa `to`/`dx`/`dy` ia hanya melaporkan posisi sekarang,
 * jadi bisa dipakai untuk bertanya "masih ada sisa di kanan?".
 */
export async function scroll(
  page: Page,
  args: { selector?: string; dx?: number; dy?: number; to?: "left" | "right" | "top" | "bottom" },
): Promise<ScrollReport> {
  const result = await run(page, { mode: "scroll", ...args });
  if (result.kind === "error") throw new Error(result.message);
  if (result.kind !== "scroll") throw new Error("hasil probe tidak sesuai");
  return result.report;
}

/** Ukuran, overflow, dan teks penuh elemen — untuk membedakan "terpotong" dari "bisa di-scroll". */
export async function inspect(page: Page, selector: string, limit?: number): Promise<ElementReport[]> {
  const result = await run(page, { mode: "inspect", selector, limit });
  if (result.kind === "error") throw new Error(result.message);
  if (result.kind !== "inspect") throw new Error("hasil probe tidak sesuai");
  return result.reports;
}

/** Teks penuh tiap elemen yang cocok (tanpa bergantung pada apa yang terlihat di layar). */
export async function readText(
  page: Page,
  selector: string,
  limit?: number,
): Promise<{ texts: string[]; total: number }> {
  const result = await run(page, { mode: "text", selector, limit });
  if (result.kind === "error") throw new Error(result.message);
  if (result.kind !== "text") throw new Error("hasil probe tidak sesuai");
  return { texts: result.texts, total: result.total };
}

/**
 * Pencatat dialog native (confirm/alert/prompt).
 *
 * Tanpa handler, Playwright membuang dialog diam-diam sehingga QA tidak tahu tombol
 * konfirmasi pernah muncul. Bawaannya tetap dibuang — supaya tugas lama tidak berubah
 * perilaku — tapi selalu dicatat, dan tool `dialog` bisa memasang keputusan sebelum klik.
 */
export class DialogWatcher {
  private dialogs: string[] = [];
  private cursor = 0;
  private armed?: { action: "accept" | "dismiss"; promptText?: string; count: number };

  attach(page: Page): void {
    page.on("dialog", async (dialog) => {
      const armed = this.armed;
      if (armed) {
        armed.count -= 1;
        if (armed.count <= 0) this.armed = undefined;
      }
      const action = armed?.action ?? "dismiss";
      this.dialogs.push(
        `[dialog.${dialog.type()}] ${dialog.message()} → ${action}${armed ? "" : " (bawaan, tidak dipasang lewat tool dialog)"}`,
      );
      if (action === "accept") await dialog.accept(armed?.promptText ?? "").catch(() => undefined);
      else await dialog.dismiss().catch(() => undefined);
    });
  }

  /** Keputusan untuk N dialog berikutnya. */
  arm(action: "accept" | "dismiss", promptText: string | undefined, count: number): void {
    this.armed = { action, promptText, count };
  }

  count(): number {
    return this.dialogs.length;
  }

  /** Dialog sejak posisi tertentu, sekalian ditandai sudah dilaporkan supaya tidak dobel di `console`. */
  takeSince(from: number): string[] {
    const seen = this.dialogs.slice(from);
    this.cursor = Math.max(this.cursor, this.dialogs.length);
    return seen;
  }

  drain(): string[] {
    return this.takeSince(this.cursor);
  }
}

/** Satu baris kesimpulan per elemen — bagian yang dibaca QA sebelum menulis "terpotong". */
export function verdictLines(report: ElementReport): string[] {
  const lines: string[] = [];
  const scroller = report.scroller;
  // Elemen yang memotong isinya sendiri tidak boleh "diselamatkan" oleh container yang bisa
  // di-scroll: menggeser container tidak membuat teks ber-ellipsis jadi terbaca.
  const ownClipped = report.clippedByEllipsis || report.hiddenOverflowX;

  if (report.clippedByEllipsis) {
    lines.push(
      `Teks dipotong ellipsis (text-overflow: ellipsis, scrollWidth ${report.scrollWidth} > clientWidth ${report.clientWidth}) — menggeser container TIDAK membuatnya terbaca. Teks lengkapnya ada di baris "Teks:" di bawah; periksa juga apakah ada tooltip (hover/atribut title).`,
    );
  } else if (report.hiddenOverflowX) {
    lines.push(
      `Isi lebih lebar dari kotaknya (scrollWidth ${report.scrollWidth} > clientWidth ${report.clientWidth}) tapi overflow-x: hidden — tidak ada scrollbar; hanya bisa digulung lewat JS. Ini benar-benar terpotong bagi pengguna.`,
    );
  }

  if (report.scrollableX) {
    lines.push(
      `Bisa di-scroll horizontal: YA pada elemen ini (scrollWidth ${report.scrollWidth} > clientWidth ${report.clientWidth}, overflow-x: ${report.overflowX}) — ini BUKAN teks terpotong.`,
    );
  } else if (scroller?.scrollableX) {
    lines.push(
      ownClipped
        ? `Container-nya, ${scroller.name}, memang bisa di-scroll horizontal (sisa ${scroller.maxLeft}px) — itu menjelaskan kolom yang berada di luar layar, tapi BUKAN pemotongan di elemen ini.`
        : `Bisa di-scroll horizontal: YA lewat ${scroller.name} (scrollWidth ${scroller.scrollWidth} > clientWidth ${scroller.clientWidth}, overflow-x: ${scroller.overflowX}, sisa ${scroller.maxLeft}px) — ini BUKAN teks terpotong.`,
    );
  }

  if (report.scrollableY) {
    lines.push(`Bisa di-scroll vertikal: YA pada elemen ini (sisa ${report.scrollHeight - report.clientHeight}px).`);
  } else if (scroller?.scrollableY) {
    lines.push(`Bisa di-scroll vertikal: YA lewat ${scroller.name} (sisa ${scroller.maxTop}px).`);
  }

  if (lines.length === 0) lines.push("Tidak ada overflow: isinya pas di dalam kotaknya, tidak ada yang tersembunyi.");
  return lines;
}

/** Teks hasil `inspect` untuk dikirim ke agen. */
export function formatInspect(reports: ElementReport[], selector: string): string {
  return reports
    .map((report) => {
      const lines = [
        `${report.name} — kotak ${report.box.width}×${report.box.height} di (${report.box.x}, ${report.box.y})`,
        `  client ${report.clientWidth}×${report.clientHeight} · scroll ${report.scrollWidth}×${report.scrollHeight}`,
        `  overflow-x: ${report.overflowX} · overflow-y: ${report.overflowY} · white-space: ${report.whiteSpace} · text-overflow: ${report.textOverflow}`,
      ];
      if (report.scroller) {
        lines.push(
          `  scroller terdekat: ${report.scroller.name} (client ${report.scroller.clientWidth}×${report.scroller.clientHeight}, scroll ${report.scroller.scrollWidth}×${report.scroller.scrollHeight}, overflow-x: ${report.scroller.overflowX})`,
        );
      }
      for (const line of verdictLines(report)) lines.push(`  ${line}`);
      lines.push(`  Teks: ${report.text || "(kosong)"}`);
      return lines.join("\n");
    })
    .join("\n\n")
    .concat(`\n\n(selector: ${selector} — ${reports.length} elemen dilaporkan)`);
}

/** Teks hasil `scroll` untuk dikirim ke agen. */
export function formatScroll(report: ScrollReport): string {
  const horiz =
    report.maxLeft === 0
      ? "horizontal: tidak bisa di-scroll (isinya pas)"
      : `horizontal: ${report.left} dari maks ${report.maxLeft}${report.left >= report.maxLeft ? " (mentok kanan)" : ` (masih ada ${report.maxLeft - report.left}px di kanan)`}`;
  const vert =
    report.maxTop === 0
      ? "vertikal: tidak bisa di-scroll"
      : `vertikal: ${report.top} dari maks ${report.maxTop}${report.top >= report.maxTop ? " (mentok bawah)" : ""}`;
  const via = report.target === "dokumen" ? "dokumen" : `${report.scroller} (dari ${report.target})`;
  return `Scroll pada ${via}\n  ${horiz}\n  ${vert}`;
}
