import type { Locator, Page } from "playwright";

/**
 * Menentukan elemen sasaran aksi browser, dan menjelaskan kegagalannya dalam bahasa yang bisa
 * langsung ditindaklanjuti agen. Idenya dari browser-use: agen menunjuk elemen bernomor dari
 * daftar elemen yang memang terlihat, bukan menebak teks atau selector dari gambar.
 */

/** Ref dari snapshot AI Playwright: `e12`, atau `f1e3` untuk elemen di dalam iframe. */
export const REF_RE = /^(f\d+)?e\d+$/;

export type TargetArgs = { ref?: string; selector?: string; text?: string };

/** Sasaran tidak bisa ditentukan; pesannya sudah siap dibaca agen. */
export class TargetError extends Error {}

/** Menunggu elemen yang cocok muncul (halaman masih memuat, data datang belakangan). */
const FIND_TIMEOUT_MS = 10_000;
/**
 * Yang cocok ada tetapi semuanya tersembunyi (menu tertutup, duplikat versi mobile): tunggu sebentar
 * kalau-kalau sedang beranimasi, lalu berhenti. Dulu kasus ini selalu menghabiskan 10 detik.
 */
const HIDDEN_GRACE_MS = 2_000;
const POLL_MS = 100;

/** Ref seperti yang disalin agen: `e12`, `ref=e12`, atau `[ref=e12]`. */
export function cleanRef(raw: string): string {
  return raw.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/^ref=/, "");
}

/** Nama sasaran untuk pesan, saat nama dari snapshot tidak tersedia. */
export function targetLabel(args: TargetArgs): string {
  if (args.ref) return `ref ${cleanRef(args.ref)}`;
  if (args.selector) return args.selector;
  if (args.text) return `teks "${args.text}"`;
  return "(tanpa sasaran)";
}

/**
 * Locator untuk aksi. `ref` menunjuk persis elemen dari snapshot; `selector`/`text` hanya mengenai
 * elemen yang TERLIHAT. Tanpa saringan itu `.first()` sering jatuh ke duplikat tersembunyi lalu
 * menunggu 10 detik — sebagian besar dari 194 klik gagal di tugas-tugas lama.
 */
export async function resolveTarget(page: Page, args: TargetArgs): Promise<Locator> {
  if (args.ref) return byRef(page, args.ref);
  if (args.selector || args.text) return byQuery(page, args);
  throw new TargetError("butuh `ref` (dari snapshot), `selector`, atau `text`");
}

async function byRef(page: Page, raw: string): Promise<Locator> {
  const ref = cleanRef(raw);
  if (!REF_RE.test(ref)) throw new TargetError(`ref "${raw}" tidak dikenal — salin dari snapshot, mis. e12 atau f1e3`);
  const locator = page.locator(`aria-ref=${ref}`);
  if ((await locator.count()) > 0) return locator;
  // Snapshot terbatas (`selector`) hanya mendaftarkan ref di dalam bagiannya. Snapshot penuh
  // mendaftarkan ulang semua elemen dengan nomor yang sama, jadi ref lama yang elemennya masih ada
  // kembali berlaku.
  await page.ariaSnapshot({ mode: "ai", timeout: 5_000 }).catch(() => undefined);
  if ((await locator.count()) > 0) return locator;
  throw new TargetError(`ref ${ref} tidak ada lagi di halaman (elemennya hilang atau halaman berganti) — panggil snapshot lagi`);
}

async function byQuery(page: Page, args: TargetArgs): Promise<Locator> {
  const all = args.selector ? page.locator(args.selector) : page.getByText(args.text ?? "", { exact: false });
  const visible = all.visible();
  const label = targetLabel(args);
  const start = Date.now();
  let hiddenSince: number | undefined;
  for (;;) {
    if ((await visible.count()) > 0) return visible.first();
    const total = await all.count();
    const now = Date.now();
    if (total > 0) {
      hiddenSince ??= now;
      if (now - hiddenSince >= HIDDEN_GRACE_MS) {
        throw new TargetError(
          `${total} elemen cocok dengan ${label}, tetapi tidak satu pun terlihat — mungkin di dalam menu, tab, atau ` +
            "akordeon yang tertutup, atau versi mobile. Buka dulu wadahnya, atau panggil snapshot lalu pakai ref.",
        );
      }
    } else {
      hiddenSince = undefined;
    }
    if (now - start >= FIND_TIMEOUT_MS) {
      throw new TargetError(
        `tidak ada elemen yang cocok dengan ${label} setelah ${FIND_TIMEOUT_MS / 1000} s — panggil snapshot dan pakai ref; jangan menebak teks/selector`,
      );
    }
    await page.waitForTimeout(POLL_MS);
  }
}

/** Elemen penghalang dari call log Playwright, tanpa ekor "from … subtree". */
function coveringElement(log: string): string | undefined {
  const line = log.match(/^\s*-\s+(.+?)\s+intercepts pointer events\s*$/m)?.[1];
  if (!line) return undefined;
  const element = line.replace(/\s+from\s+<.*\bsubtree$/, "");
  return element.length > 140 ? `${element.slice(0, 139)}…` : element;
}

const HINTS: Array<[RegExp, string]> = [
  [/Element is not a <select> element/, "elemen ini bukan <select> native — buka dropdown-nya dengan click, lalu klik opsinya (opsi yang muncul tercantum di hasil click)"],
  [/did not find some options/, "opsi yang diminta tidak ada di <select> ini"],
  [/Element is not an <input>, <textarea>/, "elemen ini bukan field isian — panggil snapshot dan pakai ref textbox-nya"],
  [/element is not enabled|element is disabled/, "elemen disabled — periksa syarat yang belum terpenuhi; kalau seharusnya aktif, itu temuan"],
  [/element is not editable|readonly/i, "field ini read-only, tidak bisa diisi"],
  [/element is not stable/, "elemen terus bergerak (animasi), jadi tidak bisa dikenai aksi"],
  [/element is not visible/, "elemen menjadi tersembunyi sebelum sempat dikenai aksi"],
  [/outside of the viewport/, "elemen berada di luar viewport dan tidak bisa digulung ke layar"],
  [/has been closed|Target closed/, "browser atau halamannya sudah tertutup — panggil open lagi"],
  [/Timeout \d+ms exceeded/, "aksi tidak selesai dalam batas waktu"],
];

/**
 * Ringkas galat Playwright (yang membawa call log panjang berkode warna) menjadi sebab dan saran.
 * Elemen yang tertutup modal/overlay sengaja TIDAK diklik lewat JavaScript seperti browser-use:
 * pengguna pun tidak bisa mengkliknya, jadi itu bisa jadi temuan.
 */
export function explainFailure(message: string): string {
  const log = message.replace(/\u001b\[[0-9;]*m/g, "");
  const first = log.split("\n").find((line) => line.trim())?.trim() ?? log.trim();
  const covering = coveringElement(log);
  if (covering) {
    return `tertutup oleh ${covering} — elemen itu menghalangi aksi. Tutup dulu (modal, overlay, banner); laporkan bila memang mengganggu pengguna. (${first})`;
  }
  const hint = HINTS.find(([pattern]) => pattern.test(log))?.[1];
  return hint ? `${hint} (${first})` : first;
}

/** Teks galat untuk agen dari apa pun yang dilempar aksi. */
export function failureText(error: unknown): string {
  if (error instanceof TargetError) return error.message;
  return explainFailure(error instanceof Error ? error.message : String(error));
}
