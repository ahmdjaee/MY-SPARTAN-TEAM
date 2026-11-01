import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { closeBrowserFor, createBrowserServer } from "../browser/mcp.ts";
import { CONFIG, agentEnv } from "../config.ts";
import { contextBlock, workspaceForTask } from "../context.ts";
import { ROLES, permissionsFor, resolvePermissionMode } from "../roles.ts";
import { createTeamServer } from "../team/mcp.ts";
import type { AskQuestion, AutonomyMode, RoleId, UiEvent, WorkerStatus } from "../types.ts";
import { bus } from "./bus.ts";
import { toUiEvents } from "./events.ts";
import { guardHooks } from "./guard.ts";

const MODE_LABEL: Record<AutonomyMode, string> = {
  auto: "Auto",
  ask: "Minta approval",
  readonly: "Hanya baca",
};

/** Ringkasan singkat untuk isi notifikasi. */
function describeRequest(event: UiEvent): string | undefined {
  if (event.type === "approval") {
    const input = event.input as Record<string, unknown> | null;
    const command = input && typeof input.command === "string" ? input.command : undefined;
    const file = input && typeof input.file_path === "string" ? input.file_path : undefined;
    return (command ?? file ?? event.toolName).slice(0, 180);
  }
  if (event.type === "question") return event.questions[0]?.question.slice(0, 180);
  return undefined;
}

export type ApprovalDecision = { decision: "allow" | "deny"; message?: string; remember?: boolean };

type PendingRequest = {
  kind: "approval" | "question";
  event: UiEvent;
  resolve: (value: unknown) => void;
};

export type RunnerHooks = {
  /** Slot konkurensi + kunci workspace; kembalikan fungsi pelepasnya. */
  acquire: (role: RoleId) => Promise<() => void>;
  onStatus: (taskId: string, status: WorkerStatus) => void;
  /** Dipanggil begitu sesi Claude punya id, supaya tersimpan walau server mati di tengah turn. */
  onSession: (taskId: string, sessionId: string) => void;
  onTurnEnd: (
    taskId: string,
    outcome: { subtype: string; isError: boolean; costUsd?: number; lastText: string },
  ) => void;
  onIdleShutdown: (taskId: string) => void;
};

/**
 * Satu runner = satu penugasan aktif (satu tugas yang sedang dipegang satu bot).
 * Sesi Claude-nya milik tugas itu sendiri, bukan milik role.
 */
export class TaskRunner {
  status: WorkerStatus = "idle";
  sessionId?: string;

  private q?: Query;
  private readonly inbox: string[] = [];
  private pendingTurn?: string;
  private wake?: () => void;
  private generation = 0;
  private closed = false;
  private busy = false;
  private release?: () => void;
  private idleTimer?: NodeJS.Timeout;
  private lastText = "";
  private readonly pending = new Map<string, PendingRequest>();
  /** id permintaan yang ditutup paksa — supaya tidak diumumkan dua kali. */
  private readonly cancelled = new Set<string>();
  private warnedFallback = false;

  constructor(
    readonly taskId: string,
    readonly role: RoleId,
    private readonly hooks: RunnerHooks,
    sessionId?: string,
    private mode: AutonomyMode = "ask",
  ) {
    this.sessionId = sessionId;
  }

  get autonomyMode(): AutonomyMode {
    return this.mode;
  }

  /** Ganti mode di tengah jalan; sesi yang sedang hidup ikut berubah seketika. */
  async setMode(mode: AutonomyMode): Promise<void> {
    if (this.mode === mode) return;
    this.mode = mode;
    this.warnedFallback = false;
    if (this.q) {
      await this.q.setPermissionMode(resolvePermissionMode(ROLES[this.role], mode)).catch(() => undefined);
    }
    this.emit({ type: "notice", text: `Mode tugas diubah ke ${MODE_LABEL[mode]}.` });
  }

  // ---------- event ----------

  private emit(event: UiEvent): void {
    bus.emit(this.taskId, this.role, event);
  }

