/**
 * Gate: register temuan project + tab Report.
 *
 *  1. Data: id unik, tiap kemunculan menunjuk tugas yang ada, tiap penutupan punya bukti,
 *     duplikat yang digabung menunjuk induk yang ada.
 *  2. Konteks agen: contextBlock tugas di project itu memuat register.
 *  3. Tampilan: tab Report menampilkan kesimpulan, register, cakupan, baris bisa dibentang,
 *     dan report bisa diunduh sebagai Markdown.
 *
 * Jalankan dengan server yang sedang hidup:  npm run gate:register
 * (Tidak memanggil agen sama sekali.)
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { CONFIG } from "../../server/config.ts";
import { contextBlock } from "../../server/context.ts";
import { OPEN_STATUSES, type Finding, type UnlinkedFinding } from "../../server/findings.ts";
import { loadProjects } from "../../server/projects.ts";
import { statusText } from "../../server/report-markdown.ts";
import { getTask, loadTasks, tasksInProject } from "../../server/tasks.ts";

const BASE = process.env.GATE_BASE ?? `http://127.0.0.1:${CONFIG.port}`;

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

type Report = {
  projectId: string;
  state: string;
  findings: Finding[];
  unlinked: UnlinkedFinding[];
  coverage: unknown[];
  curator: { inProgress: string[] };
};

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  loadProjects();
  loadTasks();
  const { projects } = await json<{ projects: { id: string }[] }>("/api/projects");
  let report: Report | undefined;
  for (const project of projects) {
    const candidate = await json<Report>(`/api/projects/${encodeURIComponent(project.id)}/report`);
    if (!report || candidate.findings.length > report.findings.length) report = candidate;
  }
  if (!report || report.findings.length === 0) throw new Error("tidak ada project dengan register — jalankan kurator dulu");
  const { projectId, findings } = report;
  console.log(`\nproject ${projectId} — ${findings.length} temuan, ${report.coverage.length} sel cakupan`);

  // ---------- Lapis 1: data ----------
  const ids = findings.map((finding) => finding.id);
  check("id temuan unik", new Set(ids).size === ids.length);
  check("id berformat F-nnn", ids.every((id) => /^F-\d{3,}$/.test(id)), ids.filter((id) => !/^F-\d{3,}$/.test(id)).join(","));
  const missing = findings.flatMap((finding) =>
    finding.occurrences.filter((item) => getTask(item.taskId)?.projectId !== projectId).map((item) => `${finding.id}:${item.taskId}`),
  );
  check("tiap kemunculan menunjuk tugas di project ini", missing.length === 0, missing.join(", "));
  const unproven = findings.filter((finding) => !OPEN_STATUSES.includes(finding.status) && !finding.resolution?.note.trim());
  check("tiap temuan yang ditutup punya bukti", unproven.length === 0, unproven.map((finding) => finding.id).join(","));
  const orphans = findings.filter((finding) => finding.mergedInto && !ids.includes(finding.mergedInto));
  check("duplikat menunjuk induk yang ada", orphans.length === 0, orphans.map((finding) => finding.id).join(","));

  const falseAlarms = report.unlinked.filter((item) =>
    findings.some((finding) => finding.occurrences.some((occurrence) => occurrence.taskId === item.taskId && occurrence.localId === item.id)),
  );
  check("temuan tak tertaut memang tanpa kemunculan", falseAlarms.length === 0, falseAlarms.map((item) => `${item.taskId}:${item.id}`).join(","));
  const stillActive = report.curator.inProgress.filter((id) => !["queued", "running", "waiting"].includes(getTask(id)?.status ?? ""));
  check("daftar tugas berjalan hanya berisi tugas aktif", stillActive.length === 0, stillActive.join(","));

  // ---------- Lapis 2: konteks agen ----------
  const task = tasksInProject(projectId)[0];
  if (task) {
    const block = contextBlock(task.id);
    check("konteks tugas memuat register", block.includes("## Register temuan project"));
    const open = findings.find((finding) => OPEN_STATUSES.includes(finding.status) && !finding.mergedInto);
    if (open) check("konteks memuat temuan terbuka", block.includes(open.id), open.id);
    if (report.state.trim()) check("konteks memuat kesimpulan project", block.includes("## Status project"));
  }

  // ---------- Lapis 3: tampilan ----------
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${BASE}/projects/${encodeURIComponent(projectId)}?tab=recap`, { waitUntil: "networkidle" });
    await page.locator("[data-report-summary]").waitFor({ state: "visible", timeout: 15_000 });
    const verdict = await page.locator("[data-report-verdict]").getAttribute("data-report-verdict");
    if (report.state.includes("**Kesimpulan:**")) check("kesimpulan tampil", Boolean(verdict), verdict ?? "");

    await page.getByRole("button", { name: "semua", exact: true }).click();
    const rows = page.locator("[data-finding-row]");
    const visible = findings.filter((finding) => !finding.mergedInto).length;
    check("jumlah baris register = item JSON", (await rows.count()) === visible, `DOM ${await rows.count()} vs JSON ${visible}`);

    const first = rows.first();
    const trigger = first.locator("button[aria-expanded]");
    const before = (await first.boundingBox())?.height ?? 0;
    check("baris tertutup setinggi satu baris", before > 0 && before < 48, `${before}px`);
    await trigger.click();
    check("baris bisa dibentang", (await trigger.getAttribute("aria-expanded")) === "true");
    const link = first.locator('a[href^="/tasks/"]').first();
    check("bentangan menautkan laporan tugas", (await link.count()) > 0 && /\/report/.test((await link.getAttribute("href")) ?? ""));

    check("label tombol report lengkap", (await page.locator("[data-report-download]").innerText()) === "Download report lengkap");
    check("label tombol temuan", (await page.locator("[data-findings-download]").innerText()) === "Download temuan");

    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("[data-report-download]").click()]);
    check("unduhan report berakhiran .md", download.suggestedFilename().endsWith(".md"), download.suggestedFilename());
    const path = await download.path();
    const markdown = readFileSync(path, "utf8");
    const absent = findings.filter((finding) => !finding.mergedInto && !markdown.includes(finding.id)).map((finding) => finding.id);
    check("unduhan memuat semua temuan aktif", absent.length === 0, absent.join(","));
    const blocks = markdown.split("\n### ");
    const unmarked = findings
      .filter((finding) => !finding.mergedInto)
      .filter((finding) => {
        const block = blocks.find((item) => item.startsWith(`${finding.id} `));
        return !block?.includes(`**Status:** ${statusText(finding.status)}`);
      })
      .map((finding) => finding.id);
    check("status tiap temuan bertanda emoji dan sesuai JSON", unmarked.length === 0, unmarked.join(","));
    check("unduhan tanpa tag warna HTML", !markdown.includes("<span style="));
    for (const section of ["## Kesimpulan", "## Cakupan uji", "## Lampiran", "**Dilaporkan di:**"]) {
      check(`report lengkap memuat ${section}`, markdown.includes(section));
    }

    const [findingsDownload] = await Promise.all([page.waitForEvent("download"), page.locator("[data-findings-download]").click()]);
    const findingsName = findingsDownload.suggestedFilename();
    check("nama berkas temuan", findingsName.startsWith("temuan-") && findingsName.endsWith(".md"), findingsName);
    const findingsMd = readFileSync(await findingsDownload.path(), "utf8");
    const activeFindings = findings.filter((finding) => !finding.mergedInto);
    const openCount = activeFindings.filter((finding) => OPEN_STATUSES.includes(finding.status)).length;
    const h2 = findingsMd.split("\n").filter((line) => line.startsWith("## "));
    const expectedH2 = ["## Ringkasan", `## Temuan terbuka (${openCount})`, `## Temuan ditutup (${activeFindings.length - openCount})`];
    check("berkas temuan hanya berisi bagian yang diminta", h2.join("|") === expectedH2.join("|"), h2.join("|"));
    const findingsBlocks = findingsMd.split("\n### ");
    const wrong = activeFindings
      .filter((finding) => !findingsBlocks.find((item) => item.startsWith(`${finding.id} `))?.includes(`**Status:** ${statusText(finding.status)}`))
      .map((finding) => finding.id);
    check("berkas temuan memuat semua temuan aktif dengan status benar", wrong.length === 0, wrong.join(","));
    check("berkas temuan tanpa daftar pelapor", !findingsMd.includes("Dilaporkan di"));

    if (report.unlinked.length > 0) {
      await page.locator("[data-report-unlinked] button[aria-expanded]").click();
      const shown = await page.locator("[data-unlinked-row]").count();
      check("baris tak tertaut = item JSON", shown === report.unlinked.length, `DOM ${shown} vs JSON ${report.unlinked.length}`);
    }
    if (report.curator.inProgress.length > 0) {
      check("tugas yang masih berjalan tampil", (await page.locator("[data-report-in-progress]").count()) === 1);
    }

    if (report.coverage.length > 0) {
      check("matriks cakupan tampil", (await page.locator("[data-report-coverage] table").count()) === 1);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} ok, ${failures.length} gagal`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error: Error) => {
  console.error(`gate gagal dijalankan: ${error.message}`);
  process.exit(1);
});
