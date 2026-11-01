import { useEffect, useState } from "react";
import { api, type LiveState, type StoredEvent } from "../api.ts";

/** Aksi browser terakhir dari thread — tidak perlu data tambahan dari server. */
function lastBrowserAction(events: StoredEvent[]): string | undefined {
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

export function LiveView({ taskId, events }: { taskId: string; events: StoredEvent[] }) {
  const [state, setState] = useState<LiveState>({ active: false });
  // Dipakai untuk memaksa <img> menyambung ulang setelah sesi baru dimulai.
  const [streamKey, setStreamKey] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    let wasShowing = false;

    const poll = async () => {
      try {
        const next = await api.liveStatus(taskId);
        if (!active) return;
        setState(next);
        const showing = next.active || Boolean(next.hasFrame);
        if (showing && !wasShowing) setStreamKey(Date.now());
        wasShowing = showing;
      } catch {
        if (active) setState({ active: false });
      }
    };

    void poll();
    const timer = setInterval(poll, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [taskId]);

  const showStream = state.active || state.hasFrame;
  const action = lastBrowserAction(events);

  return (
    <div className="flex h-full flex-col px-6 py-5">
      <div className="flex items-center gap-3 text-xs">
        <span
          className={`flex items-center gap-1.5 rounded px-2 py-0.5 ${
            state.active ? "bg-tag-red text-tag-red-ink" : "bg-hover text-muted"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${state.active ? "animate-pulse bg-tag-red-ink" : "bg-faint"}`} />
          {state.active ? "LIVE" : "tidak aktif"}
        </span>
        <span className="truncate font-mono text-muted" title={state.url}>
          {state.url ?? "—"}
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
          <img
            key={streamKey}
            src={`/api/tasks/${encodeURIComponent(taskId)}/live?t=${streamKey}`}
            alt="Tampilan browser QA secara langsung"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-faint">
            <div>
              <p>Browser QA sedang tidak berjalan.</p>
              <p className="mt-1 text-xs text-faint">
                Panel ini menyala sendiri begitu QA membuka halaman. Tugas selain QA tidak memakai browser.
              </p>
            </div>
          </div>
        )}
      </div>

      <p className="mt-2 truncate font-mono text-[11px] text-muted" title={action}>
        {action ? `aksi terakhir: ${action}` : "belum ada aksi browser"}
      </p>
    </div>
  );
}
