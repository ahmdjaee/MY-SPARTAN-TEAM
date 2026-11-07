/**
 * Report project sebagai berkas Markdown untuk diunduh: versi lengkap, atau temuan saja.
 *
 * Fungsi murni: seluruh data disuplai pemanggil. Kedua berkas selalu memuat semua temuan aktif,
 * tidak mengikuti saringan yang sedang dipakai di tab Report.
 */
import type { CoverageCell, CoverageState, Finding, FindingSeverity, FindingStatus } from "./findings.ts";
import { OPEN_STATUSES } from "./findings.ts";
import type { ProjectRecap, RecapEntry, RecapSeverity, RecapTone } from "./recap.ts";
import type { TaskFinding, TaskUnlinkedFinding } from "./task-report.ts";

const STATUS_LABEL: Record<FindingStatus, string> = {
  open: "terbuka",
  needs_retest: "perlu uji ulang",
  fixed: "diperbaiki",
  wontfix: "tidak diperbaiki",
  invalid: "bukan masalah",
};

const COVERAGE_LABEL: Record<CoverageState, string> = {
  tested: "teruji",
  partial: "sebagian",
  blocked: "terblokir",
  untested: "belum",
};

const SEVERITY_RANK: FindingSeverity[] = ["blocker", "major", "minor"];

// Emoji, bukan warna HTML: penampil seperti Outline menampilkan tag HTML sebagai teks.
// Severity memakai kotak dan status memakai lingkaran supaya merah keduanya tidak tertukar.
const SEVERITY_MARK: Record<FindingSeverity, string> = { blocker: "🟥", major: "🟧", minor: "⬜" };

const STATUS_MARK: Record<FindingStatus, string> = {
  open: "🔴",
  needs_retest: "🟡",
  fixed: "🟢",
  wontfix: "⚫",
  invalid: "⚪",
};

const COVERAGE_MARK: Record<CoverageState, string> = { tested: "🟢", partial: "🟡", blocked: "🔴", untested: "⚪" };

const TONE_MARK: Record<RecapTone, string> = { good: "🟢", warn: "🟡", bad: "🔴" };

/** Status temuan seperti tertulis di berkas, mis. "🔴 terbuka". */
export function statusText(status: FindingStatus): string {
  return `${STATUS_MARK[status]} ${STATUS_LABEL[status]}`;
}

function severityText(severity: RecapSeverity): string {
  return severity === "lain" ? severity : `${SEVERITY_MARK[severity]} ${severity}`;
}

export type FindingsMarkdownInput = {
  project: { name: string; targetUrl?: string };
  generatedAt: string;
  findings: Finding[];
  counts: Record<string, number>;
};

export type ReportMarkdownInput = FindingsMarkdownInput & {
  state: string;
  coverage: CoverageCell[];
  recap: ProjectRecap;
};

/** occurrences = sertakan daftar "Dilaporkan di" pada tiap temuan. */
type FindingOptions = { occurrences: boolean };

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

