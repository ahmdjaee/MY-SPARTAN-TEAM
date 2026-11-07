/**
 * Gate: kotak "Usul agen" di halaman tugas harus setinggi SATU BARIS,
 * bisa dibentang saat diklik, dan tidak pernah lagi merebut layar.
 *
 * Jalankan dengan server yang sedang hidup:  bun run gate:suggest
 * (Tidak memanggil agen sama sekali — murni pemeriksaan tampilan.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { CONFIG } from "../../server/config.ts";

const BASE = process.env.GATE_BASE ?? `http://127.0.0.1:${CONFIG.port}`;
/** Tugas dengan usul agen yang panjang (yang bikin keluhan), tugas lain dengan usul, dan tugas tanpa usul. */
const WITH_SUGGESTION = process.env.GATE_TASK ?? "T-015";
const OTHER_SUGGESTION = process.env.GATE_TASK_OTHER ?? "T-032";
const WITHOUT_SUGGESTION = process.env.GATE_TASK_PLAIN ?? "T-033";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  GAGAL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function noteOf(taskId: string): string {
  const task = JSON.parse(readFileSync(join(CONFIG.tasksDir, taskId, "task.json"), "utf8")) as {
    suggestedNext?: { note: string };
  };
  if (!task.suggestedNext) throw new Error(`${taskId} tidak punya suggestedNext — gate butuh tugas yang punya usul`);
  return task.suggestedNext.note;
}

const trigger = (page: Page): Locator => page.locator("header button[aria-expanded]");
/** Kotak oranye = kakek dari pemicu (pemicu → baris flex → kotak). */
const box = (page: Page): Locator => trigger(page).locator("xpath=../..");

async function height(target: Locator): Promise<number> {
  return (await target.boundingBox())?.height ?? -1;
}

async function main(): Promise<void> {
  const note = noteOf(WITH_SUGGESTION);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    console.log(`\n${WITH_SUGGESTION} — usul agen ${note.length} karakter`);
    await page.goto(`${BASE}/tasks/${WITH_SUGGESTION}/work`, { waitUntil: "networkidle" });
    await trigger(page).waitFor({ state: "visible", timeout: 15_000 });

    // 1. Satu baris.
    const collapsed = await height(box(page));
    check("kotak usul setinggi satu baris (< 48px)", collapsed > 0 && collapsed < 48, `${collapsed.toFixed(1)}px`);

    // 2. Teksnya memang terpotong, bukan kebetulan pendek.
    const label = trigger(page).locator("span.truncate");
    const clipped = await label.evaluate((el) => el.scrollWidth - el.clientWidth);
    check("teks usul terpotong dengan elipsis", clipped > 0, `selisih ${clipped}px`);

    // 3. Header tidak lagi mendorong percakapan keluar layar.
    const headerHeight = await height(page.locator("header").first());
    check("header tetap ringkas (< 200px)", headerHeight > 0 && headerHeight < 200, `${headerHeight.toFixed(1)}px`);
    const tabBox = await page.getByRole("button", { name: "Kerja", exact: true }).boundingBox();
    check("tab Kerja masih terlihat tanpa scroll", (tabBox?.y ?? 1e9) < 400, `y=${tabBox?.y?.toFixed(0) ?? "?"}`);

    // 4. Diklik → membentang, isinya utuh, tapi tingginya tetap berpagar.
    await trigger(page).click();
    check("aria-expanded jadi true", (await trigger(page).getAttribute("aria-expanded")) === "true");
    const full = box(page).locator("p");
    const shown = ((await full.textContent()) ?? "").trim();
    check("catatan penuh terbaca", shown.startsWith(note.slice(0, 60).trim()), `"${shown.slice(0, 40)}…"`);
    check("catatan penuh sama persis dengan task.json", shown === note.trim());
    const expanded = await height(box(page));
    check("terbentang pun tetap berpagar (≤ 260px)", expanded <= 260, `${expanded.toFixed(1)}px`);
    check("terbentang lebih tinggi dari tertutup", expanded > collapsed, `${collapsed.toFixed(1)} → ${expanded.toFixed(1)}`);

    // 5. Diklik lagi → kembali satu baris.
    await trigger(page).click();
    check("klik kedua menutup lagi", (await height(box(page))) < 48);

    // 6. Jalur keyboard.
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    check("Enter membentang", (await trigger(page).getAttribute("aria-expanded")) === "true");
    await page.keyboard.press("Enter");
    check("Enter menutup", (await trigger(page).getAttribute("aria-expanded")) === "false");

    // 7. Tombol Oper sekarang tetap bekerja dari baris yang tertutup.
    await page.getByRole("button", { name: "Oper sekarang" }).click();
    const dialog = page.getByRole("heading", { name: new RegExp(`Oper tugas ${WITH_SUGGESTION}`) });
    check("dialog operan terbuka dari baris tertutup", await dialog.isVisible());
    const prefilled = await page.getByPlaceholder("Catatan operan").inputValue();
    check("catatan usul ikut terisi di dialog", prefilled.trim() === note.trim(), `${prefilled.length} karakter`);
    await page.getByRole("button", { name: "Batal", exact: true }).click();
    check("dialog ditutup tanpa mengoper apa pun", !(await dialog.isVisible()));

    // 8. Pindah tugas lalu kembali → tertutup lagi.
    await trigger(page).click();
    await page.goto(`${BASE}/tasks/${OTHER_SUGGESTION}/work`, { waitUntil: "networkidle" });
    await trigger(page).waitFor({ state: "visible", timeout: 15_000 });
    check(`${OTHER_SUGGESTION} juga tertutup saat dibuka`, (await height(box(page))) < 48);
    await page.goto(`${BASE}/tasks/${WITH_SUGGESTION}/work`, { waitUntil: "networkidle" });
    await trigger(page).waitFor({ state: "visible", timeout: 15_000 });
    check("kembali ke tugas semula: tertutup lagi", (await trigger(page).getAttribute("aria-expanded")) === "false");

    // 9. Tugas tanpa usul tidak menumbuhkan kotak apa pun.
    await page.goto(`${BASE}/tasks/${WITHOUT_SUGGESTION}/work`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Kerja", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    check(`${WITHOUT_SUGGESTION} tanpa usul: tidak ada kotak`, (await trigger(page).count()) === 0);
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} hijau, ${failures.length} merah`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
