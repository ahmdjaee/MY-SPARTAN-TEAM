/**
 * Gate: tab "Rekap" di halaman project.
 *
 * Dua lapis pemeriksaan:
 *  1. Panenan server disilang-periksa dengan isi report.md di disk — bukan dengan dirinya sendiri.
 *  2. Tampilannya: tiap baris setinggi satu baris, bisa dibentang, dan tombol Sync memindahkan
 *     garis dasar penanda "berubah".
 *
 * Jalankan dengan server yang sedang hidup:  npm run gate:recap
 * (Tidak memanggil agen sama sekali.)
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { CONFIG } from "../../server/config.ts";
import type { ProjectRecap } from "../../server/recap.ts";

const BASE = process.env.GATE_BASE ?? `http://127.0.0.1:${CONFIG.port}`;
const OLD_STAMP = "2000-01-01T00:00:00.000Z";
/** Harus sejajar dengan VERDICTS di server/recap.ts; frasa terpanjang lebih dulu. */
const VERDICT_WORDS = [
  "LULUS DENGAN CATATAN",
  "BERHASIL DENGAN CATATAN",
  "SELESAI SEBAGIAN",
  "TERBLOKIR",
  "GAGAL",
  "BERHASIL",
  "SELESAI",
  "LULUS",
];

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

function skip(name: string, why: string): void {
  console.log(`  --   ${name} (dilewati: ${why})`);
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return (await response.json()) as T;
}

function reportOnDisk(taskId: string): string {
  return readFileSync(join(CONFIG.tasksDir, taskId, "report.md"), "utf8");
}

/** Semua bagian "## Temuan" — sengaja ditulis ulang, bukan diimpor dari server/recap.ts. */
function temuanSection(text: string): string {
  const lines = text.split("\n");
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^##[ \t]*Temuan[ \t]*$/.test(lines[i] ?? "")) continue;
    const rest = lines.slice(i + 1);
    const end = rest.findIndex((line) => /^#{1,2}[ \t]+\S/.test(line));
    bodies.push((end < 0 ? rest : rest.slice(0, end)).join("\n"));
  }
  return bodies.join("\n");
}

/** Pegangan eksplisit: tombol pemilih project di sidebar juga punya aria-expanded. */
const rows = (page: Page): Locator => page.locator("[data-recap-row]");
const rowOf = (page: Page, taskId: string): Locator => page.locator(`[data-recap-row="${taskId}"]`);
const triggerOf = (page: Page, taskId: string): Locator => rowOf(page, taskId).locator("button[aria-expanded]");
const dots = (page: Page): Locator => page.locator('span[title="Berubah sejak Sync terakhir"]');
/** Rekap kini lampiran di tab Report; tombol Sync kurator di atasnya beda, jadi dicari di dalam lampiran. */
const syncButton = (page: Page): Locator => page.locator("[data-recap-root]").getByRole("button", { name: /^Sync/ });

