/**
 * Register temuan per project: satu sumber kebenaran lintas tugas.
 *
 * Laporan tiap tugas tetap milik tugas itu; register inilah yang menyatukannya —
 * satu temuan punya satu id `F-nnn` yang stabil, tahu laporan mana saja yang
 * menyebutnya, dan statusnya (open/fixed/…) dijaga kurator. Semua berkas tinggal di
 * folder project dan ditulis atomik, sama seperti context.md dan memory.md.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notifyProject } from "./changes.ts";
import { isDeleted } from "./deleted-tasks.ts";
import { projectDir } from "./projects.ts";
import type { RecapEntry, RecapSeverity } from "./recap.ts";
import { ACTIVE_STATUSES, reportPath, tasksInProject } from "./tasks.ts";

export type FindingSeverity = "blocker" | "major" | "minor";
export type FindingStatus = "open" | "needs_retest" | "fixed" | "wontfix" | "invalid";

export const FINDING_SEVERITIES: FindingSeverity[] = ["blocker", "major", "minor"];
export const FINDING_STATUSES: FindingStatus[] = ["open", "needs_retest", "fixed", "wontfix", "invalid"];
/** Status yang masih menuntut tindakan — inilah yang menentukan kesimpulan project. */
export const OPEN_STATUSES: FindingStatus[] = ["open", "needs_retest"];

export type FindingOccurrence = {
  taskId: string;
  /** Nomor temuan di laporan tugas itu ("T-3"), kalau ada. */
  localId?: string;
  at: string;
  note?: string;
};

export type FindingResolution = {
  /** Id tugas, hash commit, atau "owner". */
  by: string;
  note: string;
  at: string;
};

export type FindingFix = {
  /** Hash commit, atau id tugas kalau belum di-commit. */
  by: string;
  taskId: string;
  note: string;
  at: string;
};

export type FindingRetest = {
  taskId: string;
  passed: boolean;
  note: string;
  evidence: string;
  at: string;
};

export type Finding = {
  id: string;
  title: string;
  area?: string;
  severity: FindingSeverity;
  status: FindingStatus;
  summary?: string;
  occurrences: FindingOccurrence[];
  resolution?: FindingResolution;
  /** Id temuan lain kalau item ini digabung ke sana (status jadi invalid). */
  mergedInto?: string;
  /** Laporan perbaikan terakhir dari Engineer/DevOps; belum berarti terbukti. */
  fix?: FindingFix;
  /** Hasil uji ulang QA terakhir. */
  retest?: FindingRetest;
  /** Diisi saat uji ulang membuktikan perbaikan gagal; dihapus lagi saat uji ulang berikutnya lolos. */
  reopenedAt?: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
};

export type CoverageState = "tested" | "partial" | "blocked" | "untested";
export const COVERAGE_STATES: CoverageState[] = ["tested", "partial", "blocked", "untested"];

export type CoverageCell = {
  area: string;
  /** Persona/akun/lingkungan yang dipakai menguji area itu, mis. "kadiv" atau "1300". */
  subject: string;
  state: CoverageState;
  taskId?: string;
  note?: string;
  updatedAt: string;
};

export type Register = { nextId: number; findings: Finding[] };

export type CurationState = {
  /** Sidik isi (mtime report.md + hash ringkasan) tiap tugas yang sudah dikurasi — dasar "apa yang baru". */
  curatedAt: Record<string, string>;
  lastRunAt?: string;
  lastError?: string;
  costUsd: number;
  runs: number;
};

export type LogEntry = {
  at: string;
  by: string;
  action: string;
  target?: string;
  detail: string;
  /** Isi sebelum perubahan — cukup untuk membatalkannya. */
  before?: unknown;
};

export type InboxNote = { at: string; taskId: string; note: string };

const STATE_MAX = 6_000;

// ---------- path & io ----------

const file = (projectId: string, name: string): string => join(projectDir(projectId), name);

