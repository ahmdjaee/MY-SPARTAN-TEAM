import { bus } from "./agent/bus.ts";
import { threads } from "./store.ts";
import { activeTasks, updateTask } from "./tasks.ts";

/**
 * Setelah server dimulai ulang, approval/pertanyaan yang belum sempat dijawab
 * tidak punya pemiliknya lagi. Tutup di transcript supaya UI tidak menampilkan
 * kartu yang tidak bisa diklik.
 *
 * Permintaan hanya bisa terbuka selama turn berjalan, jadi cukup tugas yang statusnya masih aktif —
 * tidak perlu mem-parse transcript semua tugas saat start. Transcript tugas itu dipindai utuh.
 */
export function closeOrphanRequests(): number {
  let closed = 0;
  for (const task of activeTasks()) {
    // Setelah restart tidak ada runner yang memegang permintaan apa pun lagi.
    if (task.status === "waiting") updateTask(task.id, { status: "needs_review" });
    const events = threads.readAfter(task.id, 0);
    const resolved = new Set<string>();
    for (const event of events) {
      if (event.type === "approval_resolved") resolved.add(event.approvalId);
      if (event.type === "question_resolved") resolved.add(event.questionId);
    }
    for (const event of events) {
      if (event.type === "approval" && !resolved.has(event.approvalId)) {
        bus.emit(task.id, event.role, {
          type: "approval_resolved",
          approvalId: event.approvalId,
          decision: "deny",
          message: "Server dimulai ulang sebelum keputusan diambil.",
        });
        closed += 1;
      }
      if (event.type === "question" && !resolved.has(event.questionId)) {
        bus.emit(task.id, event.role, { type: "question_resolved", questionId: event.questionId, answers: {} });
        closed += 1;
      }
    }
  }
  return closed;
}
