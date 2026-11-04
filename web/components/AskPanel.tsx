import { memo, useEffect, useMemo, useRef, useState } from "react";
import { api, type AskMessage } from "../api.ts";
import { renderMarkdown } from "../markdown.ts";

const WIDTH_KEY = "ai-team-ask-width";
const DEFAULT_WIDTH = 352;
const MIN_WIDTH = 280;
/** Sisakan ruang untuk isi tugas, berapa pun lebar layarnya. */
const maxWidth = (): number => Math.max(MIN_WIDTH, Math.min(900, window.innerWidth - 420));

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= MIN_WIDTH) return stored;
  } catch {
    // localStorage bisa diblokir; pakai bawaan
  }
  return DEFAULT_WIDTH;
}

/**
 * Panel Tanya (incognito): sesi Claude terpisah yang tahu seluk-beluk satu tugas,
 * tapi tidak pernah menulis ke percakapan tugas itu dan tidak tersimpan di disk.
 */
/** Jawaban di-parse sekali per isi — setiap token streaming tidak merender ulang seluruh riwayat. */
const AskAnswer = memo(function AskAnswer({ text, dim }: { text: string; dim?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`markdown text-sm${dim ? " opacity-80" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
});

export function AskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [model, setModel] = useState("");
  const [cost, setCost] = useState(0);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(readWidth);
  const [dragging, setDragging] = useState(false);

  // Lebar disimpan di browser dan dijepit ulang saat jendela mengecil, supaya
  // panel tidak pernah menelan seluruh layar.
  const clamp = (value: number) => Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(value)));

  useEffect(() => {
    const onResize = () => setWidth((value) => clamp(value));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Disimpan setelah tarikan selesai, bukan di tiap pointermove.
  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // localStorage bisa diblokir; abaikan
    }
  }, [width, dragging]);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setStreaming("");
    setError(undefined);
    void api.askHistory(taskId).then((data) => {
      if (!active) return;
      setMessages(data.messages);
      setModels(data.models);
      setModel((current) => current || data.models[0]?.id || "");
      setCost(data.costUsd);
      setBusy(data.busy);
    });

    const source = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/ask/events`);
    source.onmessage = (event) => {
      if (!active) return;
      let data:
        | { type: "delta"; text: string }
        | { type: "answer"; message: AskMessage }
        | { type: "busy"; busy: boolean }
        | { type: "error"; message: string };
      try {
        data = JSON.parse(event.data) as typeof data;
      } catch {
        return;
      }
      if (data.type === "delta") setStreaming((previous) => previous + data.text);
      if (data.type === "answer") {
        setStreaming("");
        setMessages((previous) => [...previous, data.message]);
        setCost((previous) => Number((previous + (data.message.costUsd ?? 0)).toFixed(6)));
      }
      if (data.type === "busy") setBusy(data.busy);
      if (data.type === "error") setError(data.message);
    };

    return () => {
      active = false;
      source.close();
    };
  }, [taskId]);

  // Ikut turun hanya kalau Anda memang sedang di dasar — membaca jawaban lama tidak boleh ditarik ke bawah.
  const viewport = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = viewport.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
  };
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages.length, streaming]);

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    setError(undefined);
    setMessages((previous) => [...previous, { role: "user", text: value, ts: new Date().toISOString() }]);
    try {
      await api.ask(taskId, { text: value, model });
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const clear = async () => {
    await api.clearAsk(taskId).catch(() => undefined);
    setMessages([]);
    setStreaming("");
    setCost(0);
    setError(undefined);
  };

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-line bg-panel" style={{ width }}>
      {/* Gagang lebar: hanya horizontal — tinggi panel selalu mengikuti tinggi layar. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Atur lebar panel Tanya"
        tabIndex={0}
        title="Tarik untuk mengatur lebar · klik dua kali untuk mengembalikan"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          setWidth(clamp(window.innerWidth - event.clientX));
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => setDragging(false)}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={() => setWidth(clamp(DEFAULT_WIDTH))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setWidth((value) => clamp(value + (event.key === "ArrowLeft" ? 24 : -24)));
        }}
        className={`absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize ${
          dragging ? "bg-accent" : "hover:bg-accent-soft"
        }`}
      />
      <div className={`flex items-center gap-2 border-b border-line px-4 py-3 ${dragging ? "select-none" : ""}`}>
        <h3 className="text-sm font-semibold text-ink">Tanya</h3>
        <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">incognito</span>
        <button
          onClick={onClose}
          title="Tutup panel (Esc)"
          aria-label="Tutup panel Tanya"
          className="ml-auto rounded-lg px-2 py-1 text-muted hover:bg-hover hover:text-ink"
        >
          ✕
        </button>
      </div>

      <p className="border-b border-line px-4 py-2 text-[11px] text-faint">
        Tidak masuk percakapan utama, tidak dibaca bot yang mengerjakan tugas ini, dan tidak tersimpan — hilang saat
        server dimulai ulang.
      </p>

      <div ref={viewport} onScroll={onScroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && !streaming && (
          <p className="text-xs text-faint">
            Tanya apa saja soal tugas ini — temuan mana yang penting, kenapa bot memilih suatu langkah, atau minta
            ringkasan laporannya. Ia boleh membaca berkas tugas dan workspace, tapi tidak bisa mengubah apa pun.
          </p>
        )}
        {messages.map((message, index) =>
          message.role === "user" ? (
            <div key={`${message.ts}-${index}`} className="flex justify-end">
              <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3 py-2 text-sm text-on-accent">
                {message.text}
              </div>
            </div>
          ) : (
            <div key={`${message.ts}-${index}`}>
              <AskAnswer text={message.text} />
              {message.costUsd !== undefined && (
                <p className="mt-1 text-[10px] text-faint">${message.costUsd.toFixed(4)}</p>
              )}
            </div>
          ),
        )}
        {streaming && <AskAnswer text={streaming} dim />}
        {busy && !streaming && <p className="text-xs text-faint">memikirkan…</p>}
        {error && <p className="rounded-lg border border-line bg-tag-red p-2 text-xs text-tag-red-ink">{error}</p>}
        <div ref={bottom} />
      </div>

      <div className="border-t border-line p-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Tanya soal tugas ini… (Enter kirim)"
          className="w-full resize-none rounded-xl border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
        <div className="mt-2 flex items-center gap-2">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            title="Model untuk pertanyaan berikutnya"
            className="min-w-0 flex-1 truncate rounded-lg border border-line bg-page px-2 py-1 text-[11px] text-muted"
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => void send()}
            disabled={busy || !text.trim()}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
          >
            Kirim
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-faint">
          {cost > 0 && <span>tanya: ${cost.toFixed(4)}</span>}
          {messages.length > 0 && (
            <button onClick={() => void clear()} className="ml-auto hover:text-tag-red-ink">
              Hapus percakapan
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
