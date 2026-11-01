import { useEffect, useMemo, useRef, useState } from "react";
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

export function TaskThread({
  taskId,
  events,
  status,
  streaming,
  error,
  canSend,
}: {
  taskId: string;
  events: StoredEvent[];
  status: WorkerStatus;
  streaming: string;
  error?: string;
  canSend: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  // Boleh ikut turun atau tidak — di ref supaya efek di bawah tidak membaca nilai basi.
  const stick = useRef(true);
  const lastLen = useRef(events.length);
  const instant = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);

  // Toleransi supaya "hampir di dasar" tetap dihitung sedang mengikuti.
  const NEAR_BOTTOM = 80;

  const onScroll = () => {
    const el = viewport.current;
    if (!el) return;
    const bottomNow =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM;
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
    const grew = events.length !== lastLen.current || streaming.length > 0;
    lastLen.current = events.length;
    if (stick.current) {
      bottom.current?.scrollIntoView({
        behavior: instant.current ? "auto" : "smooth",
        block: "end",
      });
      instant.current = false;
    } else if (grew) {
      setHasNew(true);
    }
  }, [events.length, streaming]);

  // Membuka tugas lain selalu mendarat di pesan terbaru, tanpa animasi panjang.
  useEffect(() => {
    stick.current = true;
    instant.current = true;
    setHasNew(false);
    setAtBottom(true);
  }, [taskId]);

  const resolved = useMemo(() => {
    const ids = new Set<string>();
    for (const event of events) {
      if (event.type === "approval_resolved") ids.add(event.approvalId);
      if (event.type === "question_resolved") ids.add(event.questionId);
    }
    return ids;
  }, [events]);

  const results = useMemo(() => {
    const map = new Map<string, Extract<UiEvent, { type: "tool_result" }>>();
    for (const event of events)
      if (event.type === "tool_result") map.set(event.toolUseId, event);
    return map;
  }, [events]);

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
        <div
          ref={viewport}
          onScroll={onScroll}
          className="h-full space-y-3 overflow-y-auto px-5 py-4"
        >
          {error && (
            <div className="rounded-lg border border-line bg-tag-red p-3 text-sm text-tag-red-ink">
              {error}
            </div>
          )}

          {events.map((event: StoredEvent) => {
            const key = `${event.seq}-${event.type}`;
            switch (event.type) {
              case "user":
                return (
                  <div
                    key={key}
                    className={
                      event.from === "system" ? "" : "flex justify-end"
                    }
                  >
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
                return (
                  <div key={key} className="max-w-[92%]">
                    <div
                      className="markdown text-sm"
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(event.text),
                      }}
                    />
                  </div>
                );
              case "thinking":
                return (
                  <details key={key} className="text-xs text-muted">
                    <summary className="cursor-pointer select-none">
                      berpikir…
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap border-l border-line pl-3 italic">
                      {event.text}
                    </p>
                  </details>
                );
              case "tool":
                return (
                  <ToolCall
                    key={key}
                    name={event.name}
                    input={event.input}
                    result={results.get(event.toolUseId)}
                  />
                );
              case "approval":
                return resolved.has(event.approvalId) ? null : (
                  <ApprovalCard key={key} event={event} />
                );
              case "question":
                return resolved.has(event.questionId) ? null : (
                  <QuestionCard key={key} event={event} />
                );
              case "approval_resolved":
                return (
                  <p key={key} className="text-xs text-muted">
                    Keputusan Anda:{" "}
                    {event.decision === "allow" ? "diizinkan" : "ditolak"}
                    {event.remember ? " (diingat)" : ""}
                    {event.message ? ` — ${event.message}` : ""}
                  </p>
                );
              case "handoff":
                return (
                  <p
                    key={key}
                    className="rounded-lg border border-line bg-tag-blue px-3 py-2 text-xs text-tag-blue-ink"
                  >
                    Dioper: {ROLE_LABEL[event.from] ?? event.from} →{" "}
                    {ROLE_LABEL[event.to] ?? event.to}
                    {event.note ? ` · ${event.note}` : ""}
                  </p>
                );
              case "result":
                return (
                  <p
                    key={key}
                    className="border-t border-line pt-2 text-[11px] text-faint"
                  >
                    {event.subtype} · {event.numTurns} turn ·{" "}
                    {(event.durationMs / 1000).toFixed(0)}s
                    {event.costUsd !== undefined
                      ? ` · $${event.costUsd.toFixed(4)}`
                      : ""}
                  </p>
                );
              case "error":
                return (
                  <p
                    key={key}
                    className="rounded-lg border border-line bg-tag-red p-2 text-xs text-tag-red-ink"
                  >
                    {event.message}
                  </p>
                );
              default:
                return null;
            }
          })}

          {streaming && (
            <div className="max-w-[92%]">
              <div
                className="markdown text-sm opacity-80"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(streaming) }}
              />
            </div>
          )}
          <div ref={bottom} />
        </div>

        {!atBottom && (hasNew || status === "waiting") && (
          <button
            onClick={() => jumpToBottom()}
            className={`absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs shadow-lg ${
              status === "waiting"
                ? "border-line bg-tag-yellow text-tag-yellow-ink"
                : "border-line bg-raised text-ink hover:bg-hover"
            }`}
          >
            {status === "waiting"
              ? "Menunggu keputusan Anda ↓"
              : "Pesan baru ↓"}
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
              canSend
                ? "Arahan tambahan untuk tugas ini… (Enter kirim)"
                : "Tugas sudah ditutup — buka lagi lewat review."
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
          <p className="mt-2 text-xs text-tag-yellow-ink">
            Agen berhenti menunggu keputusan Anda di kartu di atas.
          </p>
        )}
      </div>
    </div>
  );
}
