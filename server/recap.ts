/**
 * Rekap satu project: hasil panen dari laporan tiap tugas, tanpa memanggil agen.
 *
 * Tiap peran punya template report.md sendiri (server/prompts/*.md) yang sama-sama
 * memuat "**Hasil:**" dan heading "## Ringkasan", jadi isinya bisa disalin apa adanya,
 * bukan ditafsirkan. Satu tugas memakai satu report.md: peran kedua dan seterusnya
 * MENAMBAH bagian di bawah, sehingga satu berkas bisa memuat beberapa kesimpulan.
 * Karena itu verdict dan ringkasan dipanen dari bagian TERAKHIR — baris rekap harus
 * menunjukkan keadaan sekarang, bukan kesimpulan peran pertama yang mungkin sudah usang.
 * Temuan tetap dikumpulkan dari SEMUA bagian "## Temuan".
 */
import { statSync } from "node:fs";
import { lastSummary } from "./context.ts";
import { deletedInProject } from "./deleted-tasks.ts";
import { listAssets, readReport, reportPath, tasksInProject, type TaskStatus } from "./tasks.ts";
import type { RoleId } from "./types.ts";

export type RecapSeverity = "blocker" | "major" | "minor" | "lain";
/** Nada verdict: tiap peran memakai katanya sendiri, UI hanya perlu tahu baik/catatan/buruk. */
export type RecapTone = "good" | "warn" | "bad";
export type RecapVerdict = { text: string; tone: RecapTone };

export type RecapFinding = {
  /** Nomor temuan seperti yang ditulis laporan ("T-1"), bukan id tugas. */
  id?: string;
  title: string;
  severity: RecapSeverity;
  /** Keterangan yang menempel di severity, mis. "bawaan, identik" dari "· minor (bawaan, identik)". */
  note?: string;
  /** Item register yang dirujuk laporan ("· ref F-012"). */
  ref?: string;
};

export type RecapEntry = {
  taskId: string;
  title: string;
  role: RoleId;
  status: TaskStatus;
  /** report = dipanen dari report.md; summary = dari ringkasan serah terima. */
  source: "report" | "summary";
  verdict?: RecapVerdict;
  summary?: string;
  findings: RecapFinding[];
  assetCount: number;
  costUsd: number;
  updatedAt: string;
  finishedAt?: string;
  /** mtime report.md, atau updatedAt untuk sumber ringkasan — dasar penanda "berubah". */
  changedAt: string;
};

export type RecapTotals = {
  reports: number;
  summaries: number;
  good: number;
  warn: number;
  bad: number;
  blocker: number;
  major: number;
  minor: number;
  other: number;
  costUsd: number;
};

/** Baris rekap tugas yang sudah dihapus: snapshot terakhirnya, tanpa laporan yang bisa dibuka. */
export type DeletedRecapEntry = RecapEntry & { deletedAt: string };

export type ProjectRecap = {
  projectId: string;
  generatedAt: string;
  entries: RecapEntry[];
  /**
   * Tugas project ini yang sudah dihapus, terbaru dulu. Sengaja terpisah dari `entries`:
   * totals, emptyCount, dan temuan yang belum tertaut hanya menghitung tugas yang masih ada.
   */
  deleted: DeletedRecapEntry[];
  /** Tugas yang belum punya laporan maupun ringkasan — tidak jadi baris, hanya dihitung. */
  emptyCount: number;
  totals: RecapTotals;
};

/** Payload rekap harus tetap ringan: laporan penuh diambil terpisah saat barisnya dibentang. */
const SUMMARY_MAX = 1_200;
const FINDINGS_MAX = 50;

