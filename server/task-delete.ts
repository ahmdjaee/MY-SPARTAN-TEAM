/**
 * Menghapus satu tugas beserta seluruh isi foldernya: transcript, report.md, screenshot,
 * lampiran, unggahan/unduhan uji, dan catatan owner.
 *
 * Yang TIDAK ikut dihapus: data project (register temuan, cakupan, log kurasi, memori).
 * Rujukan ke tugas ini di sana tetap ada dan ditandai "dihapus" lewat tombstone
 * (deleted-tasks.ts), yang juga menyimpan baris rekap terakhirnya untuk report project.
 */
import { askHub } from "./agent/ask.ts";
import { scheduler } from "./agent/scheduler.ts";
import { live } from "./browser/live.ts";
import { notifyProject } from "./changes.ts";
import { recordDeleted } from "./deleted-tasks.ts";
import { buildProjectRecap, forgetProjectRecap } from "./recap.ts";
import { threads } from "./store.ts";
import { ACTIVE_STATUSES, getTask, removeTask } from "./tasks.ts";

export class DeleteTaskError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

export async function deleteTask(id: string): Promise<{ projectId: string }> {
  const task = getTask(id);
  if (!task) throw new DeleteTaskError("tugas tidak ditemukan", 404);
  // Agen yang masih bekerja bisa menulis berkas di tengah penghapusan — owner membatalkannya dulu.
  if (ACTIVE_STATUSES.includes(task.status)) {
    throw new DeleteTaskError("tugas masih berjalan — batalkan dulu sebelum menghapus", 409);
  }

  // Snapshot diambil sebelum apa pun ditutup: setelah folder hilang, report.md tidak bisa dipanen lagi.
  const snapshot = buildProjectRecap(task.projectId, { fresh: true }).entries.find((entry) => entry.taskId === id);

  await scheduler.dispose(id);
  askHub.clear(id);

  // Selama runner ditutup, pesan baru bisa saja menghidupkan tugas ini lagi — kalau begitu, batal.
  // Dari sini sampai removeTask semuanya sinkron, jadi tidak ada lagi yang bisa menyela.
  const latest = getTask(id);
  if (!latest) throw new DeleteTaskError("tugas tidak ditemukan", 404);
  if (ACTIVE_STATUSES.includes(latest.status)) {
    throw new DeleteTaskError("tugas mulai berjalan lagi — batalkan dulu sebelum menghapus", 409);
  }

  const removed = removeTask(id, (current) =>
    recordDeleted({
      id: current.id,
      title: current.title,
      role: current.role,
      projectId: current.projectId,
      status: current.status,
      createdAt: current.createdAt,
      deletedAt: new Date().toISOString(),
      costUsd: current.costUsd,
      recap: snapshot,
    }),
  );
  if (!removed) throw new DeleteTaskError("tugas tidak ditemukan", 404);

  threads.forget(id);
  live.forget(id);
  forgetProjectRecap(removed.projectId);
  // Report project memuat ulang: baris rekapnya pindah ke "dihapus", rujukannya diberi label.
  notifyProject(removed.projectId);
  return { projectId: removed.projectId };
}
