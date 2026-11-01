export type RoleId = "qa" | "engineer" | "devops";

/** Seberapa bebas agen bertindak dalam satu tugas. */
export type AutonomyMode = "auto" | "ask" | "readonly";

/** Hal yang pantas menarik perhatian pemilik produk, lintas tugas. */
export type AttentionEvent = {
  kind: "approval" | "question" | "needs_review" | "failed";
  taskId: string;
  role: RoleId;
  title: string;
  detail?: string;
  at: string;
};

/** Status runner agen untuk satu tugas (beda dengan status tugas itu sendiri). */
export type WorkerStatus = "idle" | "starting" | "working" | "waiting" | "error";

export type AskQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

export type UiEvent =
  | { type: "user"; text: string; from?: "owner" | "system" }
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | { type: "delta"; kind: "text" | "thinking"; text: string }
  | { type: "tool"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; preview: string }
  | {
      type: "approval";
      approvalId: string;
      toolName: string;
      input: unknown;
      title?: string;
      description?: string;
      reason?: string;
      canRemember: boolean;
    }
  | { type: "approval_resolved"; approvalId: string; decision: "allow" | "deny"; remember?: boolean; message?: string }
  | { type: "question"; questionId: string; questions: AskQuestion[] }
  | { type: "question_resolved"; questionId: string; answers: Record<string, string> }
  | { type: "status"; status: WorkerStatus }
  | {
      type: "init";
      sessionId: string;
      model: string;
      permissionMode?: string;
      apiKeySource: string;
      toolCount: number;
      mcpServers: { name: string; status: string }[];
    }
  | {
      type: "result";
      subtype: string;
      isError: boolean;
      durationMs: number;
      numTurns: number;
      costUsd?: number;
    }
  | { type: "handoff"; from: RoleId; to: RoleId; note?: string }
  | { type: "notice"; text: string }
  | { type: "error"; message: string };

export type StoredEvent = UiEvent & { seq: number; ts: string; taskId: string; role: RoleId };

/** Event yang hanya relevan saat live, tidak ditulis ke transcript. */
export const EPHEMERAL_EVENTS = new Set(["delta", "status"]);
