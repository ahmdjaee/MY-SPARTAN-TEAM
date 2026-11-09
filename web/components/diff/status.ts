import type { DiffFileEntry, DiffFileStatus, DiffSource } from "../../lib/splitDiff.ts";

export const STATUS_BADGE: Record<DiffFileStatus, { label: string; title: string; className: string }> = {
  M: { label: "M", title: "Diubah", className: "bg-tag-yellow text-tag-yellow-ink" },
  A: { label: "A", title: "Baru", className: "bg-tag-green text-tag-green-ink" },
  D: { label: "D", title: "Dihapus", className: "bg-tag-red text-tag-red-ink" },
  R: { label: "R", title: "Ganti nama", className: "bg-tag-blue text-tag-blue-ink" },
  U: { label: "U", title: "Belum dilacak", className: "bg-tag-gray text-tag-gray-ink" },
};

export const SOURCE_BADGE: Record<DiffSource, { label: string; short: string; className: string }> = {
  staged: { label: "sudah di-stage", short: "staged", className: "bg-tag-green text-tag-green-ink" },
  unstaged: { label: "belum di-stage", short: "unstaged", className: "bg-tag-yellow text-tag-yellow-ink" },
  untracked: { label: "belum dilacak", short: "baru", className: "bg-tag-gray text-tag-gray-ink" },
};

export function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  return index === -1 ? { name: path, dir: "" } : { name: path.slice(index + 1), dir: path.slice(0, index) };
}

export function cardId(entry: Pick<DiffFileEntry, "key">): string {
  return `diff-${entry.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
