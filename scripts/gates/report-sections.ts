/**
 * Gate: satu report.md bisa memuat bagian dari beberapa peran.
 *
 * Memeriksa dua hal yang menjadi inti perubahan "semua peran menulis laporan":
 *  1. Panen "yang terakhir menang" — verdict dan ringkasan diambil dari bagian terakhir,
 *     sedangkan temuan tetap dikumpulkan dari SEMUA bagian "## Temuan".
 *  2. Instruksi yang dikirim ke bot: menambah bagian kalau report.md sudah ada,
 *     menulis baru kalau belum.
 *
 * Tanpa browser, tanpa agen, tanpa menulis apa pun:  npm run gate:report
 */
import { existsSync } from "node:fs";
import { reportInstruction } from "../../server/messages.ts";
import { findingsOf, summaryOf, verdictOf } from "../../server/recap.ts";
import { getTask, listTasks, loadTasks, reportPath } from "../../server/tasks.ts";

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

const QA = `# Laporan QA — Uji checkout

- **Tanggal:** 2026-11-03 10:00
- **Hasil:** GAGAL

## Ringkasan
Checkout menerima kuantitas negatif sehingga total jadi minus.

## Cakupan uji
| # | Kasus uji | Hasil |
|---|-----------|-------|
| 1 | tambah item | lulus |

## Temuan
### T-1 · Kuantitas negatif diterima · blocker
- **Kenyataan:** total jadi minus.
### T-2 · Tombol Bayar tidak dinonaktifkan · minor · ref F-012

## Rekomendasi
Perbaiki validasi di lapisan form.
`;

const ENGINEER_SECTION = `
## Perbaikan — Engineer · 3 Nov

- **Hasil:** SELESAI SEBAGIAN

### Ringkasan
T-1 sudah diperbaiki di cart.ts; T-2 ditunda karena menunggu keputusan pemilik.

### Perubahan
| File | Perubahan | Alasan |
|------|-----------|--------|
| \`cart.ts:40\` | tolak kuantitas < 1 | T-1 |
`;

const RETEST_SECTION = `
## Uji ulang — QA · 4 Nov

- **Hasil:** LULUS DENGAN CATATAN

### Ringkasan
T-1 terbukti beres. Muncul satu hal baru saat menguji ulang.

## Temuan
### T-3 · Pesan error tidak muncul di mobile · major
`;

/** Bagian lampiran yang menurunkan "Temuan" ke ### — "### T-4" jadi setingkat dengan judul bagiannya. */
const DEMOTED_SECTION = `
## Uji ulang — QA · 5 Nov

- **Hasil:** GAGAL

### Ringkasan
Regresi di checkout.

### Temuan
### T-4 · Tombol bayar hilang · blocker
Langkah: buka /checkout.
#### T-5 · Ikon kurang kontras · minor
### Bukti
- ./assets/x.png
`;

const ENGINEER_ONLY = `# Laporan Engineer — Perbaikan validasi harga

- **Hasil:** SELESAI

## Ringkasan
Validasi harga di cart.ts diperbaiki dan ditutup tiga test baru.

## Ringkasan serah terima
Ini BUKAN bagian ringkasan laporan dan tidak boleh ikut terpanen.
`;

const DEVOPS_ONLY = `# Laporan DevOps — Deploy staging 1300

- **Hasil:** BERHASIL DENGAN CATATAN

## Ringkasan
Staging 1300 di-deploy ulang; satu service perlu dipantau.
`;

const BLOCKED = `# Laporan Engineer — Audit

- **Hasil:** TERBLOKIR

## Ringkasan
Tidak bisa dikerjakan tanpa akses database.
`;

const NO_LABEL = `# Laporan Engineer — Catatan bebas

## Ringkasan
Laporan ini sengaja tidak memakai label Hasil.
`;

