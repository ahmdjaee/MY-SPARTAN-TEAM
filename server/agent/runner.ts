import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { BrowserSession, closeBrowserFor, createBrowserServer } from "../browser/mcp.ts";
import { control } from "../browser/control.ts";
import { CONFIG, agentEnv } from "../config.ts";
import { contextBlock, workspaceForTask } from "../context.ts";
import { ROLES, permissionsFor, resolvePermissionMode } from "../roles.ts";
import { createTeamServer } from "../team/mcp.ts";
import type { AskQuestion, AutonomyMode, ContextUsage, RoleId, UiEvent, WorkerStatus } from "../types.ts";
import { bus } from "./bus.ts";
import { resultMeta, toUiEvents, type ResultMeta } from "./events.ts";
import { guardHooks } from "./guard.ts";

/** Selama turn berjalan, indikator konteks cukup diperbarui sesekali. */
const CONTEXT_REFRESH_MS = 15_000;

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

/** Kuitansi interrupt (capability `interrupt_receipt_v1`). */
type InterruptReceipt = { still_queued?: string[]; cancelled?: string[] };

/**
 * Stop = berhenti total. `cancel_queued` ikut membatalkan pesan kita yang masih antre di CLI (mis. di
 * belakang turn yang dimulai CLI sendiri); tanpa itu pesan tersebut tetap dijalankan setelah Stop.
 * sdk.d.ts belum mencantumkan argumennya, tapi `Query.interrupt` di sdk.mjs meneruskan `cancelQueued`.
 */
function interruptAll(instance: Query): Promise<InterruptReceipt | undefined> {
  const interrupt = instance.interrupt as unknown as (options: {
    cancelQueued: boolean;
  }) => Promise<InterruptReceipt | undefined>;
  return interrupt.call(instance, { cancelQueued: true }).catch(() => undefined);
}

type PendingRequest = {
  kind: "approval" | "question";
  event: UiEvent;
  resolve: (value: unknown) => void;
};

export type TurnOutcome = {
  subtype: string;
  isError: boolean;
  /** Dihentikan owner (Stop/batal/oper) — bukan kegagalan. */
  interrupted?: boolean;
  /** Turn yang dimulai CLI sendiri (mis. notifikasi Bash background), bukan jawaban atas pesan kita. */
  background?: boolean;
  /** Masih ada pesan di inbox: turn berikutnya langsung jalan, jadi status tugas tidak perlu berubah. */
  followUp?: boolean;
  lastText: string;
};