async function main(): Promise<void> {
  // --- pilih project yang paling ramai laporannya ---
  const { projects } = await json<{ projects: { id: string; name: string }[] }>("/api/projects");
  let best: ProjectRecap | undefined;
  for (const project of projects) {
    const recap = await json<ProjectRecap>(`/api/projects/${encodeURIComponent(project.id)}/recap`);
    if (!best || recap.entries.length > best.entries.length) best = recap;
  }
  if (!best || best.entries.length === 0) throw new Error("tidak ada project dengan laporan — gate butuh data nyata");
  const recap = best;
  const projectId = recap.projectId;
  console.log(`\nproject ${projectId} — ${recap.entries.length} baris rekap, ${recap.totals.reports} laporan QA`);

  // ---------- Lapis 1: panenan vs disk ----------
  const reportEntries = recap.entries.filter((entry) => entry.source === "report");
  check("ada entri bersumber report.md", reportEntries.length > 0, `${reportEntries.length}`);

  let verdictOk = 0;
  let findingOk = 0;
  let headingOk = 0;
  let summaryOk = 0;
  for (const entry of reportEntries) {
    const text = reportOnDisk(entry.taskId);

    // Verdict harus sama dengan baris "**Hasil:**" TERAKHIR di berkasnya — satu report.md
    // bisa memuat beberapa bagian, dan yang berlaku adalah kesimpulan penulis terakhir.
    const hasil = [...text.matchAll(/\*\*Hasil:?\*\*[ \t]*:?[ \t]*(.+)/gi)]
      .map((match) => match[1]!.replace(/[*_`]/g, "").trim().toUpperCase())
      .pop();
    const expected = VERDICT_WORDS.find((value) => hasil?.startsWith(value));
    if ((entry.verdict?.text ?? undefined) === (expected ?? undefined)) verdictOk += 1;
    else failures.push(`verdict ${entry.taskId}: panen "${entry.verdict?.text}" ≠ disk "${expected}"`);

    // Tiap temuan yang dipanen harus benar-benar tertulis di berkasnya.
    const flat = text.replace(/[*_`]/g, "");
    if (entry.findings.every((finding) => flat.includes(finding.title) || flat.includes(finding.title.split(" · ")[0]!)))
      findingOk += 1;
    else failures.push(`temuan ${entry.taskId} tidak ditemukan di report.md`);

    // Tiap heading "### …" di dalam "## Temuan" harus terpanen.
    const headings = temuanSection(text).split("\n").filter((line) => /^#{3,6}[ \t]+\S/.test(line)).length;
    if (headings === entry.findings.length) headingOk += 1;
    else failures.push(`jumlah temuan ${entry.taskId}: panen ${entry.findings.length} ≠ heading di disk ${headings}`);

    // Ringkasan yang dipanen harus potongan dari berkasnya — kecuali laporan itu tidak punya
    // "## Ringkasan", yang memang sengaja jatuh ke ringkasan serah terima.
    const head = entry.summary?.slice(0, 40);
    const hasSummaryHeading = /^#{2,6}[ \t]*Ringkasan[ \t]*$/im.test(text);
    if (!entry.summary || !hasSummaryHeading || (head && text.includes(head))) summaryOk += 1;
    else failures.push(`ringkasan ${entry.taskId} tidak cocok dengan isi report.md`);
  }
  check(`verdict cocok dengan disk (${verdictOk}/${reportEntries.length})`, verdictOk === reportEntries.length);
  check(`judul temuan ada di disk (${findingOk}/${reportEntries.length})`, findingOk === reportEntries.length);
  check(`jumlah temuan = jumlah heading (${headingOk}/${reportEntries.length})`, headingOk === reportEntries.length);
  check(`ringkasan potongan asli (${summaryOk}/${reportEntries.length})`, summaryOk === reportEntries.length);

  // changedAt harus mtime berkasnya — itu dasar penanda "berubah", jadi harus dibuktikan, bukan dipercaya.
  const mtimeOk = reportEntries.filter(
    (entry) => statSync(join(CONFIG.tasksDir, entry.taskId, "report.md")).mtime.toISOString() === entry.changedAt,
  ).length;
  check(`changedAt = mtime report.md (${mtimeOk}/${reportEntries.length})`, mtimeOk === reportEntries.length);

  // Totals harus konsisten dengan entri-entrinya.
  const sev = (name: string): number =>
    recap.entries.flatMap((entry) => entry.findings).filter((finding) => finding.severity === name).length;
  check(
    "totals cocok dengan entri",
    recap.totals.reports === reportEntries.length &&
      recap.totals.blocker === sev("blocker") &&
      recap.totals.major === sev("major") &&
      recap.totals.minor === sev("minor"),
  );

  // emptyCount = tugas project yang tidak jadi baris.
  const { tasks } = await json<{ tasks: { id: string }[] }>(`/api/tasks?project=${encodeURIComponent(projectId)}`);
  check(
    "emptyCount = tugas tanpa laporan & tanpa ringkasan",
    tasks.length - recap.entries.length === recap.emptyCount,
    `${tasks.length} tugas − ${recap.entries.length} baris vs ${recap.emptyCount}`,
  );

  // ---------- Lapis 2: tampilan ----------
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Garis dasar lama ditanam dulu supaya penanda "berubah" bisa diuji.
  await context.addInitScript(
    ([key, stamp]: string[]) => {
      try {
        localStorage.setItem(key!, stamp!);
      } catch {
        /* abaikan */
      }
    },
    [`ai-team-recap-seen:${projectId}`, OLD_STAMP],
  );
  const page = await context.newPage();

  try {
    await page.goto(`${BASE}/projects/${encodeURIComponent(projectId)}?tab=recap`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Lampiran: laporan per tugas/ }).click();
    await rows(page).first().waitFor({ state: "visible", timeout: 15_000 });

    check(
      "jumlah baris = jumlah entri",
      (await rows(page).count()) === recap.entries.length,
      `DOM ${await rows(page).count()} vs JSON ${recap.entries.length}`,
    );

    // Angka di bilah atas sama dengan angka di JSON.
    const bar = (await page.locator("[data-recap-bar]").innerText()).replace(/\s+/g, " ");
    check(
      "bilah atas memuat angka dari JSON",
      bar.includes(`${recap.totals.reports} laporan tugas`) &&
        (recap.totals.reports === 0 || bar.includes(`${recap.totals.bad} gagal/terblokir`)),
      bar.slice(0, 120),
    );

    // Semua baris tertutup setinggi satu baris.
    let tall = 0;
    for (const entry of recap.entries) {
      const height = (await rowOf(page, entry.taskId).boundingBox())?.height ?? -1;
      if (height <= 0 || height >= 48) tall += 1;
    }
    check("semua baris setinggi satu baris (< 48px)", tall === 0, `${tall} baris terlalu tinggi`);
    check(
      "semua baris tertutup",
      (await page.locator('[data-recap-row] button[aria-expanded="true"]').count()) === 0,
    );

    // Baris dengan ringkasan terpanjang harus benar-benar terpotong, bukan melipat.
    const longest = [...recap.entries].sort((a, b) => (b.summary?.length ?? 0) - (a.summary?.length ?? 0))[0]!;
    const clipped = await triggerOf(page, longest.taskId)
      .locator("span.truncate")
      .evaluate((node) => node.scrollWidth > node.clientWidth);
    check(`teks baris ${longest.taskId} terpotong (${longest.summary?.length ?? 0} karakter)`, clipped);

    // Penanda berubah: garis dasar lama → semua baris bertitik.
    check("penanda berubah muncul dengan garis dasar lama", (await dots(page).count()) === recap.entries.length);

    // ---------- bentang satu baris bersumber report.md ----------
    const first = reportEntries[0]!;
    const trigger = triggerOf(page, first.taskId);
    await trigger.click();
    await rowOf(page, first.taskId).locator(".markdown").waitFor({ state: "visible", timeout: 15_000 });
    check("baris terbentang", (await trigger.getAttribute("aria-expanded")) === "true");

    const body = await rowOf(page, first.taskId).locator(".markdown").innerText();
    const diskText = reportOnDisk(first.taskId);
    check(
      "laporan penuh tampil (lebih panjang daripada ringkasan)",
      body.length > (first.summary?.length ?? 0),
      `${body.length} karakter`,
    );
    const heading = [...diskText.matchAll(/^##[ \t]+(.+)$/gm)]
      .map((match) => match[1]!.trim())
      .find((value) => !/^Ringkasan$/i.test(value));
    if (heading) check(`laporan memuat bagian "${heading}"`, body.includes(heading));
    else skip("bagian laporan", "report.md tidak punya heading ## selain Ringkasan");

    const expandedHeight = (await rowOf(page, first.taskId).boundingBox())?.height ?? -1;
    check("baris terbentang jadi lebih tinggi", expandedHeight > 48, `${expandedHeight.toFixed(0)}px`);

    const images = rowOf(page, first.taskId).locator(".markdown img");
    if ((await images.count()) > 0) {
      const src = await images.first().getAttribute("src");
      check(
        "path gambar bukti ditulis ulang ke endpoint aset",
        src?.startsWith(`/api/tasks/${first.taskId}/assets/`) === true,
        src ?? "(kosong)",
      );
      const status = await page.evaluate(async (url: string) => (await fetch(url)).status, new URL(src!, BASE).toString());
      check("gambar bukti benar-benar terlayani", status === 200, `HTTP ${status}`);
    } else {
      skip("gambar bukti", "laporan ini tidak memuat gambar");
    }

    await trigger.click();
    check("baris tertutup kembali", (await trigger.getAttribute("aria-expanded")) === "false");

    // Baris bersumber ringkasan operan.
    const summaryEntry = recap.entries.find((entry) => entry.source === "summary");
    if (summaryEntry) {
      const text = await triggerOf(page, summaryEntry.taskId).innerText();
      check("baris ringkasan operan ditandai", text.includes("(ringkasan operan)"), text.slice(0, 80));
    } else {
      skip("baris ringkasan operan", "project ini tidak punya tugas tanpa report.md tapi berringkasan");
    }

    // Semua peran kini menulis laporan: baris bersumber report milik peran non-QA tidak
    // boleh ditandai "(ringkasan operan)". Cek ini menggantikan cakupan yang hilang di atas.
    const nonQaReport = recap.entries.find((entry) => entry.source === "report" && entry.role !== "qa");
    if (nonQaReport) {
      const text = await triggerOf(page, nonQaReport.taskId).innerText();
      check(
        `laporan peran non-QA (${nonQaReport.taskId}) tidak bertanda ringkasan operan`,
        !text.includes("(ringkasan operan)"),
        text.slice(0, 80),
      );
    } else {
      skip("laporan peran non-QA", "belum ada tugas Engineer/DevOps yang menulis report.md");
    }

    // ---------- Sync ----------
    const stampBefore = await page.locator("[data-recap-stamp]").getAttribute("data-recap-stamp");
    await syncButton(page).click();
    await page.waitForFunction(
      (old: string | null) =>
        document.querySelector("[data-recap-stamp]")?.getAttribute("data-recap-stamp") !== old,
      stampBefore,
      { timeout: 15_000 },
    );
    check("titik 'berubah' hilang sesudah Sync", (await dots(page).count()) === 0);
    const stored = await page.evaluate((key: string) => localStorage.getItem(key), `ai-team-recap-seen:${projectId}`);
    check("garis dasar tersimpan sesudah Sync", Boolean(stored) && stored !== OLD_STAMP, stored ?? "(kosong)");
    check("baris masih utuh sesudah Sync", (await rows(page).count()) === recap.entries.length);

    // Tautan ke tugas.
    const href = await rowOf(page, first.taskId).locator("a").first().getAttribute("href");
    check("tautan menuju tab Laporan tugas", href?.startsWith(`/tasks/${first.taskId}/report`) === true, href ?? "");
  } finally {
    await browser.close();
  }
}

await main()
  .then(() => {
    console.log(`\n${passed} hijau, ${failures.length} merah`);
    if (failures.length > 0) {
      for (const failure of failures) console.log(`  - ${failure}`);
      process.exit(1);
    }
  })
  .catch((cause: Error) => {
    console.error(`\ngate gagal dijalankan: ${cause.message}`);
    process.exit(1);
  });
