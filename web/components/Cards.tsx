import { memo, useMemo, useState } from "react";
import { commandOf, toolLabel, toolSummary } from "../activity.ts";
import { api, ApiError, type UiEvent } from "../api.ts";

type Approval = Extract<UiEvent, { type: "approval" }>;
type Question = Extract<UiEvent, { type: "question" }>;

/**
 * Pengiriman keputusan. Tombol hanya terkunci selama permintaan berjalan; kartu hilang begitu
 * keputusannya tiba lewat stream. 404 berarti permintaannya sudah selesai, bukan gagal dikirim.
 */
function useDecision() {
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "expired">("idle");
  const [error, setError] = useState<string>();

  const submit = async (send: () => Promise<unknown>) => {
    setPhase("sending");
    setError(undefined);
    try {
      await send();
      setPhase("sent");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        setPhase("expired");
        return;
      }
      setError((cause as Error).message);
      setPhase("idle");
    }
  };

  return { phase, error, submit, locked: phase !== "idle" };
}

function ExpiredRequest() {
  return <p className="text-xs text-muted">Permintaan ini sudah tidak aktif.</p>;
}

function DecisionStatus({ phase, error }: { phase: string; error?: string }) {
  if (error) return <p className="mt-2 text-xs text-tag-red-ink">Gagal mengirim: {error}. Coba lagi.</p>;
  if (phase === "sent") return <p className="mt-2 text-xs text-muted">Keputusan terkirim.</p>;
  return null;
}

export function ApprovalCard({ event }: { event: Approval }) {
  const { phase, error, submit, locked } = useDecision();
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);

  const act = (decision: "allow" | "deny", remember = false) =>
    submit(() => api.approve(event.approvalId, { decision, remember, message: reason || undefined }));

  if (phase === "expired") return <ExpiredRequest />;

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
          disabled={locked}
          onClick={() => act("allow")}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          Izinkan
        </button>
        {event.canRemember && (
          <button
            disabled={locked}
            onClick={() => act("allow", true)}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-tag-green-ink hover:bg-hover disabled:opacity-50"
          >
            Izinkan & ingat
          </button>
        )}
        <button
          disabled={locked}
          onClick={() => (showReason ? act("deny") : setShowReason(true))}
          className="rounded-lg border border-tag-red-ink px-3 py-1.5 text-sm text-tag-red-ink hover:bg-tag-red disabled:opacity-50"
        >
          {showReason ? "Kirim penolakan" : "Tolak"}
        </button>
      </div>
      <DecisionStatus phase={phase} error={error} />
    </div>
  );
}

export function QuestionCard({ event }: { event: Question }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const { phase, error, submit, locked } = useDecision();

  const complete = event.questions.every((question) => answers[question.question]);

  if (phase === "expired") return <ExpiredRequest />;

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
        disabled={locked || !complete}
        onClick={() => submit(() => api.answer(event.questionId, answers))}
        className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
      >
        Kirim jawaban
      </button>
      <DecisionStatus phase={phase} error={error} />
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
  const label = toolLabel(name);
  const summary = useMemo(() => toolSummary(input), [input]);
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