export type RunnerHooks = {
  /** Slot konkurensi SAJA (bukan kunci workspace); kembalikan fungsi pelepasnya. */
  acquire: (role: RoleId) => Promise<() => void>;
  /**
   * Kunci workspace untuk role yang menulis, diambil sebelum slot dan dipegang sepanjang turn —
   * termasuk saat menunggu keputusan owner. undefined = role ini tidak butuh kunci.
   */
  lockWorkspace?: (role: RoleId, dir: string) => Promise<(() => void) | undefined>;
  onStatus: (taskId: string, status: WorkerStatus) => void;
  /** Dipanggil begitu sesi Claude punya id, supaya tersimpan walau server mati di tengah turn. */
  onSession: (taskId: string, sessionId: string) => void;
  /** Total berjalan sesi dari tiap result; mengembalikan biaya yang benar-benar baru (selisihnya). */
  onCost?: (
    taskId: string,
    sessionId: string,
    totalUsd: number,
    options?: { monotonicOnly?: boolean },
  ) => number | undefined;
  onTurnEnd: (taskId: string, outcome: TurnOutcome) => void;
  onIdleShutdown: (taskId: string) => void;
  /** Pemakaian konteks yang layak disimpan: akhir turn dan sesudah compact, bukan tiap pembaruan live. */
  onContext: (taskId: string, usage: ContextUsage) => void;
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
  /** Slot konkurensi saja; dilepas selama menunggu keputusan owner. */
  private release?: () => void;
  /** Kunci workspace (role penulis); dipegang sampai turn benar-benar berakhir. */
  private lockRelease?: () => void;
  /**
   * Pesan kita yang sudah sampai ke CLI dan belum dijawab `result` miliknya. Result lain (turn yang
   * dimulai CLI sendiri) tidak boleh menutup turn ini — dikenali lewat uuid yang di-echo SDK.
   */
  private turn?: { uuid: string; stopped: boolean };
  /** Stop ditekan saat CLI masih bekerja; result berikutnya dianggap dihentikan, bukan gagal. */
  private stopRequested = false;
  private stopGrace?: NodeJS.Timeout;
  /** CLI sedang menjalankan turn yang ia mulai sendiri saat runner idle. */
  private backgroundTurn = false;
  /**
   * CLI sesi ini meng-echo uuid pesan (di result/assistant). Sejak itu result TANPA uuid pasti turn
   * yang dimulai CLI sendiri — `queued_turn_count` tidak bisa diandalkan selama pesan kita masih di jalan.
   */
  private echoSeen = false;
  /** Folder kerja (cwd) Query yang sedang hidup — folder inilah yang dikunci, walau tugas dipindah project. */
  private queryDir?: string;
  private idleTimer?: NodeJS.Timeout;
  private lastText = "";
  private readonly pending = new Map<string, PendingRequest>();
  /** id permintaan yang ditutup paksa — supaya tidak diumumkan dua kali. */
  private readonly cancelled = new Set<string>();
  private warnedFallback = false;
  /** Naik saat turn berakhir/Stop/tutup: perolehan slot yang masih mengantre dari sebelumnya jadi basi. */
  private slotEpoch = 0;
  /** Perolehan slot yang sedang mengantre; beberapa keputusan berbagi satu, supaya slot tidak bocor. */
  private reacquiring?: Promise<void>;
  /** Satu browser per runner — sesi Claude boleh di-restart setelah idle tanpa meninggalkan Chromium lama. */
  private browser?: BrowserSession;
  private contextCheckedAt = 0;

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
    // Turn kita yang dihentikan belum dijawab result-nya: pesan baru menunggu, supaya result
    // turn lama tidak dikira milik pesan baru (dan melepas slot/kuncinya).
    if (this.busy || this.turn || this.closed || this.inbox.length === 0) return;
    this.busy = true;
    this.clearIdleTimer();
    // Stop/tutup selama mengantre menaikkan epoch: perolehan yang datang sesudahnya basi, dan
    // `busy` mungkin sudah milik pump lain — jadi cukup kembalikan yang didapat lalu pergi.
    const epoch = this.slotEpoch;

    // Kunci workspace dulu, baru slot: tugas kode yang menunggu giliran tidak menahan slot QA.
    // Status baru berubah setelah keduanya didapat — sebelum itu tugas memang masih mengantre.
    // Folder yang dikunci = folder tempat CLI menulis: sesi yang masih hidup tetap di cwd awalnya.
    const dir = (this.q && this.queryDir) || workspaceForTask(this.taskId);
    const lock = await this.hooks.lockWorkspace?.(this.role, dir);
    if (epoch !== this.slotEpoch) {
      lock?.();
      return;
    }
    if (lock) this.holdLock(lock);
    const slot = await this.hooks.acquire(this.role);
    if (epoch !== this.slotEpoch) {
      slot();
      return;
    }
    this.holdSlot(slot);

    // Sesi berakhir selama mengantre dan tugasnya pindah folder: kunci yang dipegang salah folder.
    if (!this.q && !this.closed && workspaceForTask(this.taskId) !== dir) {
      this.freeSlot();
      this.freeLock();
      this.busy = false;
      void this.pump();
      return;
    }

    const text = this.inbox.shift();
    if (this.closed || text === undefined) {
      this.freeSlot();
      this.freeLock();
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
          // Hanya pemiliknya yang mengosongkan `wake`: generator baru mungkin sudah memasang miliknya.
          const wake = () => {
            if (this.wake === wake) this.wake = undefined;
            resolve();
          };
          this.wake = wake;
        });
        continue;
      }
      const text = this.pendingTurn;
      this.pendingTurn = undefined;
      // uuid ini di-echo SDK di `result` turn yang menjawabnya (user_message_uuids).
      const uuid = randomUUID();
      this.turn = { uuid, stopped: false };
      this.stopRequested = false;
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid };
    }
  }

  private freeSlot(): void {
    this.release?.();
    this.release = undefined;
  }

  /** Menimpa `release` tanpa memanggilnya berarti slot hilang selamanya. */
  private holdSlot(release: () => void): void {
    this.freeSlot();
    this.release = release;
  }

  private freeLock(): void {
    this.lockRelease?.();
    this.lockRelease = undefined;
  }

  private holdLock(release: () => void): void {
    this.freeLock();
    this.lockRelease = release;
  }

  private invalidateSlotClaims(): void {
    this.slotEpoch += 1;
    this.reacquiring = undefined;
  }

  // ---------- sesi ----------

  private ensureStarted(): void {
    if (this.q || this.closed) return;
    this.generation += 1;
    this.wake?.();
    // Workspace, izin, dan konteks semuanya mengikuti project tugas ini.
    const workspaceDir = workspaceForTask(this.taskId);
    const instance = query({ prompt: this.input(), options: this.options(workspaceDir) });
    this.q = instance;
    this.queryDir = workspaceDir;
    this.echoSeen = false;
    void this.consume(instance);
  }

  private options(workspaceDir: string): Options {
    const role = ROLES[this.role];
    const mcpServers: NonNullable<Options["mcpServers"]> = {
      team: createTeamServer(this.taskId, this.role),
    };
    if (role.usesBrowser) {
      this.browser ??= new BrowserSession(() => this.taskId);
      mcpServers.browser = createBrowserServer(this.browser, () => this.taskId);
    }

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
      settings: {
        permissions: permissionsFor(this.role, workspaceDir),
        attribution: { commit: "", pr: "", sessionUrl: false },
      },
      permissionMode: resolvePermissionMode(role, this.mode),
      allowedTools: role.allowedTools,
      disallowedTools: role.disallowedTools,
      mcpServers,
      hooks: guardHooks(this.taskId, this.role),
      includePartialMessages: true,
      canUseTool: this.handlePermission,
      resume: this.sessionId,
      env: agentEnv(),
    };
  }

  private async consume(instance: Query): Promise<void> {
    let failure: string | undefined;
    try {
      for await (const message of instance) {
        // Query yang sudah diganti atau ditutup (Stop paksa, oper, idle) masih bisa mengeluarkan pesan
        // yang tertahan di buffer. Jangan biarkan ia menggerakkan runner — biayanya saja yang dicatat.
        if (this.q !== instance) {
          if (message.type === "result") this.recordCost(resultMeta(message), true);
          continue;
        }
        if (message.type === "system" && message.subtype === "status") {
          this.checkModeFallback(message.permissionMode);
          continue;
        }
        if (message.type === "assistant" && typeof message.user_message_uuid === "string") this.echoSeen = true;
        const meta = resultMeta(message);
        for (const event of toUiEvents(message)) {
          if (event.type === "init") {
            if (event.sessionId !== this.sessionId) {
              this.sessionId = event.sessionId;
              this.hooks.onSession(this.taskId, event.sessionId);
            }
            this.emit(event);
            continue;
          }
          if (event.type === "result") {
            this.onResult(instance, meta, event);
            continue;
          }
          if (event.type === "assistant" || event.type === "tool") this.noteActivity();
          if (event.type === "assistant") this.lastText = event.text;
          this.emit(event);
          if (event.type === "compact") this.refreshContext(instance, true);
          else if (event.type === "tool_result" && Date.now() - this.contextCheckedAt >= CONTEXT_REFRESH_MS) {
            this.refreshContext(instance, false);
          }
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (this.q !== instance) {
      // Sesi lama berakhir setelah diganti: kartu sesi yang baru bukan miliknya.
      if (!this.q) this.cancelPending("Sesi berakhir sebelum keputusan diambil.");
      return;
    }
    this.q = undefined;
    this.cancelPending("Sesi berakhir sebelum keputusan diambil.");
    this.onStreamEnd(failure);
  }

  /** Biaya dicatat dari total berjalan sesi; mengembalikan biaya turn ini. */
  private recordCost(meta: ResultMeta | undefined, monotonicOnly: boolean): number | undefined {
    if (!meta?.sessionId || meta.totalUsd === undefined) return undefined;
    return this.hooks.onCost?.(this.taskId, meta.sessionId, meta.totalUsd, monotonicOnly ? { monotonicOnly } : undefined);
  }

  /**
   * Result ini menjawab pesan kita? SDK meng-echo uuid pesan yang dikonsumsi turn tersebut. Turn yang
   * dimulai CLI sendiri (notifikasi Bash background) tidak membawa uuid kita — dulu result-nya
   * mengakhiri turn kita lebih awal dan melepas slot/kunci di tengah kerja.
   */
  private ownsResult(meta: ResultMeta | undefined): boolean {
    if (meta?.userMessageUuids) {
      this.echoSeen = true;
      return this.turn !== undefined && meta.userMessageUuids.includes(this.turn.uuid);
    }
    if (!this.turn) return false;
    // Turn yang dimulai CLI (notifikasi Bash background) tidak membawa uuid sama sekali.
    if (this.echoSeen) return false;
    // CLI lama tanpa echo: pesan yang masih antre berarti result ini milik turn sebelumnya.
    return !(meta?.queuedTurns && meta.queuedTurns > 0);
  }

  private onResult(instance: Query, meta: ResultMeta | undefined, event: Extract<UiEvent, { type: "result" }>): void {
    const turnCostUsd = this.recordCost(meta, false);
    const mine = this.ownsResult(meta);
    let interrupted = false;
    if (mine) interrupted = this.turn?.stopped === true;
    else if (!this.turn) {
      interrupted = this.stopRequested;
      this.stopRequested = false;
    }
    this.emit({
      ...event,
      ...(turnCostUsd !== undefined ? { turnCostUsd } : {}),
      ...(interrupted ? { interrupted: true } : {}),
      ...(mine ? {} : { background: true }),
    });

    if (mine) {
      // CLI menjalankan turn satu per satu: result kita datang = turn yang ia mulai sendiri (yang
      // mungkin menelan pesan kita di tengah jalan) juga sudah selesai.
      this.backgroundTurn = false;
      this.finishTurn(event.subtype, event.isError, interrupted);
    } else if (this.backgroundTurn) {
      this.backgroundTurn = false;
      if (!this.turn) this.clearStopGrace();
      if (!this.busy && !this.turn) {
        if (this.status !== "error") this.setStatus("idle");
        this.hooks.onTurnEnd(this.taskId, {
          subtype: event.subtype,
          isError: event.isError,
          interrupted,
          background: true,
          followUp: this.inbox.length > 0,
          lastText: this.lastText,
        });
        if (this.inbox.length > 0) void this.pump();
        else this.startIdleTimer();
      }
    }
    this.refreshContext(instance, true);
  }

  /**
   * CLI mulai bekerja sendiri saat runner idle (mis. menindaklanjuti Bash background yang selesai).
   * Tampilkan sebagai kerja supaya Stop terlihat. Turn ini tidak bisa memegang slot maupun kunci
   * workspace — CLI tidak bisa dijeda sampai slot tersedia.
   */
  private noteActivity(): void {
    if (this.backgroundTurn || this.turn || this.busy) return;
    this.backgroundTurn = true;
    this.clearIdleTimer();
    this.lastText = "";
    this.setStatus("working");
  }

  /** Aliran sesi yang masih aktif berakhir sendiri: proses mati, error, atau selesai tanpa result. */
  private onStreamEnd(failure: string | undefined): void {
    this.clearStopGrace();
    const background = this.backgroundTurn;
    this.backgroundTurn = false;
    const stopped = this.turn?.stopped === true || this.stopRequested;
    // Turn kita terbuka = pesannya sudah dikirim (turn) atau sudah diambil dari inbox (pendingTurn).
    const openTurn = this.turn !== undefined || this.pendingTurn !== undefined;
    if (!openTurn) {
      // Proses yang mati saat idle tidak menggagalkan tugas; pesan berikutnya memulai sesi baru.
      this.stopRequested = false;
      if (failure) this.emit({ type: "notice", text: `Sesi Claude berhenti: ${failure}` });
      // Pump yang sedang mengantre slot akan memulai sesi baru sendiri.
      if (this.busy) return;
      this.setStatus("idle");
      if (background) {
        // Turn yang dimulai CLI ikut mati: tanpa laporan ini tugas tertinggal "berjalan" selamanya.
        this.hooks.onTurnEnd(this.taskId, {
          subtype: stopped ? "interrupted" : "error_during_execution",
          isError: !stopped,
          interrupted: stopped,
          background: true,
          followUp: this.inbox.length > 0,
          lastText: this.lastText,
        });
      }
      if (this.inbox.length > 0) void this.pump();
      else this.startIdleTimer();
      return;
    }
    if (!stopped) {
      this.emit({ type: "error", message: failure ?? "Sesi Claude berakhir sebelum turn selesai." });
      this.setStatus("error");
    }
    this.finishTurn(stopped ? "interrupted" : "error_during_execution", !stopped, stopped);
  }

  /** Indikator konteks tidak boleh mengganggu tugas, jadi kegagalannya diabaikan. */
  private refreshContext(instance: Query, persist: boolean): void {
    this.contextCheckedAt = Date.now();
    void instance
      .getContextUsage({ detail: "summary" })
      .then((usage) => {
        // Sesi sudah diganti atau ditutup: angkanya bukan lagi milik penugasan yang sekarang.
        if (this.q !== instance) return;
        const context: ContextUsage = {
          usedTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
        };
        this.emit({ type: "context", ...context });
        if (persist) this.hooks.onContext(this.taskId, context);
      })
      .catch(() => undefined);
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

  /** `keepStop`: CLI masih menghentikan turn yang ia mulai sendiri — result-nya tetap ditunggu sebagai "dihentikan". */
  private finishTurn(subtype: string, isError: boolean, interrupted = false, keepStop = false): void {
    this.turn = undefined;
    this.pendingTurn = undefined;
    if (!keepStop) {
      this.stopRequested = false;
      this.clearStopGrace();
    }
    this.invalidateSlotClaims();
    this.freeSlot();
    this.freeLock();
    this.busy = false;
    if (this.status !== "error") this.setStatus("idle");
    const followUp = this.inbox.length > 0;
    this.hooks.onTurnEnd(this.taskId, { subtype, isError, interrupted, followUp, lastText: this.lastText });
    if (followUp) void this.pump();
    else this.startIdleTimer();
  }

  // ---------- idle ----------

  private startIdleTimer(): void {
    this.clearIdleTimer();
    if (this.closed || this.turn) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.turn || this.backgroundTurn || this.inbox.length > 0 || this.pending.size > 0) return;
      // Owner sedang memakai browser bot dari tab Live: jangan tutup di bawah tangannya, coba lagi nanti.
      if (control.isHeld(this.taskId)) {
        this.startIdleTimer();
        return;
      }
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
    this.clearStopGrace();
    // `q` dikosongkan sebelum close(): pesan yang masih tertahan di buffer sudah dianggap basi.
    const instance = this.q;
    this.q = undefined;
    this.queryDir = undefined;
    this.turn = undefined;
    this.stopRequested = false;
    this.backgroundTurn = false;
    try {
      instance?.close();
    } catch {
      // proses mungkin sudah mati
    }
    // Chromium ikut ditutup; saat dilanjutkan agen cukup memanggil open() lagi.
    void this.browser?.close().catch(() => undefined);
  }

  // ---------- kendali ----------

  /**
   * Stop. Slot dan antrean dilepas seketika (sebelum await apa pun). Kunci workspace baru dilepas
   * setelah CLI benar-benar berhenti — result turn itu, kuitansi yang membatalkannya, atau tutup paksa
   * — karena sampai saat itu tool yang sedang jalan masih bisa menulis di folder ini. Pesan baru
   * menunggu di inbox sampai turn yang dihentikan selesai (lihat `pump`).
   */
  async interrupt(): Promise<void> {
    const instance = this.q;
    const stopped = this.turn;
    const cliBusy = stopped !== undefined || this.backgroundTurn || this.pending.size > 0;
    const requests = [...this.pending.keys()];
    const dropped = this.inbox.splice(0).length + (this.pendingTurn !== undefined ? 1 : 0);
    this.pendingTurn = undefined;
    this.invalidateSlotClaims();
    this.freeSlot();
    if (!stopped) this.freeLock();
    this.busy = false;
    if (stopped) stopped.stopped = true;
    if (instance && cliBusy) {
      this.stopRequested = true;
      this.armStopGrace(instance);
    }
    this.setStatus("idle");
    if (dropped > 0) this.emit({ type: "notice", text: `${dropped} pesan yang belum dikerjakan dibatalkan oleh Stop.` });
    // Interrupt dulu baru kartu ditutup: kalau kartu duluan, CLI sempat melanjutkan turn dengan penolakan.
    const receipt = instance ? await interruptAll(instance) : undefined;
    for (const id of requests) this.cancelRequest(id, "Dibatalkan oleh owner (tombol Stop).");
    // Kuitansi ditulis sebelum result turn yang dihentikan, jadi turn kita pasti masih terbuka di sini.
    if (instance && stopped && this.turn === stopped && this.q === instance) {
      if (receipt?.cancelled?.includes(stopped.uuid)) {
        // Pesan kita masih antre dan dibatalkan sebelum sempat jalan: result-nya tidak akan pernah datang.
        this.finishTurn("interrupted", false, true, this.backgroundTurn);
      } else if (receipt?.still_queued?.includes(stopped.uuid)) {
        // CLI lama mengabaikan cancel_queued — pesannya tetap akan dijalankan. Hentikan prosesnya (sesi bisa di-resume).
        this.emit({ type: "notice", text: "Pesan yang masih antre tidak bisa dibatalkan — proses Claude ditutup." });
        this.stopSession();
        this.finishTurn("interrupted", false, true);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Result turn yang dihentikan tidak datang juga: tutup paksa sesinya (bisa di-resume) dan lanjutkan. */
  private armStopGrace(instance: Query): void {
    this.clearStopGrace();
    this.stopGrace = setTimeout(() => {
      this.stopGrace = undefined;
      if (this.q !== instance || this.closed) return;
      if (!this.turn?.stopped && !this.stopRequested) return;
      const hadTurn = this.turn !== undefined;
      this.emit({ type: "notice", text: "Sesi tidak merespons Stop — proses Claude ditutup paksa." });
      this.stopSession();
      if (hadTurn) {
        this.finishTurn("interrupted", false, true);
        return;
      }
      this.setStatus("idle");
      if (this.inbox.length > 0) void this.pump();
      else this.startIdleTimer();
    }, CONFIG.stopGraceMs);
    this.stopGrace.unref();
  }

  private clearStopGrace(): void {
    if (this.stopGrace) clearTimeout(this.stopGrace);
    this.stopGrace = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.invalidateSlotClaims();
    this.clearIdleTimer();
    this.cancelPending("Tugas ditutup.");
    this.stopSession();
    this.pendingTurn = undefined;
    // Dikembalikan sebelum menunggu browser: Chromium yang macet tidak boleh menahan tugas lain.
    this.freeSlot();
    this.freeLock();
    this.busy = false;
    // Browser QA hidup di proses kita sendiri; kalau agen tidak sempat memanggil
    // browser.close, proses Chromium-nya akan tertinggal.
    await closeBrowserFor(this.taskId);
    await this.browser?.close().catch(() => undefined);
  }

  // ---------- izin & pertanyaan ----------

  private cancelPending(message: string): void {
    for (const id of [...this.pending.keys()]) this.cancelRequest(id, message);
  }

  private cancelRequest(id: string, message: string): void {
    const request = this.pending.get(id);
    if (!request) return;
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

  private handlePermission: CanUseTool = async (toolName, input, context): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion") {
      const questions = (Array.isArray(input.questions) ? input.questions : []) as AskQuestion[];
      const questionId = randomUUID();
      const answers = (await this.awaitDecision(
        questionId,
        "question",
        { type: "question", questionId, questions },
        context.signal,
      )) as Record<string, string>;
      if (this.cancelled.delete(questionId)) return { behavior: "deny", message: "Dibatalkan oleh owner." };
      this.emit({ type: "question_resolved", questionId, answers });
      if (!(await this.resumeAfterDecision())) return { behavior: "deny", message: "Dibatalkan oleh owner." };
      return { behavior: "allow", updatedInput: { questions, answers } };
    }

    const approvalId = randomUUID();
    const suggestions = context.suggestions ?? [];
    const decision = (await this.awaitDecision(
      approvalId,
      "approval",
      {
        type: "approval",
        approvalId,
        toolName,
        input,
        title: context.title,
        description: context.description,
        reason: context.decisionReason,
        canRemember: !context.suppressAlwaysAllowRule && suggestions.some((s) => s.destination === "localSettings"),
      },
      context.signal,
    )) as ApprovalDecision;

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
    if (!(await this.resumeAfterDecision())) return { behavior: "deny", message: "Dibatalkan oleh owner." };

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

  /**
   * Selama menunggu manusia, slot dilepas supaya tugas lain bisa jalan. Kunci workspace TIDAK
   * dilepas: tugas kode lain di folder yang sama menunggu sampai turn ini benar-benar selesai.
   */
  private async awaitDecision(
    id: string,
    kind: PendingRequest["kind"],
    event: UiEvent,
    signal?: AbortSignal,
  ): Promise<unknown> {
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

    // Claude Code bisa mencabut permintaan sendiri; tanpa ini kartunya tertinggal tanpa pemilik.
    const onAbort = () => {
      this.cancelRequest(id, "Permintaan dicabut oleh agen.");
      void this.resumeAfterDecision();
    };
    const value = await new Promise<unknown>((resolve) => {
      this.pending.set(id, { kind, event, resolve });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    signal?.removeEventListener("abort", onAbort);
    return value;
  }

  /**
   * Ambil lagi slot setelah keputusan. Dipanggil SESUDAH hasilnya diumumkan: slot bisa saja
   * penuh lama, dan kartu tidak boleh membeku selama tugas mengantre.
   *
   * Aturannya: slot hanya dipegang kalau tidak ada permintaan terbuka, dan keputusan terakhirlah
   * yang mengambilnya. Mengembalikan false kalau turn-nya sudah dihentikan selama mengantre.
   */
  private async resumeAfterDecision(): Promise<boolean> {
    if (this.closed) return false;
    if (this.pending.size > 0) return true;
    if (!this.busy) {
      // Turn yang dimulai CLI sendiri tidak memegang slot; ia tetap berjalan setelah keputusan.
      if (this.status === "waiting") this.setStatus(this.backgroundTurn ? "working" : "idle");
      return true;
    }
    const epoch = this.slotEpoch;
    // Kalau slot penuh, tugas mengantre — bukan "butuh Anda" lagi.
    if (this.status === "waiting") this.setStatus("starting");
    if (!this.release) {
      if (!this.reacquiring) {
        const attempt: Promise<void> = this.hooks.acquire(this.role).then((release) => {
          if (this.reacquiring === attempt) this.reacquiring = undefined;
          if (this.closed || epoch !== this.slotEpoch || this.pending.size > 0) release();
          else this.holdSlot(release);
        });
        this.reacquiring = attempt;
      }
      await this.reacquiring;
    }
    if (this.closed || epoch !== this.slotEpoch) return false;
    if (this.status === "starting") this.setStatus("working");
    return true;
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
