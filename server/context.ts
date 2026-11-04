import { OPEN_STATUSES, appendInbox, getFinding, readInbox, readRegister, readState, registerDigest, type FindingStatus } from "./findings.ts";
import { readMemory } from "./memory.ts";
import {
  defaultProjectId,
  getProject,
  readContext,
  readProjectMemory,
  workspaceForProject,
  type Project,
} from "./projects.ts";
import { ROLES } from "./roles.ts";
import {
  getTask,
  listDocs,
  orphanTasks,
  reportPath,
  taskDir,
  tasksInProject,
  updateTask,
  type Task,
  type TaskStatus,
} from "./tasks.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { threads } from "./store.ts";

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "antre",
  running: "dikerjakan",
  waiting: "butuh pemilik produk",
  needs_review: "perlu dibaca",
  done: "selesai",
  failed: "gagal",
  cancelled: "dibatalkan",
};

/** Maksimal tugas sebelah yang diringkas ke konteks; sisanya diambil lewat tool `project_tasks`. */
const SIBLING_MAX = 12;
/** Catatan kotak masuk yang ikut konteks; sisanya menunggu dirapikan kurator. */
const INBOX_MAX = 30;
const SIBLING_CHARS = 160;

export function projectOfTask(taskId: string): Project | undefined {
  const task = getTask(taskId);
  return task ? getProject(task.projectId) : undefined;
}

export function workspaceForTask(taskId: string): string {
  return workspaceForProject(getTask(taskId)?.projectId);
}

/** Ringkasan serah terima terakhir yang pernah ditulis bot di tugas itu. */
export function lastSummary(task: Task): string | undefined {
  for (let i = task.assignments.length - 1; i >= 0; i -= 1) {
    const summary = task.assignments[i]?.summary?.trim();
    if (summary) return summary;
  }
  return undefined;
}

