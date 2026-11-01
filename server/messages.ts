import { projectOfTask, workspaceForTask } from "./context.ts";
import { ROLES } from "./roles.ts";
import { listAssets, reportPath, taskDir, type Assignment, type Task } from "./tasks.ts";

const CLOSING = [
  "",
  "Tutup pekerjaan dengan bagian `## Ringkasan serah terima` berisi: apa yang Anda kerjakan,",
  "hasil atau temuan utama, apa yang belum selesai, dan apa yang perlu dilakukan berikutnya.",
  "Bagian itu dibaca pemilik produk dan bot berikutnya kalau tugas ini dioper.",
].join("\n");

function workspaceBlock(task: Task): string {
  const project = projectOfTask(task.id);
  const lines: string[] = [];
  if (project) lines.push(`project: ${project.name}`);
  lines.push(`workspace: ${workspaceForTask(task.id)}`, `run_dir: ${taskDir(task.id)}`);
  if (ROLES[task.role].producesReport) {
    lines.push(
      `Tulis laporan akhir ke ${taskDir(task.id)}/report.md. Screenshot dari tool browser otomatis tersimpan di`,
      `${taskDir(task.id)}/assets/ — rujuk dengan path relatif ./assets/<nama>.png.`,
    );
  } else {
    lines.push(`Kalau Anda perlu menyimpan artefak (log, catatan, patch), taruh di folder itu.`);
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
