import { memo, useEffect, useRef, useState } from "react";
import type { LiveState, StoredEvent } from "../api.ts";

/** Aksi browser terakhir dari thread — tidak perlu data tambahan dari server. */
export function lastBrowserAction(events: StoredEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "tool" && event.name.startsWith("mcp__browser__")) {
      const name = event.name.replace("mcp__browser__", "browser.");
      const input = JSON.stringify(event.input);
      return `${name} ${input === "{}" ? "" : input}`.trim();
    }
  }
  return undefined;
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}

/**
 * Tab Live. Keadaannya (`live`) didorong server lewat WebSocket — tidak ada polling. Gambarnya
 * aliran MJPEG biasa di <img> (hingga 60 fps), diputus saat tab browser disembunyikan supaya server
 * tidak terus mengirim frame; tanpa penonton screencast di Chromium berhenti sendiri.
 */
export const LiveView = memo(function LiveView({
  taskId,
  live,
  lastAction,
}: {
  taskId: string;
  live: LiveState;
  lastAction?: string;
}) {
  const showStream = live.active || Boolean(live.hasFrame);
  const hidden = useDocumentHidden();
  const connected = showStream && !hidden;
  // Dipakai untuk memaksa <img> menyambung ulang setelah sesi baru dimulai atau tab terlihat lagi.
  const [streamKey, setStreamKey] = useState(() => Date.now());
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) setStreamKey(Date.now());
    wasConnected.current = connected;
  }, [connected]);

  // Chrome tidak selalu memutus aliran multipart saat <img> dilepas dari DOM; src kosong memaksanya.
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = image.current;
    return () => {
      if (element) element.src = "";
    };
  }, [streamKey, connected]);

  return (
    <div className="flex h-full flex-col px-6 py-5">
      <div className="flex items-center gap-3 text-xs">
        <span
          className={`flex items-center gap-1.5 rounded px-2 py-0.5 ${
            live.active ? "bg-tag-red text-tag-red-ink" : "bg-hover text-muted"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${live.active ? "animate-pulse bg-tag-red-ink" : "bg-faint"}`} />
          {live.active ? "LIVE" : "tidak aktif"}
        </span>
        <span className="truncate font-mono text-muted" title={live.url}>
          {live.url ?? "—"}
        </span>
        {showStream && (
          <a
            href={`/api/tasks/${encodeURIComponent(taskId)}/live`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto shrink-0 rounded-lg border border-line-strong px-2 py-1 text-ink hover:bg-hover"
          >
            Buka di tab baru
          </a>
        )}
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-sunken">
        {showStream ? (
          connected && (
            <img
              ref={image}
              key={streamKey}
              src={`/api/tasks/${encodeURIComponent(taskId)}/live?t=${streamKey}`}
              alt="Tampilan browser bot secara langsung"
              className="h-full w-full object-contain"
            />
          )
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-faint">
            <div>
              <p>Browser sedang tidak berjalan.</p>
              <p className="mt-1 text-xs text-faint">
                Panel ini menyala sendiri begitu bot membuka halaman. Hanya tugas QA dan UI/UX yang memakai browser.
              </p>
            </div>
          </div>
        )}
      </div>

      <p className="mt-2 truncate font-mono text-[11px] text-muted" title={lastAction}>
        {lastAction ? `aksi terakhir: ${lastAction}` : "belum ada aksi browser"}
      </p>
    </div>
  );
});
