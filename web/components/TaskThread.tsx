import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deriveActivity, formatElapsed, formatTokens, type Activity } from "../activity.ts";
import {
  api,
  type StoredEvent,
  type TaskStatus,
  type UiEvent,
  type WorkerStatus,
} from "../api.ts";
import { renderMarkdown } from "../markdown.ts";
import { ApprovalCard, QuestionCard, ToolCall } from "./Cards.tsx";

const ROLE_LABEL: Record<string, string> = {
  qa: "QA",
  engineer: "Engineer",
  devops: "DevOps",
  uiux: "UI/UX",
};

/** Markdown pesan asisten di-parse sekali per pesan, bukan tiap token streaming atau tiap polling. */
const AssistantMessage = memo(function AssistantMessage({ text, dim }: { text: string; dim?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div className="max-w-[92%]">
      <div className={`markdown text-sm${dim ? " opacity-80" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

function rowKey(event: StoredEvent): string {
  // Tanpa seq: kartu tidak boleh dipasang ulang (dan kehilangan isian) saat seq 0 diganti salinan tersimpan.
  if (event.type === "approval") return `approval-${event.approvalId}`;
  if (event.type === "question") return `question-${event.questionId}`;
  return `${event.seq}-${event.type}-${event.type === "tool" ? event.toolUseId : ""}`;
}

type ToolResult = Extract<UiEvent, { type: "tool_result" }>;

function renderRow(event: StoredEvent, resolved: Set<string>, results: Map<string, ToolResult>) {
  const key = rowKey(event);
  switch (event.type) {
    case "user":
      return (
        <div key={key} className={event.from === "system" ? "" : "flex justify-end"}>
          <div
            className={
              event.from === "system"
                ? "rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted"
                : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-on-accent"
            }
          >
            {event.text}
          </div>
        </div>
      );
    case "assistant":
      return <AssistantMessage key={key} text={event.text} />;
    case "thinking":
      return (
        <details key={key} className="text-xs text-muted">
          <summary className="cursor-pointer select-none">berpikir…</summary>
          <p className="mt-1 whitespace-pre-wrap border-l border-line pl-3 italic">{event.text}</p>
        </details>
      );
    case "tool":
      return <ToolCall key={key} name={event.name} input={event.input} result={results.get(event.toolUseId)} />;
    case "approval":
      return resolved.has(event.approvalId) ? null : <ApprovalCard key={key} event={event} />;
    case "question":
      return resolved.has(event.questionId) ? null : <QuestionCard key={key} event={event} />;
    case "approval_resolved":
      return (
        <p key={key} className="text-xs text-muted">
          Keputusan Anda: {event.decision === "allow" ? "diizinkan" : "ditolak"}
          {event.remember ? " (diingat)" : ""}
          {event.message ? ` — ${event.message}` : ""}
        </p>
      );
    case "notice":
      return (
        <p key={key} data-thread-notice className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted">
          {event.text}
        </p>
      );
    case "compact":
      return (
        <p key={key} data-thread-compact className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted">
          Konteks diringkas {event.trigger === "auto" ? "otomatis" : "manual"} pada {formatTokens(event.preTokens)} token. Bot bisa kehilangan detail lama; laporan dan register tetap utuh.
        </p>
      );
    case "handoff":
      return (
        <p key={key} className="rounded-lg border border-line bg-tag-blue px-3 py-2 text-xs text-tag-blue-ink">
          Dioper: {ROLE_LABEL[event.from] ?? event.from} → {ROLE_LABEL[event.to] ?? event.to}
          {event.note ? ` · ${event.note}` : ""}
        </p>
      );
    case "result":
      return (
        <p key={key} className="border-t border-line pt-2 text-[11px] text-faint">
          {event.interrupted ? "dihentikan" : event.subtype}
          {event.background ? " · dimulai CLI" : ""} · {event.numTurns} turn · {(event.durationMs / 1000).toFixed(0)}s
          {/* costUsd = total berjalan sesi; event lama belum punya biaya per turn. */}
          {event.turnCostUsd !== undefined
            ? ` · $${event.turnCostUsd.toFixed(4)}`
            : event.costUsd !== undefined
              ? ` · total sesi $${event.costUsd.toFixed(4)}`
              : ""}
        </p>
      );
    case "error":
      return (
        <p key={key} className="rounded-lg border border-line bg-tag-red p-2 text-xs text-tag-red-ink">
          {event.message}
        </p>
      );
    default:
      return null;
  }
}

/** Timer hidup di sini: tick per detik tidak boleh me-render ulang seluruh thread. */
function ActivityBar({ activity }: { activity?: Activity }) {
  const since = activity?.since;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);

  if (!activity) return null;
  const waiting = activity.tone === "waiting";

  return (
    <div
      role="status"
      className={`flex items-center gap-2 text-xs ${waiting ? "text-tag-yellow-ink" : "text-muted"}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${waiting ? "bg-tag-yellow-ink" : "bg-accent motion-safe:animate-pulse"}`}
      />
      <span className="min-w-0 truncate">{activity.label}</span>
      {since && (
        <span aria-hidden="true" className="shrink-0 tabular-nums text-faint">
          {formatElapsed(now - new Date(since).getTime())}
        </span>
      )}
    </div>
  );
}

/** Tinggi maksimum kotak ketik (±8 baris); setelah itu isinya yang di-scroll. */
const INPUT_MAX_HEIGHT = 176;

export function TaskThread({
  taskId,
  events,
  status,
  taskStatus,
  streaming,
  error,
  disconnected = false,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  canSend,
}: {
  taskId: string;
  events: StoredEvent[];
  status: WorkerStatus;
  taskStatus?: TaskStatus;
  streaming: string;
  error?: string;
  disconnected?: boolean;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void>;
  canSend: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Boleh ikut turun atau tidak — di ref supaya efek di bawah tidak membaca nilai basi.
  const stick = useRef(true);
  const instant = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  // Seq event terakhir, bukan panjang array: memuat event lama (prepend) bukan "pesan baru".
  const tailSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
  const lastTail = useRef(tailSeq);

  // Toleransi supaya "hampir di dasar" tetap dihitung sedang mengikuti.
  const NEAR_BOTTOM = 80;
  // Jarak dari atas tempat riwayat lama mulai dimuat, sebelum Anda benar-benar sampai di ujung.
  const LOAD_OLDER_THRESHOLD = 200;
  // Event scroll datang beruntun sebelum `loadingOlder` sempat berubah: cegah permintaan ganda.
  const fetchingOlder = useRef(false);

  const onScroll = () => {
    const el = viewport.current;
    if (!el) return;
    const bottomNow = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM;
    stick.current = bottomNow;
    setAtBottom(bottomNow);
    if (bottomNow) setHasNew(false);
    // Hanya dipicu oleh guliran Anda — kalau gagal, guliran berikutnya yang mencoba lagi.
    if (hasMore && !loadingOlder && el.scrollTop < LOAD_OLDER_THRESHOLD) void loadOlder();
  };

  const jumpToBottom = (behavior: ScrollBehavior = "smooth") => {
    stick.current = true;
    setHasNew(false);
    setAtBottom(true);
    bottom.current?.scrollIntoView({ behavior, block: "end" });
  };

  // Kalau Anda sedang membaca ke atas, tampilan tidak disentuh sama sekali —
  // agen boleh terus menulis, yang muncul hanya tombol "Pesan baru".
  useEffect(() => {
    const grew = tailSeq !== lastTail.current;
    lastTail.current = tailSeq;
    if (stick.current) {
      bottom.current?.scrollIntoView({ behavior: instant.current ? "auto" : "smooth", block: "end" });
      instant.current = false;
    } else if (grew) {
      setHasNew(true);
    }
  }, [tailSeq]);

  // Token streaming datang ±10×/detik: geser langsung ke dasar tanpa animasi yang terus di-restart.
  useEffect(() => {
    if (!streaming) return;
    const el = viewport.current;
    if (stick.current && el) el.scrollTop = el.scrollHeight;
    else if (!stick.current) setHasNew(true);
  }, [streaming]);

  // Membuka tugas lain selalu mendarat di pesan terbaru, tanpa animasi panjang.
  useEffect(() => {
    stick.current = true;
    instant.current = true;
    setHasNew(false);
    setAtBottom(true);
    // Draf untuk tugas lain tidak boleh ikut terbawa.
    setText("");
  }, [taskId]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > INPUT_MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  // Kotak ketik dan bar aktivitas mengubah tinggi area pesan; pesan terakhir jangan sampai tertutup.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const loadOlder = async () => {
    if (fetchingOlder.current || !onLoadOlder) return;
    fetchingOlder.current = true;
    const el = viewport.current;
    const before = el?.scrollHeight ?? 0;
    try {
      await onLoadOlder();
    } finally {
      fetchingOlder.current = false;
    }
    // Baris lama masuk di atas: pertahankan apa yang sedang Anda baca di tempatnya.
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - before;
    });
  };

  // Thread yang belum cukup panjang untuk digulir tidak akan pernah memicu guliran: muat langsung.
  // Bergantung pada jumlah event, jadi kegagalan tidak berulang terus-menerus.
  const eventCount = events.length;
  useEffect(() => {
    const el = viewport.current;
    if (!el || !hasMore || loadingOlder) return;
    if (el.scrollHeight <= el.clientHeight) void loadOlder();
  }, [eventCount, hasMore, loadingOlder]);

  const resolved = useMemo(() => {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.type === "approval_resolved") ids.add(event.approvalId);
      if (event.type === "question_resolved") ids.add(event.questionId);
    }
    return ids;
  }, [events]);

  const results = useMemo(() => {
    const map = new Map<string, ToolResult>();
    for (const event of events) if (event.type === "tool_result") map.set(event.toolUseId, event);
    return map;
  }, [events]);

  // Baris dibentuk ulang hanya saat daftar event berubah — bukan saat token streaming datang.
  const rows = useMemo(() => events.map((event) => renderRow(event, resolved, results)), [events, resolved, results]);

  const streamingNow = Boolean(streaming);
  const activity = useMemo(
    () => deriveActivity({ status, taskStatus, streaming: streamingNow, events }),
    [status, taskStatus, streamingNow, events],
  );

  // Indikatornya bagian dari thread: saat muncul, tetap ikut ke dasar kalau Anda sedang mengikuti.
  const activityLabel = activity?.label;
  useEffect(() => {
    const el = viewport.current;
    if (stick.current && el) el.scrollTop = el.scrollHeight;
  }, [activityLabel]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await api.message(taskId, value);
      // Yang sempat diketik selama pengiriman tidak ikut terhapus.
      setText((current) => (current.trim() === value ? "" : current));
      // Pesan Anda sendiri wajib terlihat.
      jumpToBottom();
    } catch (cause) {
      alert((cause as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={viewport} onScroll={onScroll} className="thread-rows h-full space-y-3 overflow-y-auto px-5 py-4 [overflow-anchor:none]">
          {error && (
            <div className="rounded-lg border border-line bg-tag-red p-3 text-sm text-tag-red-ink">{error}</div>
          )}

          {loadingOlder && <div className="text-center text-xs text-muted">Memuat…</div>}

          {rows}

          {streaming && <AssistantMessage text={streaming} dim />}
          {!disconnected && <ActivityBar activity={activity} />}
          <div ref={bottom} />
        </div>

        {disconnected && (
          <p className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-line bg-tag-yellow px-3 py-1 text-xs text-tag-yellow-ink shadow">
            Sambungan terputus — menyambung ulang…
          </p>
        )}

        {!atBottom && (hasNew || status === "waiting") && (
          <button
            onClick={() => jumpToBottom()}
            className={`absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs shadow-lg ${
              status === "waiting"
                ? "border-line bg-tag-yellow text-tag-yellow-ink"
                : "border-line bg-raised text-ink hover:bg-hover"
            }`}
          >
            {status === "waiting" ? "Menunggu keputusan Anda ↓" : "Pesan baru ↓"}
          </button>
        )}
      </div>

      <div className="px-4 pb-4 pt-2">
        <div
          className={`rounded-2xl border border-line bg-raised transition-colors focus-within:border-accent ${
            canSend ? "" : "opacity-60"
          }`}
        >
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter saat IME masih merangkai kata hanya memilih kata, bukan mengirim.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            disabled={!canSend}
            aria-label="Arahan untuk agen"
            placeholder={canSend ? "Arahan tambahan untuk tugas ini…" : "Tugas sudah ditutup — buka lagi lewat review."}
            className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 text-sm text-ink outline-none placeholder:text-faint"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <span className="hidden truncate pl-1 text-[11px] text-faint sm:block">
              {canSend ? "Enter kirim · Shift+Enter baris baru" : ""}
            </span>
            <button
              onClick={() => void send()}
              disabled={sending || !text.trim() || !canSend}
              aria-label="Kirim"
              title="Kirim"
              className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-hover disabled:bg-hover disabled:text-faint"
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-4 w-4">
                <path
                  d="M8 13V3M3.5 7.5 8 3l4.5 4.5"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
