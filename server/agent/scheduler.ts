import { CONFIG } from "../config.ts";
import { workspaceForTask } from "../context.ts";
import { composeHandoffMessage, composeOpeningMessage, composeReviewMessage } from "../messages.ts";
import { ROLES } from "../roles.ts";
import { defaultModeFor } from "../settings.ts";
import {
  activeTasks,
  addAssignment,
  addCost,
  currentAssignment,
  extractHandoffSummary,
  getTask,
  patchAssignment,
  updateTask,
  type Task,
} from "../tasks.ts";
import type { AutonomyMode, RoleId, WorkerStatus } from "../types.ts";
import { bus } from "./bus.ts";
import { TaskRunner } from "./runner.ts";
import { Semaphore } from "./semaphore.ts";

/** Role yang menulis ke workspace: hanya boleh satu yang aktif pada satu waktu. */
const WRITES_WORKSPACE: RoleId[] = ["engineer", "devops"];

type WorkspaceLock = { busy: boolean; waiters: Array<() => void> };

class Scheduler {
  private readonly runners = new Map<string, TaskRunner>();
  private readonly slots = new Semaphore(CONFIG.maxConcurrentAgents);
  /** Satu kunci per folder workspace: dua project dengan folder berbeda boleh menulis bersamaan. */
  private readonly workspaceLocks = new Map<string, WorkspaceLock>();

  // ---------- kunci & slot ----------

  private lockFor(dir: string): WorkspaceLock {
    let lock = this.workspaceLocks.get(dir);
    if (!lock) {
      lock = { busy: false, waiters: [] };
      this.workspaceLocks.set(dir, lock);
    }
    return lock;
  }

  private async acquireWorkspace(dir: string): Promise<void> {
    const lock = this.lockFor(dir);
    if (!lock.busy) {
      lock.busy = true;
      return;
    }
    await new Promise<void>((resolve) => lock.waiters.push(resolve));
  }

  private releaseWorkspace(dir: string): void {
    const lock = this.lockFor(dir);
    const next = lock.waiters.shift();
    if (next) next();
    else lock.busy = false;
  }

