import { existsSync } from "node:fs";
import { projectOfTask, workspaceForTask } from "./context.ts";
import { ROLES } from "./roles.ts";
import { assetsDir, listAssets, reportPath, taskDir, type Assignment, type Task } from "./tasks.ts";

const CLOSING = [
  "",
  "Tutup pekerjaan dengan bagian `## Ringkasan serah terima` berisi: apa yang Anda kerjakan,",
  "hasil atau temuan utama, apa yang belum selesai, dan apa yang perlu dilakukan berikutnya.",
  "Bagian itu dibaca pemilik produk dan bot berikutnya kalau tugas ini dioper.",
  "Ringkasan itu pendek dan ada di chat; detail lengkapnya tetap di report.md, bukan diulang di sini.",
].join("\n");

/**
 * Instruksi laporan untuk satu tugas.
 *
 * Satu tugas = satu folder = satu `report.md`. Jadi role kedua dan seterusnya
 * MENAMBAH bagiannya sendiri, tidak menimpa laporan role sebelumnya.
 * Dipisah jadi fungsi sendiri supaya bisa diuji gate tanpa menjalankan agen.
 */
export function reportInstruction(task: Task): string {
  if (!ROLES[task.role].producesReport) {
    return "Kalau Anda perlu menyimpan artefak (log, catatan, patch), taruh di run_dir.";
  }
  const path = reportPath(task.id);
  if (existsSync(path)) {
    return [
      `Laporan tugas ini sudah ada di ${path} — ditulis bot sebelumnya.`,
      `TAMBAHKAN bagian Anda di akhir berkas itu, dengan heading \`## <Bagian> — ${ROLES[task.role].title} · <tanggal>\`.`,
      "Jangan mengubah, memotong, atau menghapus bagian yang sudah ada di sana.",
    ].join("\n");
  }
  return `Tulis laporan akhir ke ${path}, ikuti template "Format report.md" di instruksi peran Anda.`;
}

function workspaceBlock(task: Task): string {
  const project = projectOfTask(task.id);
  const lines: string[] = [];
  if (project) lines.push(`project: ${project.name}`);
  lines.push(`workspace: ${workspaceForTask(task.id)}`, `run_dir: ${taskDir(task.id)}`);
  lines.push(reportInstruction(task));
  if (ROLES[task.role].producesReport) {
    lines.push("Artefak lain (log, catatan kerja, patch) taruh juga di run_dir — isinya tampil di tab Lampiran.");
  }
  // Hanya role berbrowser yang punya folder bukti; menyebutnya ke role lain cuma menyesatkan.
  if (ROLES[task.role].usesBrowser) {
    lines.push(
      `Screenshot dari tool browser otomatis tersimpan di ${assetsDir(task.id)} — rujuk dengan path relatif ./assets/<nama>.png.`,
    );
  }
  const target = task.targetUrl || project?.targetUrl;
  if (target) lines.push(`target: ${target}`);
  return lines.join("\n");
}

/** Pesan pembuka saat tugas pertama kali diberikan ke sebuah bot. */
export function composeOpeningMessage(task: Task): string {
  return [
    `# Tugas ${task.id} — ${task.title}`,
    "",
    task.description,
    "",
    workspaceBlock(task),
    CLOSING,
  ].join("\n");
}

/** Pesan pembuka saat tugas dioper ke bot lain: konteks bot sebelumnya ikut diturunkan. */
export function composeHandoffMessage(task: Task, previous: Assignment, note?: string): string {
  const assets = listAssets(task.id);
  const lines = [
    `# Tugas ${task.id} — ${task.title}`,
    "",
    "Tugas ini dioper ke Anda. Instruksi aslinya dari pemilik produk:",
    "",
    task.description,
    "",
    `## Dikerjakan sebelumnya oleh ${ROLES[previous.role].title}`,
    previous.summary?.trim() || "(bot sebelumnya tidak meninggalkan ringkasan)",
  ];

  if (note?.trim()) {
    lines.push("", "## Catatan operan dari pemilik produk", note.trim());
  }

  const artefacts: string[] = [];
  if (task.assignments.some((assignment) => assignment.role === "qa") || assets.length > 0) {
    if (assets.length > 0) artefacts.push(`${assets.length} bukti screenshot di ${taskDir(task.id)}/assets/`);
  }
  artefacts.push(`laporan (kalau ada): ${reportPath(task.id)}`);
  lines.push("", "## Artefak yang sudah ada", ...artefacts.map((item) => `- ${item}`));

  lines.push("", workspaceBlock(task), CLOSING);
  return lines.join("\n");
}

/** Pesan saat pemilik produk meminta perbaikan dari hasil review. */
export function composeReviewMessage(task: Task, comment: string): string {
  return [
    `Review pemilik produk untuk tugas ${task.id} — **perlu perbaikan**.`,
    "",
    comment.trim(),
    "",
    "Tindak lanjuti catatan di atas, lalu perbarui hasil kerja dan ringkasan serah terima Anda.",
  ].join("\n");
}