function oneLine(text: string, max = SIBLING_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export type Sibling = {
  id: string;
  role: string;
  status: TaskStatus;
  title: string;
  summary?: string;
  hasReport: boolean;
};

/** Tugas lain di project yang sama — inilah yang membuat satu tugas tahu tugas sebelah. */
export function siblings(task: Task): Sibling[] {
  return tasksInProject(task.projectId)
    .filter((other) => other.id !== task.id && other.status !== "cancelled")
    .map((other) => ({
      id: other.id,
      role: ROLES[other.role].title,
      status: other.status,
      title: other.title,
      summary: lastSummary(other),
      hasReport: existsSync(reportPath(other.id)),
    }));
}

/**
 * Blok yang ditempel ke system prompt setiap sesi tugas.
 * Isinya khusus project tugas ini: konteks tulisan pemilik produk, memori yang
 * ditulis bot di project ini, memori global, dan ringkasan tugas sebelah.
 */
export function contextBlock(taskId: string): string {
  const task = getTask(taskId);
  if (!task) return "";
  const project = getProject(task.projectId);
  const parts: string[] = [];

  if (project) {
    parts.push(`# Project: ${project.name}`);
    const context = readContext(project.id).trim();
    if (context) parts.push(context);

    const memory = readProjectMemory(project.id).trim();
    if (memory) parts.push(`## Memori project (ditulis tim)\n${stripHeading(memory)}`);

    // Catatan `remember` yang belum sempat dikurasi tetap terbaca, supaya tidak hilang di antara dua kurasi.
    const inbox = readInbox(project.id).slice(-INBOX_MAX);
    if (inbox.length > 0) {
      parts.push(
        ["## Catatan tim terbaru (belum dirapikan kurator)", ...inbox.map((item) => `- [${item.at.slice(0, 10)}] (${item.taskId}) ${item.note}`)].join("\n"),
      );
    }

    const state = readState(project.id).trim();
    if (state) parts.push(`## Status project (ditulis kurator)\n${stripHeading(state)}`);

    const register = registerDigest(project.id);
    if (register) {
      parts.push(
        [
          "## Register temuan project",
          register,
          "",
          "Ini sumber kebenaran temuan di project ini. Sebelum melaporkan temuan, cocokkan dengan daftar di atas: temuan yang sama dirujuk dengan id F-nnn-nya, yang sudah ditutup tidak dilaporkan ulang kecuali muncul lagi (tulis sebagai regresi). Detail satu temuan: tool `finding_detail`; daftar per status: `findings_list`.",
        ].join("\n"),
      );
    }
  }

  const global = readMemory().trim();
  if (global) parts.push(`## Memori global\n${stripHeading(global)}`);

  const list = siblings(task).slice(0, SIBLING_MAX);
  if (list.length > 0) {
    const lines = list.map((item) => {
      const tail = item.summary ? ` — ${oneLine(item.summary)}` : "";
      return `- ${item.id} · ${item.role} · ${STATUS_LABEL[item.status]} · "${oneLine(item.title, 80)}"${tail}`;
    });
    parts.push(
      [
        "## Tugas lain di project ini",
        ...lines,
        "",
        "Butuh detail salah satunya (instruksi asli, ringkasan lengkap, laporan)? panggil tool `project_task` dengan id tugasnya.",
      ].join("\n"),
    );
  }

  if (parts.length === 0) return "";
  return `\n\n---\n\n${parts.join("\n\n")}\n\n(Konteks di atas berlaku untuk project ini. Pakai isinya tanpa bertanya ulang; kalau ada yang bertentangan dengan instruksi tugas, instruksi tugas yang menang.)`;
}

/** Judul `# …` berkas memori tidak perlu ikut, karena sudah dibungkus heading sendiri. */
function stripHeading(text: string): string {
  return text.replace(/^#\s+[^\n]*\n+/, "").trim();
}

export type ToolAnswer = { text: string; isError?: boolean };

/** Tool `project_tasks`: daftar tugas sebelah beserta ringkasannya. */
export function siblingList(taskId: string): ToolAnswer {
  const task = getTask(taskId);
  if (!task) return { text: "ERROR: tugas tidak ditemukan", isError: true };
  const list = siblings(task);
  if (list.length === 0) return { text: "Belum ada tugas lain di project ini." };
  const lines = list.map(
    (item) =>
      `- ${item.id} · ${item.role} · ${STATUS_LABEL[item.status]}${item.hasReport ? " · ada laporan" : ""} · "${item.title}"${
        item.summary ? `\n  ${oneLine(item.summary, 300)}` : ""
      }`,
  );
  return {
    text: `${list.length} tugas lain di project ini:\n${lines.join("\n")}\n\nDetail satu tugas: project_task(task_id).`,
  };
}

/**
 * Tool `project_task`: detail satu tugas sebelah.
 * Project adalah batas konteks, jadi tugas di project lain ditolak di sini.
 */
export function siblingDetail(taskId: string, otherId: string): ToolAnswer {
  const task = getTask(taskId);
  if (!task) return { text: "ERROR: tugas tidak ditemukan", isError: true };
  const other = getTask(otherId.trim().toUpperCase());
  if (!other) return { text: `ERROR: tugas ${otherId} tidak ada`, isError: true };
  if (other.projectId !== task.projectId) {
    return { text: `ERROR: ${other.id} ada di project lain, di luar jangkauan tugas ini`, isError: true };
  }

  const parts = [
    `# ${other.id} — ${other.title}`,
    `bot: ${ROLES[other.role].title} · status: ${STATUS_LABEL[other.status]}${other.targetUrl ? ` · target: ${other.targetUrl}` : ""}`,
    "",
    "## Instruksi asli",
    other.description || "(kosong)",
  ];
  const summaries = other.assignments.filter((assignment) => assignment.summary?.trim());
  if (summaries.length > 0) {
    parts.push("", "## Ringkasan serah terima");
    for (const assignment of summaries) {
      parts.push(`### ${ROLES[assignment.role].title}`, assignment.summary!.trim());
    }
  }
  const report = reportPath(other.id);
  if (existsSync(report)) parts.push("", "## Laporan", report);
  const docs = listDocs(other.id);
  if (docs.length > 0) parts.push("", "## Lampiran", ...docs.slice(0, 40).map((doc) => `- ${doc.path}`));
  return { text: parts.join("\n") };
}

/**
 * Tool `remember`: catatan masuk kotak masuk project. Kurator yang menggabungkannya ke
 * memory.md (membuang duplikat dan fakta basi); sampai saat itu ia tetap ikut konteks.
 */
export function rememberFor(taskId: string, note: string): { project?: string } {
  const task = getTask(taskId);
  const project = task ? getProject(task.projectId) : undefined;
  if (!project) return {};
  appendInbox(project.id, taskId, note);
  return { project: project.name };
}

/** Tool `findings_list`: register temuan project tugas itu. */
export function findingsListFor(taskId: string, status?: FindingStatus | "all"): ToolAnswer {
  const project = projectOfTask(taskId);
  if (!project) return { text: "ERROR: tugas ini belum punya project", isError: true };
  const all = readRegister(project.id).findings;
  const list = all.filter((finding) =>
    status === "all" ? true : status ? finding.status === status : OPEN_STATUSES.includes(finding.status),
  );
  if (list.length === 0) return { text: `Tidak ada temuan${status ? ` berstatus ${status}` : " terbuka"} (${all.length} total di register).` };
  const lines = list.map((finding) => {
    const tasks = [...new Set(finding.occurrences.map((item) => item.taskId))].join(", ");
    return `- ${finding.id} · ${finding.severity} · ${finding.status} · ${finding.title}${finding.area ? ` · ${finding.area}` : ""}${tasks ? ` · dilaporkan: ${tasks}` : ""}${finding.mergedInto ? ` · duplikat dari ${finding.mergedInto}` : ""}`;
  });
  return { text: `${list.length} temuan:\n${lines.join("\n")}\n\nDetail: finding_detail(id).` };
}

/** Tool `finding_detail`: satu temuan beserta jejaknya di laporan tugas. */
export function findingDetailFor(taskId: string, id: string): ToolAnswer {
  const project = projectOfTask(taskId);
  if (!project) return { text: "ERROR: tugas ini belum punya project", isError: true };
  const finding = getFinding(project.id, id);
  if (!finding) return { text: `ERROR: ${id} tidak ada di register project ini`, isError: true };
  const parts = [
    `# ${finding.id} — ${finding.title}`,
    `severity: ${finding.severity} · status: ${finding.status}${finding.area ? ` · area: ${finding.area}` : ""}${finding.mergedInto ? ` · duplikat dari ${finding.mergedInto}` : ""}`,
  ];
  if (finding.summary) parts.push("", finding.summary);
  if (finding.resolution) parts.push("", `Penutupan (${finding.resolution.by}, ${finding.resolution.at.slice(0, 10)}): ${finding.resolution.note}`);
  if (finding.occurrences.length > 0) {
    parts.push("", "## Kemunculan");
    for (const item of finding.occurrences) {
      const report = existsSync(reportPath(item.taskId)) ? ` — laporan: ${reportPath(item.taskId)}` : "";
      parts.push(`- ${item.taskId}${item.localId ? ` ${item.localId}` : ""} (${item.at.slice(0, 10)})${item.note ? `: ${item.note}` : ""}${report}`);
    }
  }
  return { text: parts.join("\n") };
}

/** Potongan transcript yang dikirim ke panel Tanya: cukup untuk paham, tidak sampai membengkak. */
const ASK_EVENTS = 40;
const ASK_CHARS = 40_000;

function renderThread(taskId: string): string {
  const events = threads.read(taskId).slice(-ASK_EVENTS);
  const lines: string[] = [];
  for (const event of events) {
    const who = event.role ? ROLES[event.role].title : "bot";
    if (event.type === "user") lines.push(`[${event.from === "system" ? "sistem" : "pemilik produk"}] ${oneLine(event.text, 600)}`);
    else if (event.type === "assistant") lines.push(`[${who}] ${oneLine(event.text, 900)}`);
    else if (event.type === "tool") lines.push(`[${who} · tool] ${event.name} ${oneLine(JSON.stringify(event.input ?? {}), 200)}`);
    else if (event.type === "tool_result") lines.push(`[hasil tool]${event.isError ? " ERROR" : ""} ${oneLine(event.preview, 300)}`);
    else if (event.type === "handoff") lines.push(`[operan] ${event.from} → ${event.to}${event.note ? ` — ${oneLine(event.note, 200)}` : ""}`);
    else if (event.type === "error") lines.push(`[error] ${oneLine(event.message, 300)}`);
  }
  const text = lines.join("\n");
  return text.length > ASK_CHARS ? `…(dipotong)\n${text.slice(-ASK_CHARS)}` : text;
}

/**
 * System prompt panel Tanya (incognito): asisten tanya-jawab untuk pemilik produk.
 * Ia melihat tugas ini seutuhnya, tapi tidak pernah menulis apa pun ke tugas itu.
 */
export function askContext(taskId: string, history: Array<{ role: "user" | "assistant"; text: string }> = []): string {
  const task = getTask(taskId);
  if (!task) return "";
  const parts = [
    "Anda asisten tanya-jawab pribadi untuk pemilik produk, menempel pada satu tugas di aplikasi AI Team.",
    "",
    "Aturan Anda:",
    "- Jawab ringkas dan langsung, dalam Bahasa Indonesia. Pertanyaannya biasanya pendek; jawabannya juga boleh pendek.",
    "- Jangan mengarang. Kalau jawabannya ada di berkas, buka berkasnya dengan tool Read/Grep/Glob.",
    "- Anda TIDAK mengerjakan tugas ini: tidak mengubah berkas, tidak menjalankan perintah, tidak mengirim pesan ke bot yang mengerjakannya.",
    "- Percakapan ini tidak terlihat oleh bot mana pun dan tidak tersimpan di riwayat tugas.",
    "",
    `# Tugas ${task.id} — ${task.title}`,
    `bot: ${ROLES[task.role].title} · status: ${STATUS_LABEL[task.status]}${task.targetUrl ? ` · target: ${task.targetUrl}` : ""}`,
    "",
    "## Instruksi asli",
    task.description || "(kosong)",
  ];

  const summaries = task.assignments.filter((assignment) => assignment.summary?.trim());
  if (summaries.length > 0) {
    parts.push("", "## Ringkasan serah terima");
    for (const assignment of summaries) parts.push(`### ${ROLES[assignment.role].title}`, assignment.summary!.trim());
  }

  const thread = renderThread(taskId);
  if (thread) parts.push("", `## Percakapan tugas (${ASK_EVENTS} kejadian terakhir)`, thread);

  parts.push(
    "",
    "## Berkas yang boleh Anda buka sendiri",
    `- transcript penuh: ${join(taskDir(taskId), "thread.jsonl")}`,
    `- laporan: ${reportPath(taskId)}`,
    `- folder tugas (bukti & lampiran): ${taskDir(taskId)}`,
    `- workspace project: ${workspaceForTask(taskId)}`,
    "(Catatan pribadi pemilik produk di notes.md sengaja tidak boleh Anda baca.)",
  );

  const projectContext = contextBlock(taskId);
  if (projectContext) parts.push(projectContext.trim());

  if (history.length > 0) {
    parts.push("", "## Tanya-jawab sebelumnya di panel ini");
    for (const message of history) {
      parts.push(`${message.role === "user" ? "Pemilik produk" : "Anda"}: ${oneLine(message.text, 1200)}`);
    }
  }

  return parts.join("\n");
}

/** Tugas dari versi sebelum fitur project diberi induk bawaan supaya tidak pernah yatim. */
export function adoptOrphanTasks(): number {
  const pending = orphanTasks();
  if (pending.length === 0) return 0;
  const projectId = defaultProjectId();
  for (const task of pending) updateTask(task.id, { projectId });
  return pending.length;
}