/** Judul dan label harus tetap satu baris supaya tidak memecah heading atau butir daftar. */
function inline(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function cell(text: string): string {
  return inline(text).replace(/\|/g, "\\|");
}

/** Teks kurator/agen punya heading sendiri; turunkan supaya tetap di bawah bagian yang memuatnya. */
function nested(text: string, levels: number): string {
  let fence = false;
  return text
    .trim()
    .split("\n")
    .map((line) => {
      if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
      if (fence) return line;
      return line.replace(/^(#{1,6})(?=\s)/, (marks) => "#".repeat(Math.min(marks.length + levels, 6)));
    })
    .join("\n");
}

function findingBlock(finding: Finding, options: FindingOptions): string {
  const facts = [
    `**Severity:** ${severityText(finding.severity)}`,
    `**Status:** ${statusText(finding.status)}`,
  ];
  if (finding.area) facts.push(`**Area:** ${inline(finding.area)}`);

  const parts = [`### ${finding.id} · ${inline(finding.title)}`, facts.join(" · ")];
  if (finding.summary?.trim()) parts.push(nested(finding.summary, 3));
  if (finding.resolution && !OPEN_STATUSES.includes(finding.status)) {
    const { by, at, note } = finding.resolution;
    parts.push(`**Ditutup oleh** ${inline(by)} (${stamp(at)}): ${inline(note)}`);
  }
  if (finding.lastVerifiedAt) parts.push(`**Terverifikasi uji ulang:** ${stamp(finding.lastVerifiedAt)}`);
  if (options.occurrences && finding.occurrences.length > 0) {
    const rows = finding.occurrences.map((item) => {
      const local = item.localId ? ` ${inline(item.localId)}` : "";
      const note = item.note ? `: ${inline(item.note)}` : "";
      return `- \`${item.taskId}\`${local} (${stamp(item.at)})${note}`;
    });
    parts.push(`**Dilaporkan di:**\n\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}

function registerSection(findings: Finding[], options: FindingOptions): string {
  const active = findings
    .filter((finding) => !finding.mergedInto)
    .sort(
      (a, b) => SEVERITY_RANK.indexOf(a.severity) - SEVERITY_RANK.indexOf(b.severity) || a.id.localeCompare(b.id),
    );
  if (active.length === 0) return "## Register temuan\n\nRegister masih kosong.";

  const opened = active.filter((finding) => OPEN_STATUSES.includes(finding.status));
  const closed = active.filter((finding) => !OPEN_STATUSES.includes(finding.status));
  const group = (title: string, items: Finding[]): string =>
    `## ${title} (${items.length})\n\n${items.length > 0 ? items.map((item) => findingBlock(item, options)).join("\n\n") : "Tidak ada."}`;
  return `${group("Temuan terbuka", opened)}\n\n${group("Temuan ditutup", closed)}`;
}

function coverageSection(cells: CoverageCell[]): string {
  if (cells.length === 0) return "## Cakupan uji\n\nBelum ada data cakupan.";
  const areas = [...new Set(cells.map((item) => item.area))].sort();
  const subjects = [...new Set(cells.map((item) => item.subject))].sort();
  const byKey = new Map(cells.map((item) => [`${item.area}\u0000${item.subject}`, item]));

  const row = (values: string[]): string => `| ${values.join(" | ")} |`;
  const lines = [row(["Area", ...subjects.map(cell)]), row(["---", ...subjects.map(() => "---")])];
  for (const area of areas) {
    const values = subjects.map((subject) => {
      const found = byKey.get(`${area}\u0000${subject}`);
      if (!found) return "·";
      const label = `${COVERAGE_MARK[found.state]} ${COVERAGE_LABEL[found.state]}`;
      return found.note ? `${label} (${cell(found.note)})` : label;
    });
    lines.push(row([cell(area), ...values]));
  }
  return `## Cakupan uji\n\n${lines.join("\n")}`;
}

function recapEntry(entry: RecapEntry): string {
  const facts = [`**Tugas:** \`${entry.taskId}\``, `**Peran:** ${entry.role}`, `**Status:** ${entry.status}`];
  if (entry.verdict) facts.push(`**Verdict:** ${TONE_MARK[entry.verdict.tone]} ${inline(entry.verdict.text)}`);

  const parts = [`### ${inline(entry.title)}`, facts.join(" · ")];
  if (entry.summary?.trim()) parts.push(nested(entry.summary, 3));
  if (entry.findings.length > 0) {
    const rows = entry.findings.map((finding) => {
      const id = finding.id ? `${inline(finding.id)} · ` : "";
      const note = finding.note ? ` (${inline(finding.note)})` : "";
      const ref = finding.ref ? ` · ref ${inline(finding.ref)}` : "";
      return `- ${id}${inline(finding.title)} · ${severityText(finding.severity)}${note}${ref}`;
    });
    parts.push(rows.join("\n"));
  }
  return parts.join("\n\n");
}

/** Judul dan Ringkasan: pembuka yang sama untuk kedua berkas. */
function headerSections(input: FindingsMarkdownInput): string[] {
  const { project, counts } = input;
  const active = input.findings.filter((finding) => !finding.mergedInto).length;

  const meta = [`Dibuat: ${stamp(input.generatedAt)}`];
  if (project.targetUrl) meta.push(`Target: ${project.targetUrl}`);

  return [
    `# Report: ${inline(project.name)}\n\n${meta.join("  \n")}`,
    [
      "## Ringkasan",
      [
        `- Terbuka: ${counts.blocker ?? 0} blocker, ${counts.major ?? 0} major, ${counts.minor ?? 0} minor`,
        `- Perlu uji ulang: ${counts.needs_retest ?? 0}`,
        `- Diperbaiki: ${counts.fixed ?? 0}`,
        `- Total temuan: ${active}`,
      ].join("\n"),
    ].join("\n\n"),
  ];
}

export type TaskFindingsMarkdownInput = {
  task: { id: string; title: string };
  project: { name: string };
  generatedAt: string;
  opened: TaskFinding[];
  resolved: TaskFinding[];
  unlinked: TaskUnlinkedFinding[];
};

/** Path bukti relatif tidak berlaku di berkas unduhan; yang tersisa cukup nama berkasnya. */
function withoutImages(text: string): string {
  return text.replace(/!\[[^\]]*\]\((?:[^)]*\/)?([^)/]+)\)/g, "(bukti: $1)");
}

function reportBlocks(blocks: TaskFinding["blocks"]): string[] {
  return blocks.flatMap((block) => [`**Dari laporan: ${inline(block.heading)}**`, ...(block.body ? [nested(withoutImages(block.body), 3)] : [])]);
}

function taskFindingBlock({ finding, blocks }: TaskFinding): string {
  const parts = [findingBlock(finding, { occurrences: false })];
  if (finding.fix && finding.status === "needs_retest") {
    parts.push(`**Dilaporkan diperbaiki oleh** ${inline(finding.fix.by)} (${stamp(finding.fix.at)}): ${inline(finding.fix.note)}`);
  }
  if (finding.reopenedAt) parts.push(`**Regresi:** dibuka lagi ${stamp(finding.reopenedAt)}`);
  if (finding.retest && !finding.retest.passed) {
    parts.push(`**Uji ulang gagal** di ${finding.retest.taskId}: ${inline(finding.retest.note)} (bukti: ${inline(finding.retest.evidence)})`);
  }
  return [...parts, ...reportBlocks(blocks)].join("\n\n");
}

/** Temuan satu tugas, dibagi seperti tab Temuan dan Resolved di laporan tugas. */
export function renderTaskFindingsMarkdown(input: TaskFindingsMarkdownInput): string {
  const { task, project, opened, resolved, unlinked } = input;
  const unlinkedBlocks = unlinked.map((item) =>
    [
      `### ${item.id ? `${inline(item.id)} · ` : ""}${inline(item.title)}`,
      `**Severity:** ${severityText(item.severity)} · **Status:** belum masuk register`,
      ...(item.body ? [nested(withoutImages(item.body), 3)] : []),
    ].join("\n\n"),
  );
  const openBlocks = [...opened.map(taskFindingBlock), ...unlinkedBlocks];
  const sections = [
    `# Temuan ${task.id}: ${inline(task.title)}\n\nProject: ${inline(project.name)}  \nDibuat: ${stamp(input.generatedAt)}`,
    `## Temuan (${openBlocks.length})\n\n${openBlocks.length > 0 ? openBlocks.join("\n\n") : "Tidak ada."}`,
    `## Resolved (${resolved.length})\n\n${resolved.length > 0 ? resolved.map(taskFindingBlock).join("\n\n") : "Tidak ada."}`,
  ];
  return `${sections.join("\n\n")}\n`;
}

export function renderFindingsMarkdown(input: FindingsMarkdownInput): string {
  const sections = [...headerSections(input), registerSection(input.findings, { occurrences: false })];
  return `${sections.join("\n\n")}\n`;
}

export function renderReportMarkdown(input: ReportMarkdownInput): string {
  const entries = input.recap.entries;
  const sections = [
    ...headerSections(input),
    `## Kesimpulan\n\n${nested(input.state, 2) || "Belum ada kesimpulan."}`,
    registerSection(input.findings, { occurrences: true }),
    coverageSection(input.coverage),
    `## Lampiran: laporan per tugas (${entries.length})\n\n${entries.length > 0 ? entries.map(recapEntry).join("\n\n") : "Belum ada laporan."}`,
  ];
  return `${sections.join("\n\n")}\n`;
}
