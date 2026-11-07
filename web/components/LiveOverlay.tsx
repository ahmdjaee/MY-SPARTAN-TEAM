import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BrowserAction } from "../api.ts";
import { fitContain, toScreen, type Point, type Size } from "../live-geometry.ts";
import { subscribe } from "../realtime.ts";

/** Sorotan elemen target bertahan sebentar, lalu memudar. */
const HIGHLIGHT_MS = 1_600;
/** Keterangan aksi terakhir; setelah ini meredup supaya tidak menutupi halaman. */
const CAPTION_MS = 4_000;

type Shown = BrowserAction & { id: number };

const MOVES_CURSOR = new Set<BrowserAction["kind"]>(["click", "fill", "hover", "select", "upload", "press"]);

function Cursor({ point }: { point: Point }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      className="live-cursor absolute top-0 left-0 drop-shadow"
      style={{ transform: `translate(${point.x - 3}px, ${point.y - 2}px)` }}
    >
      <path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.4 12.6 L16.6 12.6 Z" fill="#111" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * Lapisan di atas gambar Live: kursor yang bergerak ke target, riak klik, sorotan elemen, dan
 * keterangan aksi. Murni tampilan (pointer-events: none) — halaman bot tidak pernah disentuh.
 * Menyimak topik `live:<id>` hanya selama terpasang; tanpa penyimak server tidak mengukur apa pun.
 */
export const LiveOverlay = memo(function LiveOverlay({ taskId, viewport }: { taskId: string; viewport?: Size }) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [action, setAction] = useState<Shown>();
  const [cursor, setCursor] = useState<Point>();
  const [highlight, setHighlight] = useState(false);
  const [captionOn, setCaptionOn] = useState(false);

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let next = 1;
    setAction(undefined);
    setCursor(undefined);
    return subscribe<{ type: "browser_action" } & BrowserAction>(`live:${taskId}`, (event) => {
      if (event.type !== "browser_action") return;
      const { type: _type, ...rest } = event;
      setAction({ ...rest, id: next++ });
      // Tool berbasis koordinat membawa titik persis; tool selector cukup ke tengah elemennya.
      if (rest.point) setCursor(rest.point);
      else if (rest.box && MOVES_CURSOR.has(rest.kind)) {
        setCursor({ x: rest.box.x + rest.box.width / 2, y: rest.box.y + rest.box.height / 2 });
      }
    });
  }, [taskId]);

  useEffect(() => {
    if (!action) return;
    setHighlight(Boolean(action.box));
    setCaptionOn(true);
    const offHighlight = setTimeout(() => setHighlight(false), HIGHLIGHT_MS);
    const offCaption = setTimeout(() => setCaptionOn(false), CAPTION_MS);
    return () => {
      clearTimeout(offHighlight);
      clearTimeout(offCaption);
    };
  }, [action]);

  const fit = viewport ? fitContain(size, viewport) : undefined;
  const box = action?.box && fit ? { ...toScreen(action.box, fit), width: action.box.width * fit.scale, height: action.box.height * fit.scale } : undefined;
  const pointer = cursor && fit ? toScreen(cursor, fit) : undefined;

  return (
    <div ref={frame} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {box && (
        <div
          className={`absolute rounded-md border-2 border-accent bg-accent/10 transition-opacity duration-500 ${highlight ? "opacity-100" : "opacity-0"}`}
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        />
      )}
      {pointer && action?.kind === "click" && (
        <span
          key={action.id}
          className="live-ripple absolute h-8 w-8 rounded-full border-2 border-accent"
          style={{ left: pointer.x - 16, top: pointer.y - 16 }}
        />
      )}
      {pointer && <Cursor point={pointer} />}
      {action?.kind === "shot" && <div key={action.id} className="live-flash absolute inset-0 bg-white" />}

      {action && (
        <div
          className={`absolute bottom-3 left-3 flex max-w-[80%] items-center gap-2 rounded-lg border border-line bg-raised/95 px-3 py-1.5 text-xs text-ink shadow-sm transition-opacity duration-500 ${
            captionOn ? "opacity-100" : "opacity-40"
          }`}
        >
          <span className="truncate">{action.label}</span>
          {action.key && (
            <kbd className="shrink-0 rounded border border-line-strong bg-sunken px-1.5 font-mono text-[11px]">{action.key}</kbd>
          )}
          {action.text !== undefined && action.text !== "" && (
            <span className="truncate font-mono text-muted">“{action.text}”</span>
          )}
        </div>
      )}
    </div>
  );
});
