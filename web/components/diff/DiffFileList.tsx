import type { DiffFileEntry } from "../../lib/splitDiff.ts";
import { SOURCE_BADGE, splitPath, STATUS_BADGE } from "./status.ts";

function Counts({ entry }: { entry: DiffFileEntry }) {
  return (
    <span className="shrink-0 font-mono text-[11px]">
      {entry.additions > 0 && <span className="text-tag-green-ink">+{entry.additions}</span>}
      {entry.additions > 0 && entry.deletions > 0 && " "}
      {entry.deletions > 0 && <span className="text-tag-red-ink">−{entry.deletions}</span>}
    </span>
  );
}

/** Sidebar di layar lebar; di layar sempit diganti dropdown (lihat Diff.tsx). */
export function DiffFileList({
  files,
  active,
  onSelect,
}: {
  files: DiffFileEntry[];
  active: string | undefined;
  onSelect: (key: string) => void;
}) {
  return (
    <nav aria-label="Daftar file berubah" className="flex flex-col gap-0.5">
      {files.map((entry) => {
        const { name, dir } = splitPath(entry.path);
        const status = STATUS_BADGE[entry.status];
        const isActive = entry.key === active;
        return (
          <button
            key={entry.key}
            type="button"
            onClick={() => onSelect(entry.key)}
            aria-current={isActive ? "true" : undefined}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${isActive ? "bg-accent-soft" : "hover:bg-hover"}`}
          >
            <span
              title={status.title}
              className={`flex size-[18px] shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold ${status.className}`}
            >
              {status.label}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">{name}</span>
              <span className="block truncate text-[11px] text-faint">
                {[dir, SOURCE_BADGE[entry.source].short].filter(Boolean).join(" · ")}
              </span>
            </span>
            <Counts entry={entry} />
          </button>
        );
      })}
    </nav>
  );
}