function main(): void {
  console.log("\n— panen bagian laporan —");

  // 1. Laporan QA saja.
  check("QA saja: verdict GAGAL (bad)", verdictOf(QA)?.text === "GAGAL" && verdictOf(QA)?.tone === "bad", String(verdictOf(QA)?.text));
  check("QA saja: ringkasan milik QA", summaryOf(QA)?.startsWith("Checkout menerima") === true, summaryOf(QA)?.slice(0, 40));
  const qaFindings = findingsOf(QA);
  check("QA saja: 2 temuan terpanen", qaFindings.length === 2, `${qaFindings.length}`);
  check("QA saja: severity terbaca", qaFindings[0]?.severity === "blocker" && qaFindings[1]?.severity === "minor");
  check("QA saja: ref F-nnn terbaca", qaFindings[1]?.ref === "F-012", qaFindings[1]?.ref ?? "(kosong)");

  // 2. QA + bagian Engineer ditambahkan di bawahnya.
  const both = QA + ENGINEER_SECTION;
  check(
    "QA+Engineer: verdict ikut bagian TERAKHIR (SELESAI SEBAGIAN, warn)",
    verdictOf(both)?.text === "SELESAI SEBAGIAN" && verdictOf(both)?.tone === "warn",
    String(verdictOf(both)?.text),
  );
  check("QA+Engineer: ringkasan milik Engineer", summaryOf(both)?.startsWith("T-1 sudah diperbaiki") === true, summaryOf(both)?.slice(0, 40));
  check("QA+Engineer: temuan QA TIDAK hilang", findingsOf(both).length === 2, `${findingsOf(both).length}`);

  // 3. Tiga bagian, dua di antaranya punya "## Temuan".
  const three = QA + ENGINEER_SECTION + RETEST_SECTION;
  check("tiga bagian: verdict dari uji ulang", verdictOf(three)?.text === "LULUS DENGAN CATATAN", String(verdictOf(three)?.text));
  check("tiga bagian: ringkasan dari uji ulang", summaryOf(three)?.startsWith("T-1 terbukti beres") === true);
  check("tiga bagian: temuan dari SEMUA bagian Temuan (3)", findingsOf(three).length === 3, `${findingsOf(three).length}`);
  check("tiga bagian: temuan baru ikut severity-nya", findingsOf(three)[2]?.severity === "major");

  // 3b. Bagian lampiran dengan "### Temuan": heading temuan setingkat (### T-4) tidak menghentikan bagian,
  // tapi "### Bukti" tetap menghentikannya.
  const demoted = QA + DEMOTED_SECTION;
  const demotedFindings = findingsOf(demoted);
  check("### Temuan: temuan setingkat & di bawahnya ikut (2 + 2)", demotedFindings.length === 4, `${demotedFindings.length}`);
  check("### Temuan: 'Bukti' bukan temuan", demotedFindings.every((finding) => finding.title !== "Bukti"));
  check("### Temuan: ringkasan dari bagian ### Ringkasan", summaryOf(demoted)?.startsWith("Regresi") === true);

  // 4. Kosakata peran lain.
  check("Engineer saja: SELESAI (good)", verdictOf(ENGINEER_ONLY)?.text === "SELESAI" && verdictOf(ENGINEER_ONLY)?.tone === "good");
  check(
    "DevOps: frasa terpanjang menang (BERHASIL DENGAN CATATAN, warn)",
    verdictOf(DEVOPS_ONLY)?.text === "BERHASIL DENGAN CATATAN" && verdictOf(DEVOPS_ONLY)?.tone === "warn",
    String(verdictOf(DEVOPS_ONLY)?.text),
  );
  check("TERBLOKIR dihitung buruk", verdictOf(BLOCKED)?.tone === "bad", String(verdictOf(BLOCKED)?.text));

  // 5. Yang tidak boleh terjadi.
  check("tanpa label Hasil: verdict kosong, bukan karangan", verdictOf(NO_LABEL) === undefined);
  check(
    '"## Ringkasan serah terima" tidak ikut terpanen sebagai ringkasan',
    summaryOf(ENGINEER_ONLY)?.startsWith("Validasi harga") === true,
    summaryOf(ENGINEER_ONLY)?.slice(0, 40),
  );
  check("laporan tanpa heading Ringkasan: undefined (nanti jatuh ke ringkasan operan)", summaryOf(DEVOPS_ONLY.replace("## Ringkasan", "**Ringkasan**")) === undefined);
  check("laporan tanpa bagian Temuan: nol temuan", findingsOf(DEVOPS_ONLY).length === 0);

  const annotated = findingsOf(
    [
      "## Temuan",
      "### T-1 · Email gagal · minor · ref F-029 (konfigurasi, bukan regresi)",
      "### T-2 · Tombol menolak `403` · minor · (kelas sama dengan F-001)",
      "### T-3 · Unduh gagal · major · ref F-015",
    ].join("\n"),
  );
  check("ref berketerangan: severity & ref terbaca", annotated[0]?.severity === "minor" && annotated[0]?.ref === "F-029");
  check("ref berketerangan: keterangan jadi note", annotated[0]?.note === "konfigurasi, bukan regresi", annotated[0]?.note);
  check("keterangan sesudah severity: severity terbaca", annotated[1]?.severity === "minor" && annotated[1]?.note === "kelas sama dengan F-001");
  check("keterangan tidak ikut judul", annotated[1]?.title === "Tombol menolak 403", annotated[1]?.title);
  check("format lama tetap terbaca", annotated[2]?.severity === "major" && annotated[2]?.ref === "F-015" && !annotated[2]?.note);

  // 6. Instruksi yang dikirim ke bot — memakai tugas nyata, hanya membaca.
  console.log("\n— instruksi laporan —");
  loadTasks();
  const all = listTasks();
  const withReport = all.find((task) => existsSync(reportPath(task.id)));
  const withoutReport = all.find((task) => !existsSync(reportPath(task.id)));

  if (withReport) {
    const text = reportInstruction(getTask(withReport.id)!);
    check(
      `${withReport.id} sudah punya report.md → disuruh MENAMBAH`,
      text.includes("TAMBAHKAN") && text.includes("Jangan mengubah"),
      text.split("\n")[0],
    );
  } else {
    skip("instruksi menambah", "tidak ada tugas yang sudah punya report.md");
  }

  if (withoutReport) {
    const text = reportInstruction(getTask(withoutReport.id)!);
    check(
      `${withoutReport.id} belum punya report.md → disuruh MENULIS baru`,
      text.includes("Tulis laporan akhir") && !text.includes("TAMBAHKAN"),
      text.split("\n")[0],
    );
  } else {
    skip("instruksi menulis baru", "semua tugas sudah punya report.md");
  }

  const roles = new Set(all.map((task) => task.role));
  check(
    `semua peran yang ada di data dapat instruksi laporan (${[...roles].join(", ")})`,
    [...roles].every((role) => {
      const task = all.find((item) => item.role === role);
      return task ? /report\.md/.test(reportInstruction(getTask(task.id)!)) : true;
    }),
  );
}

main();
console.log(`\n${passed} hijau, ${failures.length} merah`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