function clip(text: string, max: number): string {
  const body = text.trim();
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

/**
 * Isi satu bagian markdown, sampai heading setingkat atau lebih tinggi.
 * Nama heading wajib habis di akhir baris, kalau tidak "## Ringkasan serah terima"
 * ikut tertangkap saat yang dicari "## Ringkasan".
 */
function sections(text: string, heading: string): string[] {
  const starts = new RegExp(`^(#{2,6})[ \\t]*${heading}[ \\t]*$`, "gim");
  const bodies: string[] = [];
  for (const start of text.matchAll(starts)) {
    const level = start[1]?.length ?? 2;
    const rest = text.slice((start.index ?? 0) + start[0].length);
    // Sub-heading di dalam bagian ini (mis. "### T-1") tidak boleh menghentikannya — termasuk
    // kalau bagian lampiran menurunkan "Temuan" ke ### sehingga "### T-1" setingkat dengannya.
    const headings = new RegExp(`^#{1,${level}}[ \\t]+(\\S.*)$`, "gm");
    let end = rest.length;
    for (const candidate of rest.matchAll(headings)) {
      if (/^T-\d+\b/i.test(candidate[1] ?? "")) continue;
      end = candidate.index ?? rest.length;
      break;
    }
    const body = rest.slice(0, end).trim();
    if (body) bodies.push(body);
  }
  return bodies;
}

/** Bagian TERAKHIR dengan judul itu — lihat catatan "yang terakhir menang" di atas. */
function section(text: string, heading: string): string | undefined {
  const found = sections(text, heading);
  return found[found.length - 1];
}

/** Ringkasan yang berlaku: bagian "Ringkasan" terakhir. Diekspor supaya bisa diuji gate. */
export function summaryOf(text: string): string | undefined {
  return section(text, "Ringkasan");
}

function plain(text: string): string {
  return text.replace(/[*_`]/g, "").trim();
}

/**
 * Kosakata verdict semua peran. Frasa terpanjang lebih dulu:
 * "LULUS DENGAN CATATAN" juga berawalan "LULUS".
 */
const VERDICTS: RecapVerdict[] = [
  { text: "LULUS DENGAN CATATAN", tone: "warn" },
  { text: "BERHASIL DENGAN CATATAN", tone: "warn" },
  { text: "SELESAI SEBAGIAN", tone: "warn" },
  { text: "TERBLOKIR", tone: "bad" },
  { text: "GAGAL", tone: "bad" },
  { text: "BERHASIL", tone: "good" },
  { text: "SELESAI", tone: "good" },
  { text: "LULUS", tone: "good" },
];

const HASIL_RE = /^[ \t]*[-*]?[ \t]*\*\*Hasil:?\*\*[ \t]*:?[ \t]*(.+)$/gim;

/**
 * Verdict dari baris "**Hasil:**" terakhir yang memuat kata verdict. Satu report.md bisa memuat
 * beberapa bagian, dan yang berlaku adalah kesimpulan peran yang menulis paling akhir. Baris
 * "**Hasil:**" di ringkasan serah terima berisi kalimat bebas, jadi tidak boleh menghapus verdict.
 */
export function verdictOf(text: string): RecapVerdict | undefined {
  let found: RecapVerdict | undefined;
  for (const match of text.matchAll(HASIL_RE)) {
    const value = plain(match[1] ?? "").toUpperCase();
    found = VERDICTS.find((verdict) => value.startsWith(verdict.text)) ?? found;
  }
  return found;
}

/** Urai isi heading temuan, mis. "T-1 · judul · major (bawaan) · ref F-012". */
function parseFindingHead(text: string): RecapFinding {
  let ref: string | undefined;
  let refNote: string | undefined;
  const parts = text
    .split("·")
    .map(plain)
    .filter(Boolean)
    .filter((part) => {
      const match = /^ref[ \t:]*(F-\d+)(?:[ \t]*\((.*)\))?$/i.exec(part);
      if (match?.[1]) {
        ref = match[1].toUpperCase();
        refNote = match[2]?.trim() || undefined;
      }
      return !match;
    });
  // Keterangan kadang jadi bagian sendiri sesudah severity: "· minor · (kelas sama dengan F-001)".
  let afterSeverity: string | undefined;
  const last = parts[parts.length - 1] ?? "";
  if (/^\(.*\)$/.test(last) && /^(blocker|major|minor)$/i.test(parts[parts.length - 2] ?? "")) {
    afterSeverity = last.slice(1, -1).trim();
    parts.pop();
  }
  let severity: RecapSeverity = "lain";
  let note: string | undefined;
  // Severity sering diikuti keterangan: "· minor (bawaan, identik)".
  const tail = /^(blocker|major|minor)\b[ \t]*(.*)$/i.exec(parts[parts.length - 1] ?? "");
  if (tail?.[1]) {
    severity = tail[1].toLowerCase() as RecapSeverity;
    note = tail[2]?.trim().replace(/^\((.*)\)$/, "$1") || afterSeverity || refNote;
    parts.pop();
  }
  let id: string | undefined;
  if (parts.length > 1 && /^T-\d+$/i.test(parts[0] ?? "")) id = parts.shift()?.toUpperCase();
  return { id, title: parts.join(" · ") || "(tanpa judul)", severity, note, ref };
}

export function findingsOf(text: string): RecapFinding[] {
  // Semua bagian "## Temuan", bukan hanya yang pertama: satu berkas bisa memuat
  // laporan QA awal dan bagian uji ulang yang ditambahkan sesudahnya.
  const body = sections(text, "Temuan").join("\n");
  if (!body) return [];
  const findings: RecapFinding[] = [];
  for (const line of body.split("\n")) {
    const head = /^#{3,6}[ \t]+(.+?)[ \t]*$/.exec(line);
    if (!head?.[1]) continue;
    findings.push(parseFindingHead(head[1]));
    if (findings.length >= FINDINGS_MAX) break;
  }
  return findings;
}

/** Heading markdown di luar blok kode, beserta posisinya. */
function headingsOf(text: string): Array<{ level: number; title: string; start: number; end: number }> {
  const found: Array<{ level: number; title: string; start: number; end: number }> = [];
  let fence = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
    const head = fence ? null : /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line);
    if (head?.[1] && head[2]) found.push({ level: head[1].length, title: head[2], start: offset, end: offset + line.length });
    offset += line.length + 1;
  }
  return found;
}

export type ReportRound = { title: string; verdict?: RecapVerdict; body: string };

const ROUND_TITLE_RE = /^(uji ulang|perbaikan|commit perbaikan|penerapan)\b/i;
const HAS_RESULT_RE = /^[ \t]*[-*]?[ \t]*\*\*Hasil:?\*\*/im;

/**
 * Pecah report.md jadi putaran kerja (laporan awal, perbaikan, uji ulang) menurut urutan berkas.
 * Putaran baru dimulai pada heading "## " yang bagiannya punya baris "**Hasil:**" atau berjudul uji
 * ulang/perbaikan, karena judulnya bebas. "Ringkasan serah terima" tetap milik putaran sebelumnya.
 * Tidak ada teks yang dibuang: gabungan semua `body` sama dengan berkas aslinya.
 */
export function reportRounds(text: string): ReportRound[] {
  if (!text.trim()) return [];
  const headings = headingsOf(text);
  const majors = headings.filter((heading) => heading.level <= 2);
  const starts: Array<{ at: number; title?: string }> = [{ at: 0, title: headings.find((heading) => heading.level === 1)?.title }];
  // Laporan yang baris Hasil-nya baru muncul di dalam "## " pertama tetap satu putaran awal.
  let firstHasResult = HAS_RESULT_RE.test(text.slice(0, majors.find((heading) => heading.level === 2)?.start ?? text.length));
  majors.forEach((heading, index) => {
    if (heading.level !== 2) return;
    const section = text.slice(heading.end, majors[index + 1]?.start ?? text.length);
    const title = plain(heading.title);
    if (/^ringkasan serah terima\b/i.test(title)) return;
    // Bagian uji ulang atau perbaikan kadang tidak punya baris Hasil sendiri (T-017).
    if (!HAS_RESULT_RE.test(section) && !ROUND_TITLE_RE.test(title)) return;
    if (!firstHasResult) {
      firstHasResult = true;
      return;
    }
    starts.push({ at: heading.start, title: heading.title });
  });
  return starts.map((start, index) => {
    const body = text.slice(start.at, starts[index + 1]?.at ?? text.length);
    return { title: plain(start.title ?? "Laporan awal"), verdict: verdictOf(body), body };
  });
}

export type FindingHead = RecapFinding & { heading: string; body: string };

/**
 * Semua blok temuan di laporan: heading ber-severity, bernomor T-n, atau ber-ref F-nnn, di bagian
 * mana pun. Sengaja tidak terikat "## Temuan" karena di laporan nyata judulnya bervariasi ("## Temuan (BUG)").
 */
export function findingHeads(text: string): FindingHead[] {
  const headings = headingsOf(text);
  const heads: FindingHead[] = [];
  headings.forEach((heading, index) => {
    if (heading.level < 3) return;
    const finding = parseFindingHead(heading.title);
    // Laporan lama memakai "T-1 — judul (tinggi)", tanpa pemisah yang dikenali parser.
    const id = finding.id ?? /^T-\d+\b/i.exec(plain(heading.title))?.[0].toUpperCase();
    if (!id && !finding.ref && finding.severity === "lain") return;
    const next = headings.slice(index + 1).find((other) => other.level <= heading.level);
    heads.push({ ...finding, id, heading: plain(heading.title), body: text.slice(heading.end, next?.start ?? text.length).trim() });
  });
  return heads;
}

function reportChangedAt(taskId: string, fallback: string): string {
  try {
    return statSync(reportPath(taskId)).mtime.toISOString();
  } catch {
    return fallback;
  }
}

const recapCache = new Map<string, { at: number; value: ProjectRecap }>();
/** Report project dipoll tiap 4 detik saat kurator jalan; membaca semua report.md tiap kali itu mahal. */
const RECAP_TTL_MS = 3_000;

/**
 * Rekap project. `fresh` memaksa baca ulang dari disk (tombol Sync); selain itu hasil
 * yang berumur < 3 detik dipakai lagi.
 */
export function buildProjectRecap(projectId: string, options: { fresh?: boolean } = {}): ProjectRecap {
  const cached = recapCache.get(projectId);
  if (!options.fresh && cached && Date.now() - cached.at < RECAP_TTL_MS) return cached.value;
  const value = computeProjectRecap(projectId);
  recapCache.set(projectId, { at: Date.now(), value });
  return value;
}

/** Buang rekap tersimpan — dipanggil saat tugas project ini dihapus, supaya barisnya tidak tertinggal 3 detik. */
export function forgetProjectRecap(projectId: string): void {
  recapCache.delete(projectId);
}

function computeProjectRecap(projectId: string): ProjectRecap {
  const entries: RecapEntry[] = [];
  let emptyCount = 0;

  for (const task of tasksInProject(projectId)) {
    const common = {
      taskId: task.id,
      title: task.title,
      role: task.role,
      status: task.status,
      assetCount: listAssets(task.id).length,
      costUsd: task.costUsd,
      updatedAt: task.updatedAt,
      finishedAt: task.finishedAt,
    };
    const report = readReport(task.id);
    if (report?.trim()) {
      // Laporan tanpa heading "## Ringkasan" tidak boleh membuat barisnya kosong —
      // ringkasan serah terima dipakai sebagai cadangan.
      const summary = summaryOf(report) ?? lastSummary(task);
      entries.push({
        ...common,
        source: "report",
        verdict: verdictOf(report),
        summary: summary ? clip(summary, SUMMARY_MAX) : undefined,
        findings: findingsOf(report),
        changedAt: reportChangedAt(task.id, task.updatedAt),
      });
      continue;
    }
    const handoff = lastSummary(task);
    if (handoff) {
      entries.push({
        ...common,
        source: "summary",
        summary: clip(handoff, SUMMARY_MAX),
        findings: [],
        changedAt: task.updatedAt,
      });
      continue;
    }
    emptyCount += 1;
  }

  const findings = entries.flatMap((entry) => entry.findings);
  const countTone = (tone: RecapTone): number => entries.filter((entry) => entry.verdict?.tone === tone).length;
  const countSeverity = (severity: RecapSeverity): number =>
    findings.filter((finding) => finding.severity === severity).length;

  return {
    projectId,
    generatedAt: new Date().toISOString(),
    entries,
    deleted: deletedInProject(projectId).map((task) => ({
      // Tugas tanpa laporan maupun ringkasan tidak punya snapshot — barisnya tetap ada.
      ...(task.recap ?? {
        taskId: task.id,
        title: task.title,
        role: task.role,
        status: task.status,
        source: "summary",
        findings: [],
        assetCount: 0,
        costUsd: task.costUsd,
        updatedAt: task.deletedAt,
        changedAt: task.deletedAt,
      }),
      deletedAt: task.deletedAt,
    })),
    emptyCount,
    totals: {
      reports: entries.filter((entry) => entry.source === "report").length,
      summaries: entries.filter((entry) => entry.source === "summary").length,
      good: countTone("good"),
      warn: countTone("warn"),
      bad: countTone("bad"),
      blocker: countSeverity("blocker"),
      major: countSeverity("major"),
      minor: countSeverity("minor"),
      other: countSeverity("lain"),
      costUsd: Number(entries.reduce((total, entry) => total + entry.costUsd, 0).toFixed(6)),
    },
  };
}
