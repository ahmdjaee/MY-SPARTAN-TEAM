import { memo, useEffect, useRef, useState } from "react";
import type { LiveState, StoredEvent } from "../api.ts";
import { requestControl } from "../realtime.ts";
import { LiveControl } from "./LiveControl.tsx";
import { LiveOverlay } from "./LiveOverlay.tsx";

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

  // Ambil alih: `mine` = tab ini yang memintanya. Kendali sungguhan dipegang server (per sambungan),
  // jadi begitu server melaporkan tidak ada yang memegang, tanda lokal ikut padam.
  const held = live.controlledSince !== undefined;
  const [mine, setMine] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string>();
  const controlling = held && mine;
  useEffect(() => {
    if (!held) setMine(false);
  }, [held]);
  // Pindah tugas / tutup tab Live sambil memegang kendali: kembalikan ke agen, jangan biarkan ia menunggu.
  const mineRef = useRef(false);
  mineRef.current = controlling;
  useEffect(
    () => () => {
      if (mineRef.current) void requestControl(taskId, "release");
    },
    [taskId],
  );
  const toggleControl = async () => {
    setControlBusy(true);
    setControlError(undefined);
    const action = controlling ? "release" : "take";
    const answer = await requestControl(taskId, action);
    setControlBusy(false);
    if (!answer.ok) setControlError(answer.error ?? "gagal");
    else setMine(action === "take");
  };

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
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {live.active && (
            <button
              type="button"
              disabled={controlBusy}
              onClick={() => void toggleControl()}
              title={
                controlling
                  ? "Kembalikan browser ke bot; tool browser-nya lanjut dengan ringkasan apa yang Anda lakukan"
                  : "Klik dan ketik sendiri di browser bot; tool browser bot menunggu sampai Anda menyerahkannya kembali"
              }
              className={`rounded-lg px-2 py-1 disabled:opacity-50 ${
                controlling ? "bg-accent text-on-accent hover:bg-accent-hover" : "border border-line-strong text-ink hover:bg-hover"
              }`}
            >
              {controlling ? "Serahkan ke bot" : "Ambil alih"}
            </button>
          )}
          {showStream && (
            <a
              href={`/api/tasks/${encodeURIComponent(taskId)}/live`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-line-strong px-2 py-1 text-ink hover:bg-hover"
            >
              Buka di tab baru
            </a>
          )}
        </div>
      </div>

      {(held || controlError) && (
        <p
          className={`mt-2 rounded-lg px-3 py-1.5 text-xs ${
            controlError ? "bg-tag-red text-tag-red-ink" : "bg-tag-yellow text-tag-yellow-ink"
          }`}
        >
          {controlError
            ? `Tidak bisa mengubah kendali: ${controlError}`
            : controlling
              ? "Anda memegang kendali. Klik, gulung, dan ketik langsung di gambar; tool browser bot menunggu. Isi ketikan Anda tidak dikirim ke bot — hanya jumlah karakternya."
              : "Kendali browser sedang dipegang di tab lain; tool browser bot menunggu. Tekan Ambil alih untuk memindahkannya ke sini."}
        </p>
      )}

      <div className="relative mt-3 min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-sunken">
        {showStream ? (
          connected && (
            <>
              <img
                ref={image}
                key={streamKey}
                src={`/api/tasks/${encodeURIComponent(taskId)}/live?t=${streamKey}`}
                alt="Tampilan browser bot secara langsung"
                className="h-full w-full object-contain"
              />
              {live.active &&
                (controlling && live.viewport ? (
                  <LiveControl taskId={taskId} viewport={live.viewport} />
                ) : (
                  <LiveOverlay taskId={taskId} viewport={live.viewport} />
                ))}
            </>
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