function writeAtomic(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Berkas yang tidak ada = kosong. Berkas yang ADA tapi rusak dilempar sebagai error:
 * kalau dikembalikan fallback, penulisan berikutnya menimpa register dengan yang kosong.
 */
function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`${path} rusak (${(error as Error).message}) — perbaiki atau pindahkan berkasnya dulu`);
  }
}

/** Log kurasi hanya bertambah; parse-nya di-cache berkunci mtime+size supaya polling 4 detik tidak mengurai 190 KB berulang. */
const linesCache = new Map<string, { key: string; rows: unknown[] }>();

function readLines<T>(path: string): T[] {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    linesCache.delete(path);
    return [];
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = linesCache.get(path);
  if (cached && cached.key === key) return [...cached.rows] as T[];
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
  linesCache.set(path, { key, rows });
  return [...rows] as T[];
}

const now = (): string => new Date().toISOString();

// ---------- register ----------

export function readRegister(projectId: string): Register {
  return readJson<Register>(file(projectId, "findings.json"), { nextId: 1, findings: [] });
}

function writeRegister(projectId: string, register: Register): void {
  writeAtomic(file(projectId, "findings.json"), JSON.stringify(register, null, 2));
  notifyProject(projectId);
}

export function getFinding(projectId: string, id: string): Finding | undefined {
  return readRegister(projectId).findings.find((finding) => finding.id === id.trim().toUpperCase());
}

export type UpsertInput = {
  id?: string;
  title?: string;
  area?: string;
  severity?: FindingSeverity;
  summary?: string;
  occurrence?: Omit<FindingOccurrence, "at"> & { at?: string };
};

/**
 * Tambah temuan baru (tanpa id) atau tautkan kemunculan baru ke temuan yang ada (dengan id).
 * Kemunculan dari tugas yang sama tidak digandakan: yang lama diganti.
 */
