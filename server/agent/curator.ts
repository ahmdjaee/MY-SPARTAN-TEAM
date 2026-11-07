/**
 * Kurator: agen pendek yang menjaga report utama project.
 *
 * Setiap kali tugas selesai (needs_review/approve) atau pemilik produk menekan Sync,
 * kurator membaca laporan/ringkasan yang berubah, menautkan temuannya ke register
 * (F-nnn), memperbarui status dengan bukti, merapikan memori, lalu menulis ulang
 * kesimpulan project. Ia hanya membaca berkas dan menulis lewat tool MCP-nya sendiri.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, query, tool, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { notifyProject } from "../changes.ts";
import { CONFIG, agentEnv } from "../config.ts";
import {
  COVERAGE_STATES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  appendLog,
  dropInbox,
  inProgressSources,
  mergeFinding,
  pendingSources,
  readCoverage,
  readCuration,
  readInbox,
  readRegister,
  readState,
  setCoverage,
  setFindingStatus,
  upsertFinding,
  writeCuration,
  writeState,
  type PendingSource,
} from "../findings.ts";
import { fitMemory, replaceSection } from "../memory.ts";
import { getProject, listProjects, projectDir, readProjectMemory, workspaceForProject, writeProjectMemory } from "../projects.ts";
import { DENY_ALWAYS } from "../roles.ts";
import { getTask } from "../tasks.ts";
import { bus } from "./bus.ts";
import { scheduler } from "./scheduler.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PERSONA = readFileSync(join(here, "..", "prompts", "curator.md"), "utf8");

/** Sumber per sekali jalan agen; sisanya diproses putaran berikutnya dalam run yang sama. */
const BATCH = 6;
const MAX_ROUNDS = 6;
/** Kurator memegang satu slot agen bersama tugas — tidak boleh menggantung tanpa batas. */
const MAX_TURNS = 80;
const ROUND_TIMEOUT_MS = 15 * 60_000;

/** Putaran yang memanggil memory_write_notes — hanya saat itu kotak masuk boleh dikosongkan. */
const notesWritten = new Set<string>();
const ACTOR = "kurator";
const NOTES_MAX = 8_000;
const READ_TOOLS = ["Read", "Grep", "Glob"];

export type CuratorStatus = {
  running: boolean;
  scheduledAt?: string;
  lastRunAt?: string;
  lastError?: string;
  costUsd: number;
  runs: number;
  pending: number;
  /** Tugas yang masih dikerjakan agen: laporannya baru dikurasi setelah tugas selesai. */
  inProgress: string[];
  inbox: number;
};

// ---------- git baca-saja ----------

const GIT_SUBCOMMANDS = ["log", "show", "diff", "grep", "status", "blame", "rev-parse", "branch"];
/** Opsi git yang bisa menulis berkas atau menjalankan program lain. */
const GIT_FORBIDDEN = /^(--output|--ext-diff|--open-files-in-pager|-O|--exec|--upload-pack|--textconv)/;

function gitRead(cwd: string, args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (!sub || !GIT_SUBCOMMANDS.includes(sub)) {
    return Promise.resolve(`ERROR: hanya ${GIT_SUBCOMMANDS.join("/")} yang diizinkan`);
  }
  if (rest.some((arg) => GIT_FORBIDDEN.test(arg))) return Promise.resolve("ERROR: opsi itu tidak diizinkan");
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-pager", sub, ...(sub === "diff" || sub === "show" ? ["--no-ext-diff", "--no-textconv"] : []), ...rest],
      {
        cwd,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        const text = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
        const clipped = text.length > 20_000 ? `${text.slice(0, 20_000)}\n…(dipotong)` : text;
        resolve(error && !stdout ? `ERROR: ${error.message}\n${clipped}` : clipped || "(kosong)");
      },
    );
  });
}

