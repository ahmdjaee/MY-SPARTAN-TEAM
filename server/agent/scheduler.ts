import { control } from "../browser/control.ts";
import { closeBrowserFor } from "../browser/mcp.ts";
import { CONFIG } from "../config.ts";
import { composeHandoffMessage, composeOpeningMessage, composeReviewMessage } from "../messages.ts";
import { ROLES } from "../roles.ts";
import { defaultModeFor } from "../settings.ts";
import {
  ACTIVE_STATUSES,
  activeTasks,
  addAssignment,
  currentAssignment,
  extractHandoffSummary,
  getTask,
  hasHandoffSummary,
  patchAssignment,
  recordSessionCost,
  updateTask,
  type Task,
} from "../tasks.ts";
import type { AutonomyMode, RoleId, WorkerStatus } from "../types.ts";
import { bus } from "./bus.ts";
import { TaskRunner, type TurnOutcome } from "./runner.ts";
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
   * Kunci workspace terpisah dari slot. Runner mengambil kunci dulu, baru slot — tugas kode yang
   * menunggu gilirannya tidak menahan slot yang bisa dipakai tugas QA. Kunci dipegang sepanjang
   * turn, termasuk saat menunggu keputusan owner (slotnya dilepas).
   *
   * Bebas deadlock: tidak ada jalur yang meminta kunci sambil memegang slot.
   */
  private lockWorkspace = async (role: RoleId, dir: string): Promise<(() => void) | undefined> => {
    if (!WRITES_WORKSPACE.includes(role)) return undefined;
    // Folder dari runner (cwd sesi yang hidup) dan ditangkap di sini: tugas yang dipindah project di
    // tengah turn tetap mengunci dan melepas folder yang benar-benar ditulis CLI.
    await this.acquireWorkspace(dir);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseWorkspace(dir);
    };
  };

  /** Slot agen untuk pekerjaan di luar tugas (kurator), supaya ikut batas MAX_CONCURRENT_AGENTS. */
  acquireSlot(): Promise<() => void> {
    return this.slots.acquire();
  }

  // ---------- runner ----------

  private runnerFor(task: Task): TaskRunner {
    const existing = this.runners.get(task.id);
    if (existing && existing.role === task.role) return existing;
    if (existing) void existing.close();

    const runner = new TaskRunner(task.id, task.role, {
      acquire: () => this.slots.acquire(),
      lockWorkspace: (role, dir) => this.lockWorkspace(role, dir),
      onSession: (taskId, sessionId) => {
        patchAssignment(taskId, { sessionId });
      },
      onCost: (taskId, sessionId, totalUsd, options) => recordSessionCost(taskId, sessionId, totalUsd, options),
      onStatus: (taskId, status) => this.onStatus(taskId, status),
      onTurnEnd: (taskId, outcome) => this.onTurnEnd(taskId, outcome),
      onIdleShutdown: (taskId) => this.onIdleShutdown(taskId),
      onContext: (taskId, usage) => {
        patchAssignment(taskId, { context: { ...usage, at: new Date().toISOString() } });
      },
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

  /** Sesi idle sudah ditutup; tugas yang tidak aktif lagi tidak perlu menahan runner (dan browsernya). */
  private onIdleShutdown(taskId: string): void {
    const runner = this.runners.get(taskId);
    const task = getTask(taskId);
    if (!runner || !task || ACTIVE_STATUSES.includes(task.status)) return;
    this.runners.delete(taskId);
    void runner.close();
  }

  /** Biaya sudah dicatat runner lewat `onCost` (selisih total sesi), bukan di sini. */
  private onTurnEnd(taskId: string, outcome: TurnOutcome): void {
    const task = getTask(taskId);
    if (!task) return;
    // Turn yang dimulai CLI sendiri (mis. job Bash background selesai) tidak membuka lagi tugas yang
    // sudah Anda setujui atau batalkan.
    if (outcome.background && (task.status === "done" || task.status === "cancelled")) return;
    // Stop dari owner berakhir dengan result error_during_execution — itu bukan kegagalan.
    const failed = outcome.isError && !outcome.interrupted;
    if (task.status !== "cancelled") {
      const title = ROLES[task.role].title;
      bus.publishAttention({
        kind: failed ? "failed" : "needs_review",
        taskId,
        role: task.role,
        title: failed
          ? `${title} gagal menyelesaikan ${taskId}`
          : outcome.interrupted
            ? `${title} dihentikan — ${taskId}`
            : `${title} selesai — ${taskId} perlu dibaca`,
        detail: task.title,
        at: new Date().toISOString(),
        // Stop dari Anda sendiri, atau pesan berikutnya langsung jalan: tidak perlu notifikasi.
        ...(outcome.interrupted || outcome.followUp ? { silent: true } : {}),
      });
    }

    // Ringkasan dan status ditulis sekali; turn yang terpotong bukan ringkasan serah terima. Turn yang
    // dimulai CLI ("Build selesai.") baru menggantikannya kalau ia menulis bagian serah terima sendiri.
    const patch: Partial<Task> = {};
    if (!outcome.interrupted && outcome.lastText.trim() && (!outcome.background || hasHandoffSummary(outcome.lastText))) {
      const assignments = [...task.assignments];
      const last = assignments[assignments.length - 1];
      if (last) {
        assignments[assignments.length - 1] = { ...last, summary: extractHandoffSummary(outcome.lastText) };
        patch.assignments = assignments;
      }
    }
    if (task.status !== "cancelled" && !outcome.followUp) {
      patch.status = failed ? "failed" : "needs_review";
      patch.finishedAt = new Date().toISOString();
    }
    if (Object.keys(patch).length > 0) updateTask(taskId, patch);
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
    // Tugas yang sedang jalan atau menunggu keputusan tetap di statusnya; pesannya masuk antrean runner.
    if (!ACTIVE_STATUSES.includes(task.status)) updateTask(taskId, { status: "queued", finishedAt: undefined });
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
    const runner = this.runners.get(taskId);
    await runner?.interrupt();
    // Pesan yang dikirim tepat setelah Stop mungkin sudah jalan lagi — statusnya jangan ditimpa.
    if (runner && runner.status !== "idle") return;
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

  /**
   * Lepas semua yang masih hidup untuk tugas ini — agen, browser QA, kendali owner — tanpa
   * mengubah statusnya. Dipakai sebelum tugas dihapus.
   */
  async dispose(taskId: string): Promise<void> {
    const runner = this.runners.get(taskId);
    if (runner) {
      await runner.interrupt();
      await runner.close();
      this.runners.delete(taskId);
    }
    // Runner sudah menutup browsernya; ini untuk sesi yang hidup tanpa runner (mis. setelah oper).
    await closeBrowserFor(taskId);
    control.release(taskId, undefined, "Tugas dihapus.");
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
