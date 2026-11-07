/**
 * Temuan satu tugas untuk tab Laporan.
 *
 * Status selalu dibaca dari register project, jadi retest di tugas lain ikut memperbarui tugas ini.
 * report.md hanya menyumbang detail (langkah reproduksi, bukti) dan temuan yang belum dikurasi.
 */
import { FINDING_SEVERITIES, type Finding, type FindingSeverity, type Register } from "./findings.ts";
import { findingHeads, type FindingHead } from "./recap.ts";

export type TaskFindingBlock = { heading: string; body: string };
export type TaskFinding = { finding: Finding; blocks: TaskFindingBlock[] };
export type TaskUnlinkedFinding = { id?: string; title: string; severity: FindingSeverity; note?: string; body: string };

export type TaskFindings = {
  /** Masih perlu dikerjakan. */
  opened: TaskFinding[];
  /** Sudah ditangani, termasuk yang masih menunggu uji ulang. */
  resolved: TaskFinding[];
  /** Ada di laporan tugas ini, tetapi belum tertaut ke register. */
  unlinked: TaskUnlinkedFinding[];
};

const rank = (severity: FindingSeverity): number => FINDING_SEVERITIES.indexOf(severity);

function byImportance(a: TaskFinding, b: TaskFinding): number {
  return rank(a.finding.severity) - rank(b.finding.severity) || a.finding.id.localeCompare(b.finding.id);
}

/** Nomor kemunculan bisa menyebut beberapa temuan laporan sekaligus, mis. "T-5/T-6". */
function localNumbers(localId: string | undefined): string[] {
  return localId ? localId.toUpperCase().split(/[\s/,]+/).filter(Boolean) : [];
}

/**
 * Nomor T-n bisa terpakai ulang antar-putaran, jadi `ref F-nnn` selalu didahulukan. Blok tanpa ref
 * hanya dicocokkan lewat nomor kemunculan, dan yang dipakai hanya yang terakhir ditulis.
 */
function blocksFor(heads: FindingHead[], id: string, localId: string | undefined, target: (ref: string) => string | undefined): TaskFindingBlock[] {
  const byNumber = new Set(localNumbers(localId).map((number) => heads.filter((head) => !head.ref && head.id === number).at(-1)));
  return heads
    .filter((head) => (head.ref ? target(head.ref) === id : byNumber.has(head)))
    .map(({ heading, body }) => ({ heading, body }));
}

export function buildTaskFindings(taskId: string, report: string, register: Register): TaskFindings {
  const heads = report ? findingHeads(report) : [];
  const byId = new Map(register.findings.map((finding) => [finding.id, finding]));
  /** Duplikat yang sudah digabung diteruskan ke induknya. */
  const target = (ref: string): string | undefined => {
    let finding = byId.get(ref);
    const seen = new Set<string>();
    while (finding?.mergedInto && !seen.has(finding.id)) {
      seen.add(finding.id);
      finding = byId.get(finding.mergedInto);
    }
    return finding?.id;
  };
  const referenced = new Set(heads.flatMap((head) => (head.ref ? [target(head.ref)] : [])));
  const linkedNumbers = new Set(
    register.findings.flatMap((finding) =>
      finding.occurrences.flatMap((item) => (item.taskId === taskId ? localNumbers(item.localId) : [])),
    ),
  );

  const related = register.findings
    .filter(
      (finding) =>
        !finding.mergedInto &&
        (referenced.has(finding.id) ||
          finding.occurrences.some((item) => item.taskId === taskId) ||
          finding.fix?.taskId === taskId ||
          finding.retest?.taskId === taskId),
    )
    .map((finding): TaskFinding => {
      const localId = finding.occurrences.find((item) => item.taskId === taskId)?.localId;
      return { finding, blocks: blocksFor(heads, finding.id, localId, target) };
    })
    .sort(byImportance);

  const unlinked = heads.flatMap((head): TaskUnlinkedFinding[] => {
    if (head.severity === "lain") return [];
    if (head.ref && target(head.ref)) return [];
    if (head.id && linkedNumbers.has(head.id)) return [];
    return [{ id: head.id, title: head.title, severity: head.severity, note: head.note, body: head.body }];
  });
  unlinked.sort((a, b) => rank(a.severity) - rank(b.severity));

  return {
    opened: related.filter(({ finding }) => finding.status === "open"),
    resolved: related.filter(({ finding }) => finding.status !== "open"),
    unlinked,
  };
}

