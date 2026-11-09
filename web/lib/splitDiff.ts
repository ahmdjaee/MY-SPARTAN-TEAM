/**
 * Memecah keluaran `git diff` (satu string) menjadi satu entri per file.
 * Hasilnya langsung bisa dipakai <DiffView data={{ hunks }} /> dari @git-diff-view/react.
 */

export type DiffSource = "staged" | "unstaged" | "untracked";
/** M diubah, A baru, D dihapus, R ganti nama, U belum dilacak. */
export type DiffFileStatus = "M" | "A" | "D" | "R" | "U";

export interface DiffFileEntry {
  /** Unik per kartu: sumber + path (file yang sama bisa muncul di staged dan unstaged). */
  key: string;
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  source: DiffSource;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Teks patch dari baris `--- ` ke bawah; kosong untuk biner atau rename murni. */
  hunks: string[];
  /** Jumlah baris patch, dipakai untuk batas render. */
  lineCount: number;
}

function stripPrefix(path: string): string {
  return path.replace(/^"?[ab]\//, "").replace(/"$/, "");
}

function parseBlock(block: string, source: DiffSource): DiffFileEntry | undefined {
  const lines = block.replace(/\n$/, "").split("\n");
  const head = /^diff --git (.+) (.+)$/.exec(lines[0] ?? "");
  if (!head) return undefined;

  let oldPath: string | undefined;
  let path = stripPrefix(head[2] ?? "");
  let status: DiffFileStatus = "M";
  let binary = false;
  let patchStart = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("@@")) break;
    if (line.startsWith("--- ")) {
      if (patchStart === -1) patchStart = i;
      if (line !== "--- /dev/null") oldPath = stripPrefix(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      if (line !== "+++ /dev/null") path = stripPrefix(line.slice(4));
    } else if (line.startsWith("new file mode")) status = "A";
    else if (line.startsWith("deleted file mode")) status = "D";
    else if (line.startsWith("rename from ")) {
      status = "R";
      oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) binary = true;
  }

  if (status === "D" && oldPath) path = oldPath;
  if (source === "untracked" && status === "A") status = "U";

  let additions = 0;
  let deletions = 0;
  let hunks: string[] = [];
  let lineCount = 0;
  if (!binary && patchStart !== -1) {
    const patch = lines.slice(patchStart);
    let inHunk = false;
    for (const line of patch) {
      if (line.startsWith("@@")) inHunk = true;
      else if (inHunk && line.startsWith("+")) additions++;
      else if (inHunk && line.startsWith("-")) deletions++;
    }
    lineCount = patch.length;
    hunks = [`${patch.join("\n")}\n`];
  }

  return {
    key: `${source}:${path}`,
    path,
    oldPath: status === "R" ? oldPath : undefined,
    status,
    source,
    additions,
    deletions,
    binary,
    hunks,
    lineCount,
  };
}

export function splitDiff(raw: string, source: DiffSource): DiffFileEntry[] {
  if (!raw.trim()) return [];
  return raw
    .split(/^(?=diff --git )/m)
    .map((block) => parseBlock(block, source))
    .filter((entry): entry is DiffFileEntry => entry !== undefined);
}

export function summarize(files: DiffFileEntry[]): { files: number; additions: number; deletions: number } {
  return {
    files: new Set(files.map((file) => file.path)).size,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
