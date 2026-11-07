import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UiEvent } from "../types.ts";

function preview(value: unknown, max = 600): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Data `result` yang tidak ditampilkan tapi dibutuhkan runner: siapa pemilik turn ini dan total biaya sesinya. */
export type ResultMeta = {
  sessionId?: string;
  /** Total berjalan sesi (kumulatif lintas turn dan resume), bukan biaya turn. */
  totalUsd?: number;
  /** uuid pesan kita yang dijawab turn ini; kosong untuk turn yang dimulai CLI sendiri dan result crash. */
  userMessageUuids?: string[];
  /** > 0 berarti masih ada pesan antre yang akan dijalankan CLI setelah ini. */
  queuedTurns?: number;
};

export function resultMeta(message: SDKMessage): ResultMeta | undefined {
  if (message.type !== "result") return undefined;
  const result = message as unknown as Record<string, unknown>;
  const list = Array.isArray(result.user_message_uuids)
    ? result.user_message_uuids.filter((value): value is string => typeof value === "string")
    : undefined;
  const single = typeof result.user_message_uuid === "string" ? result.user_message_uuid : undefined;
  return {
    sessionId: typeof result.session_id === "string" ? result.session_id : undefined,
    totalUsd:
      typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : undefined,
    userMessageUuids: list?.length ? list : single ? [single] : undefined,
    queuedTurns: typeof result.queued_turn_count === "number" ? result.queued_turn_count : undefined,
  };
}

/** Ubah satu SDKMessage menjadi nol atau beberapa event UI. */
export function toUiEvents(message: SDKMessage): UiEvent[] {
  const events: UiEvent[] = [];

  if (message.type === "system" && message.subtype === "init") {
    events.push({
      type: "init",
      sessionId: message.session_id,
      model: message.model,
      permissionMode: message.permissionMode,
      apiKeySource: String(message.apiKeySource),
      toolCount: message.tools.length,
      mcpServers: message.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
    });
    return events;
  }

  if (message.type === "system" && message.subtype === "permission_denied") {
    events.push({ type: "error", message: `Tool ${message.tool_name} ditolak: ${message.message}` });
    return events;
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    const { trigger, pre_tokens: preTokens, post_tokens: postTokens } = message.compact_metadata;
    events.push({ type: "compact", trigger, preTokens, postTokens });
    return events;
  }

  if (message.type === "stream_event") {
    const event = message.event as { type: string; delta?: { type?: string; text?: string; thinking?: string } };
    if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta" && event.delta.text) {
        events.push({ type: "delta", kind: "text", text: event.delta.text });
      }
      if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
        events.push({ type: "delta", kind: "thinking", text: event.delta.thinking });
      }
    }
    return events;
  }

  if (message.type === "assistant") {
    const content = message.message.content;
    if (!Array.isArray(content)) return events;
    for (const block of content as unknown as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({ type: "assistant", text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        events.push({ type: "thinking", text: block.thinking });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool",
          toolUseId: String(block.id),
          name: String(block.name),
          input: block.input,
        });
      }
    }
    return events;
  }

  if (message.type === "user") {
    const content = message.message.content;
    if (!Array.isArray(content)) return events;
    for (const block of content as unknown as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      const inner = block.content;
      let text = "";
      if (typeof inner === "string") {
        text = inner;
      } else if (Array.isArray(inner)) {
        text = inner
          .map((part) => {
            const p = part as Record<string, unknown>;
            if (p.type === "text") return String(p.text ?? "");
            if (p.type === "image") return "[gambar]";
            return `[${String(p.type ?? "blok")}]`;
          })
          .join("\n");
      }
      events.push({
        type: "tool_result",
        toolUseId: String(block.tool_use_id),
        isError: block.is_error === true,
        preview: preview(text),
      });
    }
    return events;
  }

  if (message.type === "result") {
    const result = message as unknown as Record<string, unknown>;
    events.push({
      type: "result",
      subtype: String(result.subtype),
      isError: result.is_error === true,
      durationMs: Number(result.duration_ms ?? 0),
      numTurns: Number(result.num_turns ?? 0),
      costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
    });
    return events;
  }

  return events;
}
