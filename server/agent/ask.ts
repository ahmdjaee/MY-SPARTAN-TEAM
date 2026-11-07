import {
  query,
  type CanUseTool,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { CONFIG, agentEnv } from "../config.ts";
import { askContext, workspaceForTask } from "../context.ts";
import { DENY_ALWAYS } from "../roles.ts";
import { addAskCost, getTask, taskDir } from "../tasks.ts";

export type AskMessage = {
  role: "user" | "assistant";
  text: string;
  model?: string;
  costUsd?: number;
  ts: string;
};

export type AskState = { messages: AskMessage[]; busy: boolean; costUsd: number };

/** Event panel Tanya: hidup hanya selama koneksi, tidak pernah ditulis ke mana pun. */
export type AskEvent =
  | { type: "delta"; text: string }
  | { type: "answer"; message: AskMessage }
  | { type: "busy"; busy: boolean }
  | { type: "error"; message: string };

const READ_TOOLS = ["Read", "Grep", "Glob"];

/** Model yang boleh dipakai panel Tanya: QA (murah) untuk tanya biasa, Engineer untuk analisis berat. */
export const ASK_MODELS = [
  { id: CONFIG.models.qa, label: "Cepat & murah" },
  { id: CONFIG.models.engineer, label: "Analisis berat" },
];

/** Panel ini hanya membaca; apa pun yang bisa mengubah sesuatu ditolak diam-diam. */
export function askOptions(taskId: string, model: string, history: AskMessage[]): Options {
  const denyTool: CanUseTool = async (toolName, input) =>
    READ_TOOLS.includes(toolName)
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: `Panel Tanya hanya boleh membaca (${READ_TOOLS.join(", ")}).` };

  return {
    systemPrompt: askContext(taskId, history),
    model,
    cwd: workspaceForTask(taskId),
    additionalDirectories: [taskDir(taskId)],
    settingSources: [],
    settings: {
      permissions: {
        allow: READ_TOOLS,
        ask: [],
        deny: [
          "Bash",
          "Edit",
          "Write",
          "NotebookEdit",
          "WebFetch",
          "WebSearch",
          "Task",
          "TodoWrite",
          "mcp__*",
          ...DENY_ALWAYS,
        ],
      },
    },
    allowedTools: READ_TOOLS,
    disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite", "mcp__*"],
    permissionMode: "default",
    canUseTool: denyTool,
    includePartialMessages: true,
    // Inti "incognito": tidak ada transcript yang ditulis ke ~/.claude.
    persistSession: false,
    env: agentEnv(),
  };
}

type Listener = (event: AskEvent) => void;

/**
 * Satu sesi tanya-jawab per tugas, hidup di memori.
 * Terpisah total dari TaskRunner: tidak memakai bus/transcript tugas, tidak
 * menulis ke task.json selain biaya, dan tidak pernah memunculkan kartu persetujuan.
 */
type Answer = { text: string; costUsd?: number };

export class AskSession {
  private q?: Query;
  private pending?: string;
  private wake?: () => void;
  private generation = 0;
  private closed = false;
  private model?: string;
  private idleTimer?: NodeJS.Timeout;
  /** Jawaban yang sedang ditunggu; diselesaikan oleh consume() saat event result datang. */
  private inflight?: { resolve: (answer: Answer) => void; reject: (error: Error) => void; text: string };

  constructor(
    private readonly taskId: string,
    private readonly emit: Listener,
  ) {}