  /**
   * Urutan sengaja: kunci workspace dulu, baru slot. Dengan begitu tugas kode yang
   * menunggu gilirannya tidak menahan slot yang bisa dipakai tugas QA.
   */
  private acquire = async (role: RoleId, taskId: string): Promise<(() => void)> => {
    const dir = WRITES_WORKSPACE.includes(role) ? workspaceForTask(taskId) : undefined;
    if (dir) await this.acquireWorkspace(dir);
    const releaseSlot = await this.slots.acquire();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
      if (dir) this.releaseWorkspace(dir);
    };
  };

  // ---------- runner ----------

  private runnerFor(task: Task): TaskRunner {
    const existing = this.runners.get(task.id);
    if (existing && existing.role === task.role) return existing;
    if (existing) void existing.close();

    const runner = new TaskRunner(task.id, task.role, {
      acquire: (role) => this.acquire(role, task.id),
      onSession: (taskId, sessionId) => {
        patchAssignment(taskId, { sessionId });
      },
      onStatus: (taskId, status) => this.onStatus(taskId, status),
      onTurnEnd: (taskId, outcome) => this.onTurnEnd(taskId, outcome),
      onIdleShutdown: () => undefined,
    }, currentAssignment(task).sessionId, task.mode ?? defaultModeFor(task.role));

    this.runners.set(task.id, runner);
    return runner;
  }

  getRunner(taskId: string): TaskRunner | undefined {
    return this.runners.get(taskId);
  }

  findRunnerWithRequest(requestId: string): TaskRunner | undefined {
    return [...this.runners.values()].find((runner) => runner.hasRequest(requestId));
  }

  // ---------- transisi status tugas ----------

  private onStatus(taskId: string, status: WorkerStatus): void {
    const task = getTask(taskId);
    if (!task || task.status === "cancelled" || task.status === "done") return;
    if (status === "working" || status === "starting") {
      updateTask(taskId, { status: "running", startedAt: task.startedAt ?? new Date().toISOString() });
    } else if (status === "waiting") {
      updateTask(taskId, { status: "waiting" });
    } else if (status === "idle" && task.status === "waiting") {
      // Permintaan persetujuannya hilang (sesi ditutup / idle shutdown) — jangan
      // tinggalkan tugas menggantung di "butuh Anda" selamanya.
      updateTask(taskId, { status: "needs_review" });
    }
  }

  private onTurnEnd(
    taskId: string,
    outcome: { subtype: string; isError: boolean; costUsd?: number; lastText: string },
  ): void {
    const task = getTask(taskId);
    if (!task) return;
    if (task.status !== "cancelled") {
      bus.publishAttention({
        kind: outcome.isError ? "failed" : "needs_review",
        taskId,
        role: task.role,
        title: outcome.isError
          ? `${ROLES[task.role].title} gagal menyelesaikan ${taskId}`
          : `${ROLES[task.role].title} selesai — ${taskId} perlu dibaca`,
        detail: task.title,
        at: new Date().toISOString(),
      });
    }
    if (outcome.costUsd) addCost(taskId, outcome.costUsd);
    if (outcome.lastText.trim()) patchAssignment(taskId, { summary: extractHandoffSummary(outcome.lastText) });
    if (task.status === "cancelled") return;

    updateTask(taskId, {
      status: outcome.isError ? "failed" : "needs_review",
      finishedAt: new Date().toISOString(),
    });
  }

  // ---------- perintah ----------

  /** Tugas baru: kirim pesan pembuka dan biarkan antrean yang mengatur gilirannya. */
  start(task: Task): void {
    this.runnerFor(task).send(composeOpeningMessage(task), {
      display: task.description || task.title,
      from: "owner",
    });
  }

  send(taskId: string, text: string, options?: { display?: string; from?: "owner" | "system" }): boolean {
    const task = getTask(taskId);
    if (!task) return false;
    updateTask(taskId, { status: "queued", finishedAt: undefined });
    this.runnerFor(task).send(text, options);
    return true;
  }

  /** Ganti mode otonomi satu tugas; berlaku seketika kalau agennya sedang hidup. */
  async setMode(taskId: string, mode: AutonomyMode): Promise<Task | undefined> {
    const task = updateTask(taskId, { mode });
    await this.runners.get(taskId)?.setMode(mode);
    return task;
  }

  async interrupt(taskId: string): Promise<void> {
    await this.runners.get(taskId)?.interrupt();
    const task = getTask(taskId);
    if (task && (task.status === "running" || task.status === "waiting" || task.status === "queued")) {
      updateTask(taskId, { status: "needs_review" });
    }
  }

  async cancel(taskId: string): Promise<void> {
    const runner = this.runners.get(taskId);
    if (runner) {
      await runner.interrupt();
      await runner.close();
      this.runners.delete(taskId);
    }
    updateTask(taskId, { status: "cancelled", finishedAt: new Date().toISOString() });
  }

  /** Oper tugas ke bot lain: runner lama ditutup, bot baru dapat konteks lengkap. */
  async handoff(taskId: string, role: RoleId, note?: string): Promise<Task | undefined> {
    const before = getTask(taskId);
    if (!before) return undefined;
    const previous = currentAssignment(before);

    const runner = this.runners.get(taskId);
    if (runner) {
      await runner.interrupt();
      await runner.close();
      this.runners.delete(taskId);
    }

    bus.emit(taskId, before.role, { type: "handoff", from: before.role, to: role, note });
    const task = addAssignment(taskId, role, note);
    if (!task) return undefined;

    this.runnerFor(task).send(composeHandoffMessage(task, previous, note), {
      display: `Dioper ke ${ROLES[role].title}${note ? ` — ${note}` : ""}`,
      from: "system",
    });
    return task;
  }

  /** Review "perlu perbaikan" dikirim sebagai pesan lanjutan ke bot yang memegang. */
  sendReview(taskId: string, comment: string): boolean {
    const task = getTask(taskId);
    if (!task) return false;
    return this.send(taskId, composeReviewMessage(task, comment), {
      display: `Review: perlu perbaikan — ${comment}`,
      from: "owner",
    });
  }

  /** Setelah server dimulai ulang: lanjutkan tugas yang sempat berjalan. */
  resumePending(): number {
    let resumed = 0;
    for (const task of activeTasks()) {
      const assignment = currentAssignment(task);
      updateTask(task.id, { status: "queued" });
      const fresh = getTask(task.id);
      if (!fresh) continue;
      if (assignment.sessionId) {
        this.runnerFor(fresh).send(
          "Server sempat berhenti di tengah pekerjaan. Lanjutkan tugas ini dari titik terakhir; kalau sudah selesai, cukup tutup dengan ringkasan serah terima.",
          { display: "Melanjutkan setelah server dimulai ulang", from: "system" },
        );
      } else {
        this.start(fresh);
      }
      resumed += 1;
    }
    return resumed;
  }

  stats(): { inUse: number; max: number; runners: number; workspaceBusy: boolean } {
    return {
      inUse: this.slots.inUse,
      max: CONFIG.maxConcurrentAgents,
      runners: this.runners.size,
      workspaceBusy: [...this.workspaceLocks.values()].some((lock) => lock.busy),
    };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runners.values()].map((runner) => runner.close()));
    this.runners.clear();
  }
}

export const scheduler = new Scheduler();
