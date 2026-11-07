/**
 * Uji alur status temuan dan laporan tugas. Tanpa model, memakai DATA_DIR sementara:
 * bun run check:findings
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "ai-team-findings-"));
process.env.DATA_DIR = dataDir;

// Pengaman: skrip ini menulis data, jadi tidak boleh jalan di atas data sungguhan.
const { CONFIG } = await import("../server/config.ts");
if (CONFIG.dataDir !== dataDir) throw new Error(`DATA_DIR tidak terpakai: ${CONFIG.dataDir}`);

const { readLog, readRegister, recordRetest, reportFixed, revertLog, upsertFinding } = await import("../server/findings.ts");
const { reportFixedFor } = await import("../server/context.ts");
const { createProject } = await import("../server/projects.ts");
const { findingHeads, reportRounds, verdictOf } = await import("../server/recap.ts");
const { renderTaskFindingsMarkdown } = await import("../server/report-markdown.ts");
const { buildTaskFindings } = await import("../server/task-report.ts");
const { createTask } = await import("../server/tasks.ts");

let failed = 0;
function expect(name: string, actual: unknown, wanted: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok   " : "GAGAL"} ${name}${ok ? "" : ` — dapat ${JSON.stringify(actual)}, harusnya ${JSON.stringify(wanted)}`}`);
}
function throws(name: string, run: () => unknown, pattern: RegExp): void {
  try {
    run();
    expect(name, "tidak melempar", String(pattern));
  } catch (error) {
    expect(name, pattern.test((error as Error).message), true);
  }
}

try {
  const P = createProject({ name: "Proyek A" }).id;
  const other = createProject({ name: "Proyek Lain" }).id;
  const status = (id: string) => readRegister(P).findings.find((finding) => finding.id === id);
  const create = (title: string) => upsertFinding(P, { title, severity: "major", occurrence: { taskId: "T-100", localId: "T-1" } }, "uji").id;

  // ---------- transisi ----------
  const a = create("Tombol simpan gagal");
  throws("catatan perbaikan wajib", () => reportFixed(P, a, { taskId: "T-101", note: "  " }), /wajib/);
  reportFixed(P, a, { taskId: "T-101", note: "validasi diperbaiki", commit: "abc123" });
  expect("perbaikan → needs_retest", status(a)?.status, "needs_retest");
  expect("hash commit dicatat", status(a)?.fix?.by, "abc123");

  throws("bukti retest wajib", () => recordRetest(P, a, { taskId: "T-102", passed: false, note: "x", evidence: "" }), /wajib/);
  recordRetest(P, a, { taskId: "T-102", passed: false, note: "masih gagal", evidence: "./assets/a.png" });
  expect("retest gagal → open", status(a)?.status, "open");
  expect("retest gagal menandai regresi", Boolean(status(a)?.reopenedAt), true);

  reportFixed(P, a, { taskId: "T-103", note: "perbaikan kedua" });
  expect("tanpa commit, by = id tugas", status(a)?.fix?.by, "T-103");
  recordRetest(P, a, { taskId: "T-104", passed: true, note: "lolos", evidence: "./assets/b.png" });
  expect("retest lolos → fixed", status(a)?.status, "fixed");
  expect("retest lolos terverifikasi", Boolean(status(a)?.lastVerifiedAt), true);
  expect("retest lolos menghapus regresi", status(a)?.reopenedAt, undefined);
  expect("penutupan punya bukti", status(a)?.resolution?.note.includes("./assets/b.png"), true);
  throws("temuan tertutup tidak bisa diklaim diperbaiki", () => reportFixed(P, a, { taskId: "T-105", note: "lagi" }), /sudah ditutup/);

  const stillOpen = create("Masih terbuka");
  recordRetest(P, stillOpen, { taskId: "T-102", passed: false, note: "masih ada", evidence: "./assets/c.png" });
  expect("gagal pada temuan terbuka bukan regresi", status(stillOpen)?.reopenedAt, undefined);

  // ---------- pembatalan lewat log ----------
  const b = create("Bisa dibatalkan");
  reportFixed(P, b, { taskId: "T-106", note: "klaim keliru" });
  const entry = readLog(P).find((item) => item.target === b && item.action === "status");
  revertLog(P, entry!.at, "owner", () => undefined, () => "", { action: "status", target: b });
  expect("pembatalan mengembalikan status", status(b)?.status, "open");
  expect("pembatalan menghapus catatan perbaikan", status(b)?.fix, undefined);

  // ---------- batas project ----------
  const foreign = upsertFinding(other, { title: "Milik project lain", severity: "minor" }, "uji");
  for (let n = 0; n < 5; n += 1) upsertFinding(other, { title: `Pengisi ${n}`, severity: "minor" }, "uji");
  const onlyInOther = readRegister(other).findings.at(-1)!;
  const task = createTask({ title: "Uji", description: "", role: "engineer", projectId: P });
  expect("temuan di luar project tugas ditolak", reportFixedFor(task.id, onlyInOther.id, "tidak ada").isError, true);
  expect("register project lain tidak tersentuh", readRegister(other).findings.find((item) => item.id === onlyInOther.id)?.status, "open");
  expect("id sama di project lain tetap terpisah", foreign.status, "open");

  // ---------- pembacaan laporan ----------
  const report = `# Laporan QA — Uji

- **Hasil:** GAGAL

## Temuan (BUG)
### T-1 · Tombol simpan gagal · major · ref ${a}
- **Bukti:** ![](./assets/a.png)
### T-2 · Teks terpotong · minor
- **Kenyataan:** terpotong.

## Ringkasan serah terima
- **Hasil:** kalimat bebas tanpa kata verdict.

## Perbaikan F-001 — Engineer

- **Hasil:** SELESAI

### Temuan yang ditangani
Isi.

## Uji ulang — QA

- **Hasil:** LULUS DENGAN CATATAN

### Temuan
#### T-1 · Hal lain · minor · ref ${stillOpen}
Isi retest.

## Ringkasan serah terima
- **Hasil:** semua sudah dicek.
`;
  expect("verdict melewati kalimat bebas", verdictOf(report)?.text, "LULUS DENGAN CATATAN");
  const rounds = reportRounds(report);
  expect("jumlah putaran", rounds.length, 3);
  expect("verdict tiap putaran", rounds.map((round) => round.verdict?.text), ["GAGAL", "SELESAI", "LULUS DENGAN CATATAN"]);
  expect("gabungan putaran sama dengan berkas", rounds.map((round) => round.body).join(""), report);
  expect("laporan tanpa Hasil di awal tetap satu putaran", reportRounds("# Judul\n\n## Ringkasan\n- **Hasil:** LULUS\n").length, 1);
  expect("berkas kosong", reportRounds("  \n"), []);
  expect("uji ulang tanpa baris Hasil tetap putaran baru", reportRounds("# J\n\n- **Hasil:** GAGAL\n\n## Uji ulang (putaran 2)\nisi\n").length, 2);
  expect("format T-n dengan garis panjang terbaca", findingHeads("### T-3 — Judul (tinggi)\nisi\n").map((head) => head.id), ["T-3"]);
  expect("heading temuan terbaca", findingHeads(report).map((head) => head.id), ["T-1", "T-2", "T-1"]);

  const view = buildTaskFindings("T-100", report, readRegister(P));
  const blockOf = (id: string) => [...view.opened, ...view.resolved].find(({ finding }) => finding.id === id)?.blocks.map((block) => block.heading);
  expect("T-1 kembar mengarah ke blok masing-masing", [blockOf(a), blockOf(stillOpen)], [[`T-1 · Tombol simpan gagal · major · ref ${a}`], [`T-1 · Hal lain · minor · ref ${stillOpen}`]]);
  expect("fixed masuk Resolved", view.resolved.some(({ finding }) => finding.id === a), true);
  expect("open masuk Temuan", view.opened.some(({ finding }) => finding.id === stillOpen), true);
  expect("temuan baru berlabel belum masuk register", view.unlinked.map((item) => item.id), ["T-2"]);

  const engineerView = buildTaskFindings("T-103", "", readRegister(P));
  expect("tugas perbaikan ikut melihat temuannya", engineerView.resolved.map(({ finding }) => finding.id), [a]);
  const retestView = buildTaskFindings("T-104", "", readRegister(P));
  expect("tugas retest melihat temuannya", retestView.resolved.map(({ finding }) => finding.id), [a]);

  const markdown = renderTaskFindingsMarkdown({ task: { id: "T-100", title: "Uji" }, project: { name: "A" }, generatedAt: new Date().toISOString(), ...view });
  expect("unduhan dibagi Temuan dan Resolved", /## Temuan \(\d+\)[\s\S]*## Resolved \(\d+\)/.test(markdown), true);
  expect("unduhan tidak memuat path gambar", markdown.includes("./assets/a.png)") && markdown.includes("!["), false);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} GAGAL` : "\nsemua lolos");
process.exit(failed ? 1 : 0);