  private async *input(): AsyncGenerator<SDKUserMessage> {
    const generation = this.generation;
    while (!this.closed && generation === this.generation) {
      if (this.pending === undefined) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            if (this.wake === wake) this.wake = undefined;
            resolve();
          };
          this.wake = wake;
        });
        continue;
      }
      const text = this.pending;
      this.pending = undefined;
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    }
  }

  private start(model: string, history: AskMessage[]): Query {
    this.generation += 1;
    this.wake?.();
    this.model = model;
    const instance = query({ prompt: this.input(), options: askOptions(this.taskId, model, history) });
    this.q = instance;
    // Konsumer berumur panjang: keluar dari for-await akan menutup aliran, dan
    // pertanyaan berikutnya jatuh ke sesi yang sudah mati.
    void this.consume(instance);
    return instance;
  }

  private async consume(instance: Query): Promise<void> {
    let answer = "";
    // `total_cost_usd` kumulatif per sesi; persistSession:false → tiap instance mulai dari 0.
    let mark = 0;
    let failure: Error | undefined;
    try {
      for await (const message of instance) {
        // Sesi yang sudah ditutup: delta dan jawabannya bukan milik pertanyaan yang sekarang.
        if (this.q !== instance) continue;
        if (message.type === "stream_event") {
          const event = message.event as { type: string; delta?: { type?: string; text?: string } };
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            this.emit({ type: "delta", text: event.delta.text });
          }
          continue;
        }
        if (message.type === "assistant") {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content as unknown as Array<Record<string, unknown>>) {
              if (block.type === "text" && typeof block.text === "string" && block.text.trim()) answer = block.text;
            }
          }
          continue;
        }
        if (message.type === "result") {
          const result = message as unknown as Record<string, unknown>;
          const total = typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined;
          let costUsd: number | undefined;
          if (total !== undefined && total > 0) {
            costUsd = Number((total >= mark ? total - mark : total).toFixed(6));
            mark = total;
            if (costUsd > 0) addAskCost(this.taskId, costUsd);
          }
          this.inflight?.resolve({ text: answer, costUsd });
          this.inflight = undefined;
          answer = "";
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    // Instance lama (sudah diganti setelah idle/stop) tidak boleh menggagalkan pertanyaan sesi baru.
    if (this.q !== instance) return;
    this.q = undefined;
    this.inflight?.reject(failure ?? new Error("sesi tanya berakhir sebelum jawaban selesai"));
    this.inflight = undefined;
  }

  /** Satu pertanyaan → satu jawaban. Pemanggil menjaga agar tidak ada dua sekaligus. */
  async ask(text: string, model: string, history: AskMessage[]): Promise<AskMessage> {
    this.clearIdle();
    if (!this.q) this.start(model, history);
    else if (model !== this.model) {
      await this.q.setModel(model).catch(() => undefined);
      this.model = model;
    }

    // CLI yang macet tidak boleh mengunci panel ini selamanya (state.busy).
    const timer = setTimeout(() => {
      const inflight = this.inflight;
      this.inflight = undefined;
      inflight?.reject(
        new Error(`Jawaban melewati ${Math.round(CONFIG.askTimeoutMs / 60_000)} menit — sesi tanya dihentikan.`),
      );
      this.stop();
    }, CONFIG.askTimeoutMs);
    timer.unref();
    let answer: Answer;
    try {
      answer = await new Promise<Answer>((resolve, reject) => {
        this.inflight = { resolve, reject, text };
        this.pending = text;
        this.wake?.();
      });
    } finally {
      clearTimeout(timer);
    }

    this.startIdle();
    return {
      role: "assistant",
      text: answer.text || "(tidak ada jawaban)",
      model,
      costUsd: answer.costUsd,
      ts: new Date().toISOString(),
    };
  }

  private startIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.stop(), CONFIG.idleShutdownMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Tutup subprocess; pertanyaan berikutnya memulai sesi baru yang di-seed riwayat panel. */
  stop(): void {
    this.clearIdle();
    this.generation += 1;
    this.wake?.();
    const instance = this.q;
    this.q = undefined;
    try {
      instance?.close();
    } catch {
      // proses mungkin sudah mati
    }
    // Sesi yang ditutup tidak akan menjawab lagi; pertanyaan yang berjalan jangan dibiarkan menggantung.
    const inflight = this.inflight;
    this.inflight = undefined;
    inflight?.reject(new Error("sesi tanya ditutup"));
  }

  close(): void {
    this.closed = true;
    this.stop();
  }
}

class AskHub {
  private readonly states = new Map<string, AskState>();
  private readonly sessions = new Map<string, AskSession>();
  private readonly listeners = new Map<string, Set<Listener>>();

  state(taskId: string): AskState {
    return this.states.get(taskId) ?? { messages: [], busy: false, costUsd: 0 };
  }

  subscribe(taskId: string, listener: Listener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(taskId);
    };
  }

  private emit(taskId: string, event: AskEvent): void {
    for (const listener of this.listeners.get(taskId) ?? []) {
      try {
        listener(event);
      } catch {
        // satu penyimak yang error tidak boleh menjatuhkan sesi
      }
    }
  }

  async ask(taskId: string, text: string, model: string): Promise<AskMessage> {
    if (!getTask(taskId)) throw new Error("tugas tidak ditemukan");
    const state = this.states.get(taskId) ?? { messages: [], busy: false, costUsd: 0 };
    this.states.set(taskId, state);
    if (state.busy) throw new Error("masih menjawab pertanyaan sebelumnya");

    const history = [...state.messages];
    state.messages.push({ role: "user", text, ts: new Date().toISOString() });
    state.busy = true;
    this.emit(taskId, { type: "busy", busy: true });

    let session = this.sessions.get(taskId);
    if (!session) {
      session = new AskSession(taskId, (event) => this.emit(taskId, event));
      this.sessions.set(taskId, session);
    }

    try {
      const answer = await session.ask(text, model, history);
      state.messages.push(answer);
      state.costUsd = Number((state.costUsd + (answer.costUsd ?? 0)).toFixed(6));
      this.emit(taskId, { type: "answer", message: answer });
      return answer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(taskId, { type: "error", message });
      throw error;
    } finally {
      state.busy = false;
      this.emit(taskId, { type: "busy", busy: false });
    }
  }

  clear(taskId: string): void {
    this.sessions.get(taskId)?.close();
    this.sessions.delete(taskId);
    this.states.delete(taskId);
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.states.clear();
  }
}

export const askHub = new AskHub();
