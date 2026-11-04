import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type StoredEvent,
  type UiEvent,
  type WorkerStatus,
} from "../api.ts";
import { renderMarkdown } from "../markdown.ts";
import { ApprovalCard, QuestionCard, ToolCall } from "./Cards.tsx";

const ROLE_LABEL: Record<string, string> = {
  qa: "QA",
  engineer: "Engineer",
  devops: "DevOps",
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
  // Permintaan terbuka datang dengan seq 0 — id-nya yang membedakan.
  const suffix =
    event.type === "approval"
      ? event.approvalId
      : event.type === "question"
        ? event.questionId
        : event.type === "tool"
          ? event.toolUseId
          : "";
  return `${event.seq}-${event.type}-${suffix}`;
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
          {event.subtype} · {event.numTurns} turn · {(event.durationMs / 1000).toFixed(0)}s
          {event.costUsd !== undefined ? ` · $${event.costUsd.toFixed(4)}` : ""}
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

export function TaskThread({
  taskId,
  events,
  status,
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

  const onScroll = () => {
    const el = viewport.current;
    if (!el) return;
    const bottomNow = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM;
    stick.current = bottomNow;
    setAtBottom(bottomNow);
    if (bottomNow) setHasNew(false);
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
  }, [taskId]);

  const loadOlder = async () => {
    const el = viewport.current;
    const before = el?.scrollHeight ?? 0;
    await onLoadOlder?.();
    // Baris lama masuk di atas: pertahankan apa yang sedang Anda baca di tempatnya.
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - before;
    });
  };

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

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await api.message(taskId, value);
      setText("");
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
        <div ref={viewport} onScroll={onScroll} className="h-full space-y-3 overflow-y-auto px-5 py-4">
          {error && (
            <div className="rounded-lg border border-line bg-tag-red p-3 text-sm text-tag-red-ink">{error}</div>
          )}

          {hasMore && (
            <div className="flex justify-center">
              <button
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
              >
                {loadingOlder ? "Memuat…" : "Muat lebih lama ↑"}
              </button>
            </div>
          )}

          {rows}

          {streaming && <AssistantMessage text={streaming} dim />}
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

      <div className="border-t border-line p-3">
        <div className="flex items-end gap-2">
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
            disabled={!canSend}
            placeholder={
              canSend ? "Arahan tambahan untuk tugas ini… (Enter kirim)" : "Tugas sudah ditutup — buka lagi lewat review."
            }
            className="flex-1 resize-none rounded-xl border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            onClick={() => void send()}
            disabled={sending || !text.trim() || !canSend}
            className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
          >
            Kirim
          </button>
        </div>
        {status === "waiting" && (
          <p className="mt-2 text-xs text-tag-yellow-ink">Agen berhenti menunggu keputusan Anda di kartu di atas.</p>
        )}
      </div>
    </div>
  );
}