export function upsertFinding(projectId: string, input: UpsertInput, by: string): Finding {
  const register = readRegister(projectId);
  const stamp = now();
  const occurrence = input.occurrence ? { ...input.occurrence, at: input.occurrence.at ?? stamp } : undefined;

  if (input.id) {
    const index = register.findings.findIndex((finding) => finding.id === input.id!.trim().toUpperCase());
    if (index < 0) throw new Error(`temuan ${input.id} tidak ada di register`);
    const before = register.findings[index]!;
    const occurrences = occurrence
      ? [...before.occurrences.filter((item) => item.taskId !== occurrence.taskId), occurrence]
      : before.occurrences;
    const next: Finding = {
      ...before,
      title: input.title?.trim() || before.title,
      area: input.area?.trim() || before.area,
      severity: input.severity ?? before.severity,
      summary: input.summary?.trim() || before.summary,
      occurrences,
      updatedAt: stamp,
    };
    register.findings[index] = next;
    writeRegister(projectId, register);
    appendLog(projectId, { by, action: "update", target: next.id, detail: occurrence ? `kemunculan ${occurrence.taskId}${occurrence.localId ? ` ${occurrence.localId}` : ""}` : "data diperbarui", before });
    return next;
  }

  if (!input.title?.trim()) throw new Error("judul wajib diisi untuk temuan baru");
  const finding: Finding = {
    id: `F-${String(register.nextId).padStart(3, "0")}`,
    title: input.title.trim(),
    area: input.area?.trim() || undefined,
    severity: input.severity ?? "minor",
    status: "open",
    summary: input.summary?.trim() || undefined,
    occurrences: occurrence ? [occurrence] : [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  register.nextId += 1;
  register.findings.push(finding);
  writeRegister(projectId, register);
  appendLog(projectId, { by, action: "create", target: finding.id, detail: finding.title });
  return finding;
}

/** Status selain open/needs_retest wajib membawa alasan atau bukti — "fixed" tanpa bukti ditolak. */
export function setFindingStatus(
  projectId: string,
  id: string,
  status: FindingStatus,
  resolution: { by: string; note: string } | undefined,
  actor: string,
  options: { verified?: boolean; mergedInto?: string } = {},
): Finding {
  const register = readRegister(projectId);
  const index = register.findings.findIndex((finding) => finding.id === id.trim().toUpperCase());
  if (index < 0) throw new Error(`temuan ${id} tidak ada di register`);
  if (!OPEN_STATUSES.includes(status) && !resolution?.note.trim()) {
    throw new Error(`status ${status} wajib disertai bukti/alasan`);
  }
  const before = register.findings[index]!;
  const stamp = now();
  const next: Finding = {
    ...before,
    status,
    resolution: OPEN_STATUSES.includes(status) ? before.resolution : { ...resolution!, at: stamp },
    mergedInto: options.mergedInto ?? (status === "invalid" ? before.mergedInto : undefined),
    lastVerifiedAt: options.verified ? stamp : before.lastVerifiedAt,
    updatedAt: stamp,
  };
  register.findings[index] = next;
  writeRegister(projectId, register);
  appendLog(projectId, {
    by: actor,
    action: "status",
    target: next.id,
    detail: `${before.status} → ${status}${resolution?.note ? ` — ${resolution.note}` : ""}`,
    before,
  });
  return next;
}

function findingToChange(register: Register, id: string): { index: number; finding: Finding } {
  const index = register.findings.findIndex((finding) => finding.id === id.trim().toUpperCase());
  const finding = register.findings[index];
  if (!finding) throw new Error(`temuan ${id} tidak ada di register`);
  if (finding.mergedInto) throw new Error(`${finding.id} sudah digabung ke ${finding.mergedInto}; pakai id itu`);
  return { index, finding };
}

/** Engineer/DevOps melapor sudah memperbaiki: temuan menunggu uji ulang QA, belum dianggap selesai. */
export function reportFixed(projectId: string, id: string, input: { taskId: string; note: string; commit?: string }): Finding {
  const note = input.note.trim();
  if (!note) throw new Error("catatan perbaikan wajib diisi");
  const register = readRegister(projectId);
  const { index, finding: before } = findingToChange(register, id);
  if (!OPEN_STATUSES.includes(before.status)) {
    throw new Error(`${before.id} berstatus ${before.status}; temuan yang sudah ditutup tidak bisa dilaporkan diperbaiki`);
  }
  const stamp = now();
  const next: Finding = {
    ...before,
    status: "needs_retest",
    fix: { by: input.commit?.trim() || input.taskId, taskId: input.taskId, note, at: stamp },
    updatedAt: stamp,
  };
  register.findings[index] = next;
  writeRegister(projectId, register);
  appendLog(projectId, { by: input.taskId, action: "status", target: next.id, detail: `${before.status} → needs_retest — ${note}`, before });
  return next;
}

/**
 * Hasil uji ulang QA. Lolos menutup temuan sebagai terverifikasi. Gagal membuka lagi temuan yang
 * sudah dilaporkan diperbaiki dan menandainya regresi; temuan yang memang masih terbuka tetap terbuka.
 */
export function recordRetest(
  projectId: string,
  id: string,
  input: { taskId: string; passed: boolean; note: string; evidence: string },
): Finding {
  const note = input.note.trim();
  const evidence = input.evidence.trim();
  if (!note || !evidence) throw new Error("catatan dan bukti uji ulang wajib diisi");
  const register = readRegister(projectId);
  const { index, finding: before } = findingToChange(register, id);
  if (before.status === "wontfix" || before.status === "invalid") {
    throw new Error(`${before.id} berstatus ${before.status}; temuan ini tidak perlu diuji ulang`);
  }
  const stamp = now();
  const retest: FindingRetest = { taskId: input.taskId, passed: input.passed, note, evidence, at: stamp };
  const next: Finding = input.passed
    ? {
        ...before,
        status: "fixed",
        retest,
        resolution: { by: input.taskId, note: `${note} (bukti: ${evidence})`, at: stamp },
        lastVerifiedAt: stamp,
        reopenedAt: undefined,
        updatedAt: stamp,
      }
    : {
        ...before,
        status: "open",
        retest,
        reopenedAt: before.status === "open" ? before.reopenedAt : stamp,
        updatedAt: stamp,
      };
  register.findings[index] = next;
  writeRegister(projectId, register);
  appendLog(projectId, {
    by: input.taskId,
    action: "status",
    target: next.id,
    detail: `${before.status} → ${next.status} — uji ulang ${input.passed ? "lolos" : "gagal"}: ${note}`,
    before,
  });
  return next;
}

/** Gabungkan duplikat: kemunculan pindah ke induk, item duplikat ditandai invalid. */
export function mergeFinding(projectId: string, duplicateId: string, intoId: string, actor: string): Finding {
  const register = readRegister(projectId);
  const duplicate = register.findings.find((finding) => finding.id === duplicateId.trim().toUpperCase());
  const target = register.findings.find((finding) => finding.id === intoId.trim().toUpperCase());
  if (!duplicate || !target) throw new Error("temuan yang digabung tidak ditemukan");
  if (duplicate.id === target.id) throw new Error("tidak bisa menggabung temuan dengan dirinya sendiri");
  const before = { duplicate: { ...duplicate }, target: { ...target } };
  const stamp = now();
  const seen = new Set(target.occurrences.map((item) => item.taskId));
  target.occurrences = [...target.occurrences, ...duplicate.occurrences.filter((item) => !seen.has(item.taskId))];
  target.updatedAt = stamp;
  duplicate.status = "invalid";
  duplicate.mergedInto = target.id;
  duplicate.resolution = { by: actor, note: `duplikat dari ${target.id}`, at: stamp };
  duplicate.updatedAt = stamp;
  writeRegister(projectId, register);
  appendLog(projectId, { by: actor, action: "merge", target: duplicate.id, detail: `digabung ke ${target.id}`, before });
  return target;
}

// ---------- cakupan ----------

export function readCoverage(projectId: string): CoverageCell[] {
  return readJson<CoverageCell[]>(file(projectId, "coverage.json"), []);
}

export function setCoverage(projectId: string, cell: Omit<CoverageCell, "updatedAt">, by: string): CoverageCell {
  const cells = readCoverage(projectId);
  const area = cell.area.trim();
  const subject = cell.subject.trim();
  const next: CoverageCell = { ...cell, area, subject, updatedAt: now() };
  const index = cells.findIndex((item) => item.area === area && item.subject === subject);
  const before = index >= 0 ? cells[index] : undefined;
  if (index >= 0) cells[index] = next;
  else cells.push(next);
  writeAtomic(file(projectId, "coverage.json"), JSON.stringify(cells, null, 2));
  appendLog(projectId, { by, action: "coverage", target: `${area} × ${subject}`, detail: next.state, before });
  return next;
}

// ---------- kesimpulan project ----------

export function readState(projectId: string): string {
  const path = file(projectId, "state.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function writeState(projectId: string, text: string, by: string): string {
  const body = text.trim();
  const trimmed = body.length > STATE_MAX ? `${body.slice(0, STATE_MAX)}\n…(dipotong)` : body;
  const before = readState(projectId);
  writeAtomic(file(projectId, "state.md"), `${trimmed}\n`);
  appendLog(projectId, { by, action: "state", detail: "kesimpulan project ditulis ulang", before });
  return trimmed;
}

// ---------- log kurasi ----------

export function appendLog(projectId: string, entry: Omit<LogEntry, "at">): void {
  mkdirSync(projectDir(projectId), { recursive: true });
  appendFileSync(file(projectId, "curation-log.jsonl"), `${JSON.stringify({ at: now(), ...entry })}\n`);
  // Cakupan, kesimpulan, dan pembatalan selalu diikuti entri log — cukup diberi tahu di sini.
  notifyProject(projectId);
}

export function readLog(projectId: string, limit = 50): LogEntry[] {
  return readLines<LogEntry>(file(projectId, "curation-log.jsonl")).slice(-limit).reverse();
}

const REVERTIBLE = ["update", "status", "merge", "coverage", "state", "memory"];

export function canRevert(entry: LogEntry): boolean {
  return REVERTIBLE.includes(entry.action) && entry.before !== undefined;
}

/**
 * Batalkan satu perubahan dari log: isi `before` dikembalikan apa adanya.
 * Pembatalan sendiri juga tercatat, jadi bisa dibatalkan lagi.
 */
export function revertLog(
  projectId: string,
  at: string,
  actor: string,
  writeMemory: (text: string) => void,
  readMemoryText: () => string,
  match?: { action?: string; target?: string },
): string {
  // Stempel waktu milidetik bisa kembar; action+target (kalau dikirim) memastikan entri yang tepat.
  const entry = readLines<LogEntry>(file(projectId, "curation-log.jsonl")).find(
    (item) =>
      item.at === at &&
      (match?.action === undefined || item.action === match.action) &&
      (match?.target === undefined || (item.target ?? "") === match.target),
  );
  if (!entry || !canRevert(entry)) throw new Error("perubahan itu tidak bisa dibatalkan");
  const register = readRegister(projectId);
  const replace = (finding: Finding): Finding | undefined => {
    const index = register.findings.findIndex((item) => item.id === finding.id);
    const current = index >= 0 ? register.findings[index] : undefined;
    if (index >= 0) register.findings[index] = finding;
    return current;
  };

  if (entry.action === "update" || entry.action === "status") {
    const current = replace(entry.before as Finding);
    writeRegister(projectId, register);
    appendLog(projectId, { by: actor, action: "status", target: entry.target, detail: `dibatalkan: ${entry.detail}`, before: current });
  } else if (entry.action === "merge") {
    const before = entry.before as { duplicate: Finding; target: Finding };
    replace(before.duplicate);
    replace(before.target);
    writeRegister(projectId, register);
    appendLog(projectId, { by: actor, action: "revert", target: entry.target, detail: `penggabungan dibatalkan: ${entry.detail}` });
  } else if (entry.action === "coverage") {
    const before = entry.before as CoverageCell | undefined;
    const [area, subject] = (entry.target ?? "").split(" × ");
    const cells = readCoverage(projectId).filter((cell) => !(cell.area === area && cell.subject === subject));
    if (before) cells.push(before);
    writeAtomic(file(projectId, "coverage.json"), JSON.stringify(cells, null, 2));
    appendLog(projectId, { by: actor, action: "revert", target: entry.target, detail: "cakupan dikembalikan" });
  } else if (entry.action === "state") {
    const current = readState(projectId);
    writeAtomic(file(projectId, "state.md"), String(entry.before));
    appendLog(projectId, { by: actor, action: "state", detail: "kesimpulan dikembalikan ke versi sebelumnya", before: current });
  } else if (entry.action === "memory") {
    const current = readMemoryText();
    writeMemory(String(entry.before));
    appendLog(projectId, { by: actor, action: "memory", detail: "memori dikembalikan ke versi sebelumnya", before: current });
  }
  return entry.detail;
}

// ---------- kotak masuk memori ----------

/** `remember` menulis ke sini; kurator yang memutuskan masuk ke memory.md atau tidak. */
export function appendInbox(projectId: string, taskId: string, note: string): InboxNote {
  const item = { at: now(), taskId, note: note.replace(/\s+/g, " ").trim() };
  mkdirSync(projectDir(projectId), { recursive: true });
  appendFileSync(file(projectId, "memory-inbox.jsonl"), `${JSON.stringify(item)}\n`);
  notifyProject(projectId);
  return item;
}

export function readInbox(projectId: string): InboxNote[] {
  return readLines<InboxNote>(file(projectId, "memory-inbox.jsonl"));
}

/** Buang catatan yang sudah diolah; yang masuk saat kurasi berjalan tetap tinggal. */
export function dropInbox(projectId: string, upTo: string): void {
  const rest = readInbox(projectId).filter((item) => item.at > upTo);
  writeAtomic(file(projectId, "memory-inbox.jsonl"), rest.map((item) => JSON.stringify(item)).join("\n") + (rest.length ? "\n" : ""));
  notifyProject(projectId);
}

// ---------- status kurasi ----------

export function readCuration(projectId: string): CurationState {
  return readJson<CurationState>(file(projectId, "curation.json"), { curatedAt: {}, costUsd: 0, runs: 0 });
}

export function writeCuration(projectId: string, state: CurationState): void {
  writeAtomic(file(projectId, "curation.json"), JSON.stringify(state, null, 2));
  notifyProject(projectId);
}

export type PendingSource = {
  taskId: string;
  title: string;
  role: string;
  source: "report" | "summary";
  /** Waktu isi terakhir berubah (mtime report.md, atau akhir penugasan terakhir). */
  changedAt: string;
  /** Sidik isi; dicatat ke curation.json setelah dikurasi. */
  fingerprint: string;
  path?: string;
};

/**
 * Sidik dihitung dari isi, bukan dari task.updatedAt: approve, ganti judul, atau
 * tambah biaya ikut menggeser updatedAt dan tidak boleh memicu kurasi ulang.
 */
function fingerprintOf(reportAt: string, summaries: string): string {
  return `${reportAt}|${createHash("sha1").update(summaries).digest("hex").slice(0, 12)}`;
}

/** Laporan/ringkasan yang berubah sejak terakhir dikurasi — bahan kerja kurator berikutnya. */
export function pendingSources(projectId: string): PendingSource[] {
  const curated = readCuration(projectId).curatedAt;
  const pending: PendingSource[] = [];
  for (const task of tasksInProject(projectId)) {
    // Tugas yang masih dipegang agen (termasuk yang berhenti menunggu persetujuan) belum punya laporan final.
    if (task.status === "cancelled" || ACTIVE_STATUSES.includes(task.status)) continue;
    const path = reportPath(task.id);
    const hasReport = existsSync(path);
    const summaries = task.assignments.map((assignment) => assignment.summary?.trim() ?? "").join("\n---\n");
    if (!hasReport && !summaries.replace(/[-\s]/g, "")) continue;
    const reportAt = hasReport ? statSync(path).mtime.toISOString() : "";
    const fingerprint = fingerprintOf(reportAt, summaries);
    if (curated[task.id] === fingerprint) continue;
    const lastEnded = task.assignments.map((assignment) => assignment.endedAt ?? "").sort().pop() || task.updatedAt;
    pending.push({
      taskId: task.id,
      title: task.title,
      role: task.role,
      source: hasReport ? "report" : "summary",
      changedAt: reportAt > lastEnded ? reportAt : lastEnded,
      fingerprint,
      path: hasReport ? path : undefined,
    });
  }
  return pending.sort((a, b) => a.changedAt.localeCompare(b.changedAt));
}

/**
 * Tugas yang sudah menulis laporan/ringkasan tetapi masih dipegang agen. pendingSources
 * sengaja melewatinya, jadi UI perlu tahu supaya "0 belum dikurasi" tidak terbaca sudah sync.
 */
export function inProgressSources(projectId: string): string[] {
  return tasksInProject(projectId)
    .filter(
      (task) =>
        ACTIVE_STATUSES.includes(task.status) &&
        (existsSync(reportPath(task.id)) || task.assignments.some((assignment) => assignment.summary?.trim())),
    )
    .map((task) => task.id)
    .sort();
}

export type UnlinkedFinding = { taskId: string; id: string; title: string; severity: RecapSeverity };

/**
 * Temuan bernomor di laporan yang sudah dikurasi, tetapi tidak tertaut ke register.
 * Kurator boleh melewatkannya, namun alasannya tidak tercatat, jadi pemilik produk yang menilai.
 * Temuan tanpa nomor tidak dihitung karena biasanya catatan non-temuan.
 */
export function unlinkedFindings(projectId: string, register: Register, entries: RecapEntry[]): UnlinkedFinding[] {
  const { curatedAt } = readCuration(projectId);
  const pending = new Set(pendingSources(projectId).map((source) => source.taskId));
  const ids = new Set(register.findings.map((finding) => finding.id));
  const linked = new Set(
    register.findings.flatMap((finding) =>
      finding.occurrences.map((item) => `${item.taskId}\u0000${item.localId?.toUpperCase() ?? ""}`),
    ),
  );
  return entries
    .filter((entry) => curatedAt[entry.taskId] && !pending.has(entry.taskId))
    .flatMap((entry) =>
      entry.findings.flatMap((finding) =>
        finding.id && !linked.has(`${entry.taskId}\u0000${finding.id}`) && !(finding.ref && ids.has(finding.ref))
          ? [{ taskId: entry.taskId, id: finding.id, title: finding.title, severity: finding.severity }]
          : [],
      ),
    );
}

/** Semua ID tugas yang dirujuk register dan cakupan — dasar label "dihapus" di report project. */
export function referencedTaskIds(register: Register, coverage: CoverageCell[]): Set<string> {
  const ids = new Set<string>();
  for (const finding of register.findings) {
    for (const item of finding.occurrences) ids.add(item.taskId);
    if (finding.fix) ids.add(finding.fix.taskId);
    if (finding.retest) ids.add(finding.retest.taskId);
  }
  for (const cell of coverage) if (cell.taskId) ids.add(cell.taskId);
  return ids;
}

// ---------- ringkasan untuk konteks agen ----------

const FIXED_RECENT_MS = 14 * 24 * 60 * 60 * 1000;

function line(finding: Finding): string {
  // Tugas yang dihapus diberi tanda supaya agen tidak mencoba membuka foldernya.
  const tasks = [...new Set(finding.occurrences.map((item) => item.taskId))]
    .slice(-4)
    .map((id) => (isDeleted(id) ? `${id} (dihapus)` : id))
    .join(",");
  const resolved = finding.resolution && !OPEN_STATUSES.includes(finding.status) ? ` — ${finding.resolution.note.slice(0, 120)}` : "";
  return `- ${finding.id} · ${finding.severity} · ${finding.status} · ${finding.title}${finding.area ? ` · ${finding.area}` : ""}${tasks ? ` · ${tasks}` : ""}${resolved}`;
}

/** Blok register untuk system prompt: semua yang masih terbuka, plus yang baru saja ditutup. */
export function registerDigest(projectId: string): string {
  const { findings } = readRegister(projectId);
  if (findings.length === 0) return "";
  const cutoff = Date.now() - FIXED_RECENT_MS;
  const open = findings.filter((finding) => OPEN_STATUSES.includes(finding.status));
  const closed = findings.filter(
    (finding) => !OPEN_STATUSES.includes(finding.status) && !finding.mergedInto && Date.parse(finding.updatedAt) >= cutoff,
  );
  const rank = (finding: Finding): number => FINDING_SEVERITIES.indexOf(finding.severity);
  const parts = [`${open.length} terbuka, ${closed.length} ditutup dalam 14 hari terakhir, ${findings.length} total.`];
  if (open.length > 0) parts.push("Terbuka:", ...open.sort((a, b) => rank(a) - rank(b)).map(line));
  if (closed.length > 0) parts.push("Baru ditutup (jangan dilaporkan ulang kecuali muncul lagi — itu regresi):", ...closed.map(line));
  return parts.join("\n");
}

export function counts(
  projectId: string,
  register: Register = readRegister(projectId),
): Record<FindingStatus, number> & Record<FindingSeverity, number> {
  const { findings } = register;
  const result = Object.fromEntries([...FINDING_STATUSES, ...FINDING_SEVERITIES].map((key) => [key, 0])) as Record<
    FindingStatus | FindingSeverity,
    number
  >;
  for (const finding of findings) {
    if (finding.mergedInto) continue;
    result[finding.status] += 1;
    if (OPEN_STATUSES.includes(finding.status)) result[finding.severity] += 1;
  }
  return result;
}