  private setStatus(status: WorkerStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type: "status", status });
    this.hooks.onStatus(this.taskId, status);
  }

  openRequests(): UiEvent[] {
    return [...this.pending.values()].map((request) => request.event);
  }

  // ---------- masukan ----------

  send(text: string, options?: { display?: string; from?: "owner" | "system" }): void {
    if (this.closed) throw new Error("runner sudah ditutup");
    this.emit({ type: "user", text: options?.display ?? text, from: options?.from ?? "owner" });
    this.inbox.push(text);
    void this.pump();
  }

  /** Dorong pesan berikutnya kalau ada slot; proses Claude Code baru dibuat di sini. */
  private async pump(): Promise<void> {
    if (this.busy || this.closed || this.inbox.length === 0) return;
    this.busy = true;
    this.clearIdleTimer();

    // Status baru berubah setelah slot didapat — sebelum itu tugas memang masih mengantre.
    this.release = await this.hooks.acquire(this.role);
    if (this.closed) {
      this.freeSlot();
      this.busy = false;
      return;
    }

    const text = this.inbox.shift();
    if (text === undefined) {
      this.freeSlot();
      this.busy = false;
      return;
    }

    this.setStatus("starting");
    this.ensureStarted();
    this.lastText = "";
    this.pendingTurn = text;
    this.setStatus("working");
    this.wake?.();
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    const generation = this.generation;
    while (!this.closed && generation === this.generation) {
      if (this.pendingTurn === undefined) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
        continue;
      }
      const text = this.pendingTurn;
      this.pendingTurn = undefined;
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    }
  }

  private freeSlot(): void {
    this.release?.();
    this.release = undefined;
  }

  // ---------- sesi ----------

  private ensureStarted(): void {
    if (this.q || this.closed) return;
    this.generation += 1;
    this.wake?.();
    const instance = query({ prompt: this.input(), options: this.options() });
    this.q = instance;
    void this.consume(instance);
  }

  private options(): Options {
    const role = ROLES[this.role];
    // Workspace, izin, dan konteks semuanya mengikuti project tugas ini.
    const workspaceDir = workspaceForTask(this.taskId);
    const mcpServers: NonNullable<Options["mcpServers"]> = {
      team: createTeamServer(this.taskId),
    };
    if (role.usesBrowser) mcpServers.browser = createBrowserServer(() => this.taskId);

    return {
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: `${role.persona}${contextBlock(this.taskId)}`,
      },
      model: role.model,
      effort: role.effort,
      cwd: workspaceDir,
      additionalDirectories: [CONFIG.tasksDir],
      settingSources: CONFIG.includeUserSettings ? ["user", "project"] : ["project"],
      settings: { permissions: permissionsFor(this.role, workspaceDir) },
      permissionMode: resolvePermissionMode(role, this.mode),
      allowedTools: role.allowedTools,
      disallowedTools: role.disallowedTools,
      mcpServers,
      hooks: guardHooks(this.taskId),
      includePartialMessages: true,
      canUseTool: this.handlePermission,
      resume: this.sessionId,
      env: agentEnv(),
    };
  }

  private async consume(instance: Query): Promise<void> {
    try {
      for await (const message of instance) {
        if (message.type === "system" && message.subtype === "status") {
          this.checkModeFallback(message.permissionMode);
          continue;
        }
        for (const event of toUiEvents(message)) {
          if (event.type === "init") {
            if (event.sessionId !== this.sessionId) {
              this.sessionId = event.sessionId;
              this.hooks.onSession(this.taskId, event.sessionId);
            }
            this.emit(event);
            continue;
          }
          if (event.type === "assistant") this.lastText = event.text;
          if (event.type === "result") {
            this.emit(event);
            this.finishTurn(event.subtype, event.isError, event.costUsd);
            continue;
          }
          this.emit(event);
        }
      }
      this.setStatus("idle");
    } catch (error) {
      this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      this.setStatus("error");
      this.finishTurn("error", true, undefined);
    } finally {
      this.cancelPending("Sesi berakhir sebelum keputusan diambil.");
      if (this.q === instance) this.q = undefined;
    }
  }

  /** Auto mode butuh dukungan model; kalau ditolak, Claude Code diam-diam turun ke default. */
  private checkModeFallback(active?: string): void {
    if (!active || this.mode !== "auto" || active === "auto" || this.warnedFallback) return;
    this.warnedFallback = true;
    this.emit({
      type: "notice",
      text: "Auto mode tidak tersedia untuk model ini — tugas berjalan dalam mode minta approval.",
    });
  }

  private finishTurn(subtype: string, isError: boolean, costUsd?: number): void {
    this.freeSlot();
    this.busy = false;
    if (this.status !== "error") this.setStatus("idle");
    this.hooks.onTurnEnd(this.taskId, { subtype, isError, costUsd, lastText: this.lastText });
    if (this.inbox.length > 0) void this.pump();
    else this.startIdleTimer();
  }

  // ---------- idle ----------

  private startIdleTimer(): void {
    this.clearIdleTimer();
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.inbox.length > 0 || this.pending.size > 0) return;
      this.stopSession();
      this.hooks.onIdleShutdown(this.taskId);
    }, CONFIG.idleShutdownMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Tutup subprocess tapi pertahankan sessionId supaya bisa di-resume. */
  private stopSession(): void {
    this.generation += 1;
    this.wake?.();
    try {
      this.q?.close();
    } catch {
      // proses mungkin sudah mati
    }
    this.q = undefined;
  }

  // ---------- kendali ----------

  async interrupt(): Promise<void> {
    await this.q?.interrupt().catch(() => undefined);
    this.cancelPending("Dibatalkan oleh owner (tombol Stop).");
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.inbox.length = 0;
    this.pendingTurn = undefined;
    this.freeSlot();
    this.busy = false;
    this.setStatus("idle");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    this.cancelPending("Tugas ditutup.");
    this.stopSession();
    // Browser QA hidup di proses kita sendiri; kalau agen tidak sempat memanggil
    // browser.close, proses Chromium-nya akan tertinggal.
    await closeBrowserFor(this.taskId);
    this.freeSlot();
    this.busy = false;
  }

  // ---------- izin & pertanyaan ----------

  private cancelPending(message: string): void {
    for (const [id, request] of this.pending) {
      this.pending.delete(id);
      this.cancelled.add(id);
      if (request.kind === "approval") {
        const event = request.event as Extract<UiEvent, { type: "approval" }>;
        request.resolve({ decision: "deny", message } satisfies ApprovalDecision);
        this.emit({ type: "approval_resolved", approvalId: event.approvalId, decision: "deny", message });
      } else {
        const event = request.event as Extract<UiEvent, { type: "question" }>;
        request.resolve({});
        this.emit({ type: "question_resolved", questionId: event.questionId, answers: {} });
      }
    }
  }

  private handlePermission: CanUseTool = async (toolName, input, context): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion") {
      const questions = (Array.isArray(input.questions) ? input.questions : []) as AskQuestion[];
      const questionId = randomUUID();
      const answers = (await this.awaitDecision(questionId, "question", {
        type: "question",
        questionId,
        questions,
      })) as Record<string, string>;
      if (this.cancelled.delete(questionId)) return { behavior: "deny", message: "Dibatalkan oleh owner." };
      this.emit({ type: "question_resolved", questionId, answers });
      return { behavior: "allow", updatedInput: { questions, answers } };
    }

    const approvalId = randomUUID();
    const suggestions = context.suggestions ?? [];
    const decision = (await this.awaitDecision(approvalId, "approval", {
      type: "approval",
      approvalId,
      toolName,
      input,
      title: context.title,
      description: context.description,
      reason: context.decisionReason,
      canRemember: !context.suppressAlwaysAllowRule && suggestions.some((s) => s.destination === "localSettings"),
    })) as ApprovalDecision;

    if (this.cancelled.delete(approvalId)) {
      return { behavior: "deny", message: decision.message ?? "Dibatalkan oleh owner." };
    }
    this.emit({
      type: "approval_resolved",
      approvalId,
      decision: decision.decision,
      remember: decision.remember,
      message: decision.message,
    });

    if (decision.decision === "deny") {
      return { behavior: "deny", message: decision.message?.trim() || "Ditolak oleh owner." };
    }
    return {
      behavior: "allow",
      updatedInput: input,
      ...(decision.remember
        ? { updatedPermissions: suggestions.filter((s) => s.destination === "localSettings") }
        : {}),
    };
  };

  /** Selama menunggu manusia, slot dilepas supaya tugas lain bisa jalan. */
  private async awaitDecision(id: string, kind: PendingRequest["kind"], event: UiEvent): Promise<unknown> {
    this.setStatus("waiting");
    this.emit(event);
    bus.publishAttention({
      kind: kind === "approval" ? "approval" : "question",
      taskId: this.taskId,
      role: this.role,
      title:
        kind === "approval"
          ? `${ROLES[this.role].title} butuh persetujuan`
          : `${ROLES[this.role].title} bertanya`,
      detail: describeRequest(event),
      at: new Date().toISOString(),
    });
    this.freeSlot();

    const value = await new Promise<unknown>((resolve) => {
      this.pending.set(id, { kind, event, resolve });
    });
    this.pending.delete(id);

    if (this.closed || this.cancelled.has(id)) return value;
    this.release = await this.hooks.acquire(this.role);
    if (this.status === "waiting") this.setStatus("working");
    return value;
  }

  resolveRequest(id: string, value: unknown): boolean {
    const request = this.pending.get(id);
    if (!request) return false;
    this.pending.delete(id);
    request.resolve(value);
    return true;
  }

  hasRequest(id: string): boolean {
    return this.pending.has(id);
  }
}
