import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitContain, type Fit, type Point, type Size } from "../live-geometry.ts";
import { sendInput, type OwnerInput } from "../realtime.ts";

const BUTTONS: Record<number, "left" | "middle" | "right"> = { 0: "left", 1: "middle", 2: "right" };
/** deltaMode baris/halaman → piksel, kira-kira seperti Chromium. */
const LINE_PX = 16;

/**
 * Permukaan input saat owner memegang kendali browser bot: mouse, roda, keyboard, dan paste di
 * atas gambar Live diteruskan ke halaman (koordinat sudah dipetakan ke viewport bot).
 *
 * Tombol yang masih tertekan saat fokus hilang atau komponen dilepas dikirim `up`-nya, supaya
 * Shift/Ctrl tidak tertinggal "nyangkut" di browser bot.
 */
export function LiveControl({ taskId, viewport }: { taskId: string; viewport: Size }) {
  const surface = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [focused, setFocused] = useState(false);
  const fit = useRef<Fit | undefined>(undefined);
  fit.current = fitContain(size, viewport);

  const pressedKeys = useRef(new Set<string>());
  const pressedButtons = useRef(new Map<string, { clicks: number }>());
  const lastPoint = useRef<Point>({ x: 0, y: 0 });
  const pendingMove = useRef<Point | undefined>(undefined);
  const wheel = useRef<{ x: number; y: number; dx: number; dy: number } | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);

  const send = (input: OwnerInput) => sendInput(taskId, input);

  /** Titik layar → viewport bot, tanpa dijepit (server yang menjepit). `undefined` kalau belum terukur. */
  const toPage = (clientX: number, clientY: number): Point | undefined => {
    const element = surface.current;
    const current = fit.current;
    if (!element || !current) return undefined;
    const rect = element.getBoundingClientRect();
    return { x: (clientX - rect.left - current.left) / current.scale, y: (clientY - rect.top - current.top) / current.scale };
  };
  const insideImage = (point: Point) => point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height;

  /** Gerakan mouse & roda digabung per frame layar: maksimal ±60 pesan per detik. */
  const schedule = () => {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      if (pendingMove.current) {
        send({ t: "move", ...pendingMove.current });
        pendingMove.current = undefined;
      }
      if (wheel.current) {
        send({ t: "wheel", ...wheel.current });
        wheel.current = undefined;
      }
    });
  };

  const releaseAll = () => {
    for (const key of pressedKeys.current) send({ t: "key", phase: "up", key });
    pressedKeys.current.clear();
    for (const [button, { clicks }] of pressedButtons.current) {
      send({ t: "up", ...lastPoint.current, button: button as "left" | "middle" | "right", clicks });
    }
    pressedButtons.current.clear();
  };

  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.focus();
    return () => observer.disconnect();
  }, []);

  // Roda harus listener non-pasif supaya halaman AI Team sendiri tidak ikut menggulung.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = toPage(event.clientX, event.clientY);
      if (!point) return;
      const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? viewport.height : 1;
      const previous = wheel.current;
      wheel.current = {
        ...point,
        dx: (previous?.dx ?? 0) + event.deltaX * unit,
        dy: (previous?.dy ?? 0) + event.deltaY * unit,
      };
      schedule();
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });

  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      releaseAll();
    },
    [],
  );

  return (
    <div
      ref={surface}
      tabIndex={0}
      role="application"
      aria-label="Kendali browser bot: klik dan ketik langsung di gambar"
      className={`absolute inset-0 cursor-default outline-none ${focused ? "ring-2 ring-inset ring-accent" : ""}`}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        releaseAll();
      }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerMove={(event) => {
        const point = toPage(event.clientX, event.clientY);
        if (!point) return;
        lastPoint.current = point;
        pendingMove.current = point;
        schedule();
      }}
      onPointerDown={(event) => {
        surface.current?.focus();
        const point = toPage(event.clientX, event.clientY);
        const button = BUTTONS[event.button];
        if (!point || !button || !insideImage(point)) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        lastPoint.current = point;
        const clicks = Math.min(3, Math.max(1, event.detail || 1));
        pressedButtons.current.set(button, { clicks });
        send({ t: "down", ...point, button, clicks });
      }}
      onPointerUp={(event) => {
        const button = BUTTONS[event.button];
        const held = button ? pressedButtons.current.get(button) : undefined;
        if (!button || !held) return;
        pressedButtons.current.delete(button);
        const point = toPage(event.clientX, event.clientY) ?? lastPoint.current;
        send({ t: "up", ...point, button, clicks: held.clicks });
      }}
      onKeyDown={(event) => {
        // Ctrl/Cmd+V dibiarkan supaya event paste muncul; isinya dikirim lewat onPaste.
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
        event.preventDefault();
        event.stopPropagation();
        pressedKeys.current.add(event.key);
        send({ t: "key", phase: "down", key: event.key, ctrl: event.ctrlKey, meta: event.metaKey });
      }}
      onKeyUp={(event) => {
        if (!pressedKeys.current.delete(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        send({ t: "key", phase: "up", key: event.key });
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        if (text) send({ t: "text", text: text.slice(0, 5_000) });
      }}
    />
  );
}
