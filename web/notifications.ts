import type { AttentionEvent } from "../server/types.ts";
import type { NotificationSettings } from "../server/settings.ts";

export type { AttentionEvent, NotificationSettings };

const BASE_TITLE = "AI Team";

export function permissionState(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Harus dipanggil dari gestur pengguna (tombol di Pengaturan). */
export async function requestPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return await Notification.requestPermission();
}

/**
 * Satu aliran untuk seluruh aplikasi, supaya notifikasi tetap jalan di tugas mana pun.
 * `onTasksChanged` dipanggil saat server menandai daftar tugas berubah (dan saat
 * sambungan terbuka/pulih), menggantikan polling daftar yang rapat.
 */
export function startAttentionStream(
  onEvent: (event: AttentionEvent) => void,
  onTasksChanged?: () => void,
): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as AttentionEvent);
    } catch {
      // event rusak dilewati
    }
  };
  source.addEventListener("tasks_changed", () => onTasksChanged?.());
  source.onopen = () => onTasksChanged?.();
  return () => source.close();
}

function enabledFor(kind: AttentionEvent["kind"], settings: NotificationSettings): boolean {
  if (kind === "approval") return settings.approval;
  if (kind === "question") return settings.question;
  if (kind === "needs_review") return settings.needsReview;
  return settings.failed;
}

export function maybeNotify(
  event: AttentionEvent,
  settings: NotificationSettings,
  onClick: (taskId: string) => void,
): void {
  if (!enabledFor(event.kind, settings)) return;
  if (settings.onlyWhenHidden && !document.hidden) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

  const notification = new Notification(`${event.taskId} · ${event.title}`, {
    body: event.detail ?? "",
    tag: `${event.taskId}-${event.kind}`,
    // Approval & pertanyaan menunggu Anda: jangan hilang sendiri.
    requireInteraction: event.kind === "approval" || event.kind === "question",
  });
  notification.onclick = () => {
    window.focus();
    onClick(event.taskId);
    notification.close();
  };
}

/** Penanda jumlah yang menunggu keputusan di judul tab: "(2) AI Team". */
export function setTitleBadge(count: number): void {
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}