// ---------- tool kurator ----------

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (error: unknown) => ({
  content: [{ type: "text" as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});

function curatorServer(projectId: string) {
  const workspace = workspaceForProject(projectId);
  return createSdkMcpServer({
    name: "curator",
    version: "0.1.0",
    instructions: "Satu-satunya jalan menulis report project: register temuan, cakupan, kesimpulan, dan catatan memori.",
    tools: [
      tool("register_get", "Isi register temuan project saat ini, lengkap dengan kemunculan dan penutupan.", {}, async () =>
        ok(JSON.stringify(readRegister(projectId).findings, null, 1)),
      ),
      tool(
        "finding_upsert",
        "Tanpa `id`: buat temuan baru. Dengan `id`: tautkan kemunculan baru ke temuan itu (dan perbarui data bila perlu).",
        {
          id: z.string().optional().describe("F-nnn yang sudah ada; kosong = temuan baru"),
          title: z.string().optional().describe("judul netral: gejala + lokasi"),
          area: z.string().optional().describe("fitur/modul, konsisten dengan area yang sudah ada"),
          severity: z.enum(["blocker", "major", "minor"]).optional(),
          summary: z.string().optional().describe("1–3 kalimat: gejala, dampak, dugaan akar masalah"),
          task_id: z.string().describe("tugas yang melaporkan, mis. T-032"),
          local_id: z.string().optional().describe("nomor temuan di laporan itu, mis. T-1"),
          note: z.string().optional().describe("keterangan kemunculan, mis. 'bawaan, identik di 1299'"),
        },
        async (args) => {
          try {
            const finding = upsertFinding(
              projectId,
              {
                id: args.id,
                title: args.title,
                area: args.area,
                severity: args.severity,
                summary: args.summary,
                occurrence: { taskId: args.task_id.trim().toUpperCase(), localId: args.local_id, note: args.note },
              },
              ACTOR,
            );
            return ok(`${finding.id} · ${finding.status} · ${finding.title} (${finding.occurrences.length} kemunculan)`);
          } catch (error) {
            return fail(error);
          }
        },
      ),
      tool(
        "finding_set_status",
        "Ubah status temuan. fixed/wontfix/invalid wajib membawa bukti di `note` (hash commit, file:baris, atau id tugas).",
        {
          id: z.string(),
          status: z.enum(FINDING_STATUSES as [string, ...string[]]),
          by: z.string().describe("hash commit, id tugas, atau 'kode HEAD'"),
          note: z.string().describe("bukti/alasan yang bisa ditelusuri"),
          verified: z.boolean().optional().describe("true bila sudah diuji ulang dan terbukti"),
        },
        async (args) => {
          try {
            const finding = setFindingStatus(
              projectId,
              args.id,
              args.status as (typeof FINDING_STATUSES)[number],
              { by: args.by, note: args.note },
              ACTOR,
              { verified: args.verified },
            );
            return ok(`${finding.id} sekarang ${finding.status}`);
          } catch (error) {
            return fail(error);
          }
        },
      ),
      tool(
        "finding_merge",
        "Gabungkan dua item register yang ternyata satu masalah: kemunculan pindah ke `into`, `duplicate` ditandai invalid.",
        { duplicate: z.string(), into: z.string() },
        async (args) => {
          try {
            const target = mergeFinding(projectId, args.duplicate, args.into, ACTOR);
            return ok(`${args.duplicate} digabung ke ${target.id}`);
          } catch (error) {
            return fail(error);
          }
        },
      ),
      tool(
        "coverage_set",
        "Catat cakupan uji satu area untuk satu persona/lingkungan.",
        {
          area: z.string(),
          subject: z.string().describe("persona/akun/lingkungan, mis. kadiv atau 1300"),
          state: z.enum(COVERAGE_STATES as [string, ...string[]]),
          task_id: z.string().optional(),
          note: z.string().optional(),
        },
        async (args) => {
          const cell = setCoverage(
            projectId,
            {
              area: args.area,
              subject: args.subject,
              state: args.state as (typeof COVERAGE_STATES)[number],
              taskId: args.task_id?.trim().toUpperCase(),
              note: args.note,
            },
            ACTOR,
          );
          return ok(`${cell.area} × ${cell.subject} = ${cell.state}`);
        },
      ),
      tool("state_write", "Tulis ulang kesimpulan project (format di instruksi Anda).", { text: z.string() }, async (args) => {
        writeState(projectId, args.text, ACTOR);
        return ok("kesimpulan project diperbarui");
      }),
      tool(
        "memory_write_notes",
        "Tulis ulang SELURUH isi bagian 'Catatan tim' memori project (bagian lain milik pemilik produk, tidak tersentuh).",
        { text: z.string().describe("daftar butir `- [YYYY-MM-DD] (T-xxx) fakta`") },
        async (args) => {
          const body = args.text.trim();
          if (body.length > NOTES_MAX) return fail(`terlalu panjang (${body.length} > ${NOTES_MAX} karakter) — ringkas dulu`);
          const before = readProjectMemory(projectId);
          writeProjectMemory(projectId, fitMemory(replaceSection(before, "Catatan tim", body)));
          notesWritten.add(projectId);
          appendLog(projectId, { by: ACTOR, action: "memory", detail: "catatan tim dirapikan", before });
          return ok("catatan tim diperbarui");
        },
      ),
      tool(
        "git_read",
        `Baca riwayat git workspace project (baca-saja). Sub-perintah: ${GIT_SUBCOMMANDS.join(", ")}.`,
        { args: z.array(z.string()).describe('mis. ["log","--oneline","-20"] atau ["show","--stat","8d68747"]') },
        async (args) => ok(await gitRead(workspace, args.args)),
      ),
    ],
  });
}

/** Panjang bagian "Catatan tim" — kalau lewat batas, kurator wajib merapikannya walau kotak masuk kosong. */
function notesLength(projectId: string): number {
  const text = readProjectMemory(projectId);
  const start = text.indexOf("## Catatan tim");
  if (start < 0) return 0;
  const rest = text.slice(start + "## Catatan tim".length);
  const end = rest.search(/\n#{1,2}\s+\S/);
  return (end < 0 ? rest : rest.slice(0, end)).trim().length;
}

// ---------- prompt ----------

function describeSources(sources: PendingSource[]): string {
  return sources
    .map((source) => {
      const task = getTask(source.taskId);
      const where =
        source.source === "report"
          ? `laporan: ${source.path}`
          : "ringkasan serah terima (di bawah)";
      const summaries =
        source.source === "summary" && task
          ? `\n${task.assignments
              .filter((assignment) => assignment.summary?.trim())
              .map((assignment) => `  [${assignment.role}] ${assignment.summary!.trim().replace(/\n/g, "\n  ")}`)
              .join("\n")}`
          : "";
      const extra =
        source.source === "report" && task
          ? `\n  (tugas ini juga punya ringkasan serah terima: ${task.assignments.filter((a) => a.summary?.trim()).length} buah — baca lewat laporan/ringkasan bila perlu konteks)`
          : "";
      return `### ${source.taskId} · ${task?.role ?? source.role} · "${source.title}"\n- ${where}${summaries}${extra}`;
    })
    .join("\n\n");
}

export function workMessage(projectId: string, sources: PendingSource[], round: number): string {
  const project = getProject(projectId);
  const inbox = readInbox(projectId);
  const register = readRegister(projectId).findings;
  const coverage = readCoverage(projectId);
  const parts = [
    `# Kurasi project ${project?.name ?? projectId} — putaran ${round}`,
    `Workspace kode: ${workspaceForProject(projectId)}`,
    // sv-SE memberi format YYYY-MM-DD HH:mm menurut zona waktu server.
    `Waktu sekarang: ${new Date().toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })}`,
    "",
    `## Sumber baru/berubah (${sources.length})`,
    sources.length > 0 ? describeSources(sources) : "(tidak ada — hanya rapikan catatan dan kesimpulan)",
    "",
    `## Catatan remember yang belum dirapikan (${inbox.length})`,
    inbox.length > 0 ? inbox.map((item) => `- [${item.at.slice(0, 10)}] (${item.taskId}) ${item.note}`).join("\n") : "(kosong)",
    "",
    `## Register saat ini (${register.length} item)`,
    register.length > 0
      ? register
          .map(
            (finding) =>
              `- ${finding.id} · ${finding.severity} · ${finding.status} · ${finding.title}${finding.area ? ` · ${finding.area}` : ""} · ${[
                ...new Set(finding.occurrences.map((item) => item.taskId)),
              ].join(",")}${finding.mergedInto ? ` · → ${finding.mergedInto}` : ""}`,
          )
          .join("\n")
      : "(kosong — ini kurasi pertama)",
    "Detail lengkap: register_get.",
    "",
    `## Cakupan saat ini (${coverage.length} sel)`,
    coverage.length > 0 ? coverage.map((cell) => `- ${cell.area} × ${cell.subject} = ${cell.state}`).join("\n") : "(kosong)",
    "",
    "## Kesimpulan project saat ini",
    readState(projectId).trim() || "(belum ada)",
    "",
    "## Memori project saat ini",
    readProjectMemory(projectId).trim(),
    ...(notesLength(projectId) > NOTES_MAX
      ? [
          "",
          `**Bagian "Catatan tim" sekarang ${notesLength(projectId)} karakter, melebihi batas ${NOTES_MAX}. Wajib dirapikan putaran ini dengan memory_write_notes** (gabungkan, buang yang basi atau yang sudah tercatat sebagai temuan di register, ganti kredensial dengan "kredensial ada di konteks project").`,
        ]
      : []),
    "",
    "Kerjakan sesuai instruksi Anda, lalu tutup dengan ringkasan pendek.",
  ];
  return parts.join("\n");
}

function options(projectId: string, abort: AbortController): Options {
  const allowTool: CanUseTool = async (toolName, input) =>
    READ_TOOLS.includes(toolName) || toolName.startsWith("mcp__curator__")
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Kurator hanya boleh membaca berkas dan menulis lewat tool mcp__curator__*." };
  const denied = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite"];
  return {
    systemPrompt: { type: "preset", preset: "claude_code", append: PERSONA },
    model: CONFIG.models.curator,
    effort: CONFIG.effort.curator,
    cwd: workspaceForProject(projectId),
    additionalDirectories: [CONFIG.tasksDir, projectDir(projectId)],
    settingSources: [],
    settings: { permissions: { allow: [...READ_TOOLS, "mcp__curator__*"], ask: [], deny: [...denied, ...DENY_ALWAYS] } },
    allowedTools: [...READ_TOOLS, "mcp__curator__*"],
    disallowedTools: denied,
    permissionMode: "default",
    canUseTool: allowTool,
    mcpServers: { curator: curatorServer(projectId) },
    maxTurns: MAX_TURNS,
    abortController: abort,
    persistSession: false,
    env: agentEnv(),
  };
}

// ---------- penjadwal ----------

class Curator {
  private readonly running = new Set<string>();
  /** Ada pemicu baru saat kurasi berjalan — jalankan lagi sesudahnya. */
  private readonly again = new Set<string>();
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; at: string }>();
  private readonly errors = new Map<string, string>();
  private readonly aborts = new Map<string, AbortController>();

  /** Tugas selesai → kurasi setelah jeda, supaya tugas yang selesai berdekatan digabung. */
  watch(): void {
    if (!CONFIG.curatorAuto) return;
    bus.subscribeAll((event) => {
      if (event.kind !== "needs_review" && event.kind !== "failed") return;
      const projectId = getTask(event.taskId)?.projectId;
      if (projectId) this.schedule(projectId);
    });
  }

  /**
   * Saat server start: lanjutkan sumber yang tertinggal (pemicu hilang karena restart atau kurasi gagal).
   * Project yang belum pernah dikurasi dilewati supaya start tidak memicu biaya tanpa diminta; itu menunggu Sync.
   */
  catchUp(): void {
    for (const project of listProjects()) {
      try {
        if (readCuration(project.id).runs > 0 && pendingSources(project.id).length > 0) this.schedule(project.id);
      } catch (error) {
        console.error(`kurasi susulan ${project.id} dilewati: ${(error as Error).message}`);
      }
    }
  }

  schedule(projectId: string, delayMs = CONFIG.curatorDebounceMs): void {
    if (!CONFIG.curatorAuto && delayMs > 0) return;
    const existing = this.timers.get(projectId);
    if (existing) clearTimeout(existing.timer);
    const at = new Date(Date.now() + delayMs).toISOString();
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      void this.run(projectId);
    }, delayMs);
    timer.unref();
    this.timers.set(projectId, { timer, at });
    // Laporan project menampilkan "dijadwalkan" — klien yang membukanya diberi tahu, bukan polling.
    notifyProject(projectId);
  }

  status(projectId: string): CuratorStatus {
    const state = readCuration(projectId);
    return {
      running: this.running.has(projectId),
      scheduledAt: this.timers.get(projectId)?.at,
      lastRunAt: state.lastRunAt,
      lastError: this.errors.get(projectId) ?? state.lastError,
      costUsd: state.costUsd,
      runs: state.runs,
      pending: pendingSources(projectId).length,
      inProgress: inProgressSources(projectId),
      inbox: readInbox(projectId).length,
    };
  }

  /** Jalankan sekarang. Kalau sedang berjalan, satu putaran tambahan dijadwalkan sesudahnya. */
  async run(projectId: string, force = false): Promise<void> {
    if (!getProject(projectId)) return;
    if (this.running.has(projectId)) {
      this.again.add(projectId);
      return;
    }
    this.running.add(projectId);
    this.errors.delete(projectId);
    notifyProject(projectId);
    try {
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        const sources = pendingSources(projectId).slice(0, BATCH);
        const inboxAt = readInbox(projectId).at(-1)?.at;
        const needsState = round === 1 && !readState(projectId).trim() && readRegister(projectId).findings.length > 0;
        const needsMemory = round === 1 && notesLength(projectId) > NOTES_MAX;
        if (sources.length === 0 && !inboxAt && !needsState && !needsMemory && !(force && round === 1)) break;
        await this.round(projectId, sources, round, inboxAt);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(projectId, message);
      writeCuration(projectId, { ...readCuration(projectId), lastError: message });
      appendLog(projectId, { by: ACTOR, action: "error", detail: message });
    } finally {
      this.running.delete(projectId);
      notifyProject(projectId);
      if (this.again.delete(projectId)) this.schedule(projectId, 5_000);
    }
  }

  /** Saat server dimatikan: hentikan kurator yang sedang berjalan supaya proses Claude-nya tidak tertinggal. */
  closeAll(): void {
    for (const abort of this.aborts.values()) abort.abort(new Error("server dimatikan"));
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async round(projectId: string, sources: PendingSource[], round: number, inboxAt?: string): Promise<void> {
    const release = await scheduler.acquireSlot();
    let costUsd = 0;
    let failure: string | undefined;
    const abort = new AbortController();
    this.aborts.set(projectId, abort);
    const timeout = setTimeout(() => abort.abort(new Error("kurator melewati batas waktu putaran")), ROUND_TIMEOUT_MS);
    timeout.unref();
    notesWritten.delete(projectId);
    try {
      const instance = query({ prompt: workMessage(projectId, sources, round), options: options(projectId, abort) });
      for await (const message of instance) {
        if (message.type !== "result") continue;
        const result = message as unknown as Record<string, unknown>;
        if (typeof result.total_cost_usd === "number") costUsd = result.total_cost_usd;
        if (result.subtype !== "success" || result.is_error === true) {
          failure = `kurator berhenti: ${String(result.subtype)}${typeof result.result === "string" ? ` — ${result.result.slice(0, 300)}` : ""}`;
        }
      }
    } catch (error) {
      failure = `kurator berhenti: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearTimeout(timeout);
      this.aborts.delete(projectId);
      release();
    }

    const state = readCuration(projectId);
    const curatedAt = { ...state.curatedAt };
    if (!failure) for (const source of sources) curatedAt[source.taskId] = source.fingerprint;
    writeCuration(projectId, {
      ...state,
      curatedAt,
      costUsd: Number((state.costUsd + costUsd).toFixed(6)),
      runs: state.runs + 1,
      lastRunAt: new Date().toISOString(),
      lastError: failure,
    });
    if (failure) throw new Error(failure);
    // Catatan di kotak masuk baru boleh dibuang kalau memang sudah dipindahkan ke memori;
    // kalau agen melewatkan langkah itu, catatannya tetap menunggu putaran berikutnya.
    if (inboxAt && notesWritten.delete(projectId)) dropInbox(projectId, inboxAt);
    appendLog(projectId, {
      by: ACTOR,
      action: "run",
      detail: `putaran ${round}: ${sources.map((source) => source.taskId).join(", ") || "tanpa sumber baru"} · $${costUsd.toFixed(4)}`,
    });
  }
}

export const curator = new Curator();
