import { memo, useMemo, useState } from "react";
import { api, type UiEvent } from "../api.ts";

type Approval = Extract<UiEvent, { type: "approval" }>;
type Question = Extract<UiEvent, { type: "question" }>;

function commandOf(input: unknown): string {
  const record = input as Record<string, unknown> | null;
  if (record && typeof record.command === "string") return record.command;
  if (record && typeof record.file_path === "string") return String(record.file_path);
  return JSON.stringify(input, null, 2);
}

export function ApprovalCard({ event }: { event: Approval }) {
  const [sending, setSending] = useState(false);
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);

  const act = async (decision: "allow" | "deny", remember = false) => {
    setSending(true);
    try {
      await api.approve(event.approvalId, { decision, remember, message: reason || undefined });
    } catch (error) {
      alert((error as Error).message);
      setSending(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-tag-yellow p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-tag-yellow-ink">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-tag-yellow-ink" />
        Butuh persetujuan Anda · {event.toolName}
      </div>
      {event.description && <p className="mt-1 text-xs text-muted">{event.description}</p>}
      <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-page p-3 font-mono text-[13px] text-ink">
        {commandOf(event.input)}
      </pre>
      {event.reason && <p className="mt-2 text-xs text-muted">Alasan ditanyakan: {event.reason}</p>}

      {showReason && (
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Alasan penolakan / arahan untuk agen (opsional)"
          className="mt-3 w-full rounded-lg border border-line bg-page p-2 text-sm text-ink outline-none focus:border-accent"
          rows={2}
        />
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={sending}
          onClick={() => act("allow")}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          Izinkan
        </button>
        {event.canRemember && (
          <button
            disabled={sending}
            onClick={() => act("allow", true)}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-tag-green-ink hover:bg-hover disabled:opacity-50"
          >
            Izinkan & ingat
          </button>
        )}
        <button
          disabled={sending}
          onClick={() => (showReason ? act("deny") : setShowReason(true))}
          className="rounded-lg border border-tag-red-ink px-3 py-1.5 text-sm text-tag-red-ink hover:bg-tag-red disabled:opacity-50"
        >
          {showReason ? "Kirim penolakan" : "Tolak"}
        </button>
      </div>
    </div>
  );
}

export function QuestionCard({ event }: { event: Question }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  const submit = async () => {
    setSending(true);
    try {
      await api.answer(event.questionId, answers);
    } catch (error) {
      alert((error as Error).message);
      setSending(false);
    }
  };

  const complete = event.questions.every((question) => answers[question.question]);

  return (
    <div className="rounded-xl border border-line bg-tag-blue p-4">
      <div className="text-sm font-semibold text-accent-ink">Agen bertanya</div>
      {event.questions.map((question) => (
        <div key={question.question} className="mt-3">
          <p className="text-sm text-ink">{question.question}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {question.options.map((option) => {
              const active = answers[question.question] === option.label;
              return (
                <button
                  key={option.label}
                  onClick={() => setAnswers((prev) => ({ ...prev, [question.question]: option.label }))}
                  title={option.description}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${
                    active
                      ? "border-accent bg-accent-soft text-accent-ink"
                      : "border-line text-ink hover:border-line-strong"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <input
            value={answers[question.question] ?? ""}
            onChange={(e) => setAnswers((prev) => ({ ...prev, [question.question]: e.target.value }))}
            placeholder="atau tulis jawaban sendiri…"
            className="mt-2 w-full rounded-lg border border-line bg-page px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
          />
        </div>
      ))}
      <button
        disabled={sending || !complete}
        onClick={submit}
        className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
      >
        Kirim jawaban
      </button>
    </div>
  );
}

/** Ribuan baris tool di satu thread: hanya render ulang kalau event/hasilnya memang berubah. */
export const ToolCall = memo(function ToolCall({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: Extract<UiEvent, { type: "tool_result" }>;
}) {
  const [open, setOpen] = useState(false);
  // mcp__browser__screenshot → browser.screenshot
  const label = name.replace(/^mcp__([^_]+(?:_[^_]+)*)__/, (_match, server: string) => `${server}.`);
  const summary = useMemo(() => commandOf(input).split("\n")[0]?.slice(0, 110) ?? "", [input]);
  const state = !result ? "berjalan" : result.isError ? "gagal" : "selesai";
  const tone = !result ? "text-tag-blue-ink" : result.isError ? "text-tag-red-ink" : "text-muted";

  return (
    <div className="rounded-lg border border-line bg-panel">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className={`font-mono text-[11px] ${tone}`}>{label}</span>
        <span className="flex-1 truncate font-mono text-xs text-muted">{summary}</span>
        <span className={`text-[11px] ${tone}`}>{state}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          <pre className="overflow-x-auto font-mono text-[12px] text-ink">{JSON.stringify(input, null, 2)}</pre>
          {result && (
            <pre className={`overflow-x-auto whitespace-pre-wrap font-mono text-[12px] ${result.isError ? "text-tag-red-ink" : "text-muted"}`}>
              {result.preview}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});
