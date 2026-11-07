/**
 * Gate: tab Laporan tugas menampilkan Report utama, Temuan, dan Resolved, dan isinya mengikuti register.
 * Butuh server berjalan dengan build terbaru; tidak mengubah data kecuali diberi GATE_MUTATE=1.
 *
 *   GATE_BASE=http://127.0.0.1:4320 GATE_TASK=T-016 bun run gate:task-report
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import type { TaskReportView } from "../../web/api.ts";

const BASE = process.env.GATE_BASE ?? "http://127.0.0.1:4320";
const TASK = process.env.GATE_TASK ?? "T-016";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok   " : "GAGAL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const view = (await (await fetch(`${BASE}/api/tasks/${TASK}/report-view`)).json()) as TaskReportView;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/tasks/${TASK}/report`, { waitUntil: "load" });
  await page.locator("[data-report-now]").waitFor({ state: "visible", timeout: 15_000 });

  /** Perpindahan tab lewat router tidak sinkron; tunggu jumlahnya, jangan langsung membaca. */
  const settles = async (selector: string, wanted: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await page.locator(selector).count()) === wanted) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };

  const shot = async (name: string): Promise<void> => {
    if (process.env.GATE_SHOT) await page.screenshot({ path: `${process.env.GATE_SHOT}-${name}.png` });
  };

  const tabs = await page.locator("[data-report-section]").allInnerTexts();
  check("tiga tab dengan jumlah", JSON.stringify(tabs) === JSON.stringify(["Report utama", `Temuan (${view.opened.length + view.unlinked.length})`, `Resolved (${view.resolved.length})`]), tabs.join(" | "));
  check("verdict terkini tampil", !view.verdict || (await page.locator("[data-report-now-verdict]").innerText()) === view.verdict.text);
  check("semua putaran tampil", (await page.locator("[data-report-round]").count()) === view.rounds.length);
  if (view.rounds.length > 0) {
    check("putaran terbaru di atas", (await page.locator("[data-report-round]").first().innerText()).includes(view.rounds.at(-1)!.title.slice(0, 30)));
    check("hanya putaran terbaru terbuka", (await page.locator('[data-report-round] button[aria-expanded="true"]').count()) === 1);
  }
  await shot("main");

  await page.locator('[data-report-section="findings"]').click();
  check("semua temuan terbuka tampil", await settles("[data-task-finding]", view.opened.length));
  check("alamat menyimpan tab Temuan", page.url().includes("section=findings"));
  check("temuan belum tertaut berlabel", (await page.locator("[data-task-unlinked]").count()) === view.unlinked.length);
  const openWithBlock = view.opened.find((item) => item.blocks.length > 0);
  if (openWithBlock) {
    await page.locator(`[data-task-finding="${openWithBlock.finding.id}"] button`).click();
    check("kartu memuat detail laporan", (await page.locator(`[data-task-finding="${openWithBlock.finding.id}"]`).innerText()).includes("Dari laporan"));
  }
  await shot("findings");

  await page.locator('[data-report-section="resolved"]').click();
  check("semua temuan selesai tampil", await settles("[data-finding-badge]", view.resolved.length));
  const badges = await page.locator("[data-finding-badge]").allInnerTexts();
  check("badge sesuai status", view.resolved.every((item, index) => {
    const { status, lastVerifiedAt } = item.finding;
    const wanted = status === "needs_retest" ? "menunggu uji ulang" : status === "wontfix" ? "tidak diperbaiki" : status === "invalid" ? "bukan masalah" : lastVerifiedAt ? "terverifikasi" : "diperbaiki";
    return badges[index] === wanted;
  }), badges.join(","));
  await shot("resolved");

  await page.reload({ waitUntil: "load" });
  await page.locator("[data-report-section]").first().waitFor({ state: "visible" });
  check("tab bertahan setelah refresh", await settles("[data-finding-badge]", view.resolved.length));

  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("[data-task-findings-download]").click()]);
  const markdown = readFileSync(await download.path(), "utf8");
  check("nama berkas unduhan", download.suggestedFilename().startsWith(`temuan-${TASK}-`), download.suggestedFilename());
  check("unduhan memuat semua temuan", [...view.opened, ...view.resolved].every(({ finding }) => markdown.includes(finding.id)));
  check("unduhan dibagi dua", markdown.includes(`## Temuan (${view.opened.length + view.unlinked.length})`) && markdown.includes(`## Resolved (${view.resolved.length})`));
  check("tanpa error halaman", errors.length === 0, errors.join("; "));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} GAGAL` : "\nsemua lolos");
process.exit(failed ? 1 : 0);
