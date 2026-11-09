import { lazy, memo, Suspense, useState } from "react";
import type { DiffFileEntry } from "../../lib/splitDiff.ts";
import { cardId, SOURCE_BADGE, STATUS_BADGE } from "./status.ts";

const DiffBody = lazy(() => import("./DiffBody.tsx"));

/** Di atas ini isi diff disembunyikan sampai diminta: satu baris = satu elemen DOM. */
export const LINE_LIMIT = 3_000;

/** Lima kotak hijau/merah ala GitHub: proporsi tambah vs hapus. */
function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const green = total === 0 ? 0 : Math.max(additions > 0 ? 1 : 0, Math.min(5, Math.round((5 * additions) / total)));
  const red = total === 0 ? 0 : 5 - green;
  return (
    <span className="flex gap-0.5" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={`size-2 rounded-[1px] ${i < green ? "bg-tag-green-ink" : i < green + red ? "bg-tag-red-ink" : "bg-line-strong"}`}
        />
      ))}
    </span>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center gap-2 px-4 py-5 text-center text-[13px] text-muted">{children}</div>;
}

export const DiffFileCard = memo(function DiffFileCard({
  entry,
  mode,
  theme,
}: {
  entry: DiffFileEntry;
  mode: "unified" | "split";
  theme: "light" | "dark";
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [forced, setForced] = useState(false);
  const [copied, setCopied] = useState(false);
  const status = STATUS_BADGE[entry.status];
  const source = SOURCE_BADGE[entry.source];
  const tooLarge = entry.lineCount > LINE_LIMIT && !forced;

  const copyPath = () => {
    void navigator.clipboard
      ?.writeText(entry.path)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  let body: React.ReactNode;
  if (entry.binary) body = <Notice>File biner tidak ditampilkan</Notice>;
  else if (entry.hunks.length === 0)
    body = <Notice>{entry.status === "R" ? "Nama file diubah, isi sama. Tidak ada perubahan baris." : "Tidak ada perubahan baris."}</Notice>;
  else if (tooLarge)
    body = (
      <Notice>
        <span>Diff terlalu besar ({entry.lineCount.toLocaleString("id-ID")} baris) dan disembunyikan agar tetap lancar</span>
        <button
          type="button"
          onClick={() => setForced(true)}
          className="rounded-md border border-line-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-hover"
        >
          Tampilkan diff
        </button>
      </Notice>
    );
  else
    body = (
      <Suspense fallback={<Notice>Memuat diff…</Notice>}>
        <DiffBody entry={entry} mode={mode} theme={theme} />
      </Suspense>
    );

  return (
    <section id={cardId(entry)} className="scroll-mt-3 overflow-hidden rounded-lg border border-line bg-page">
      <header className="sticky top-0 z-10 flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-panel px-3 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Buka file" : "Ciutkan file"}
          className="flex size-5 items-center justify-center rounded text-xs text-muted hover:bg-hover hover:text-ink"
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span
          title={status.title}
          className={`flex size-[18px] shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold ${status.className}`}
        >
          {status.label}
        </span>
        <span className="min-w-[8rem] flex-1 truncate font-mono text-xs font-medium text-ink" title={entry.path}>
          {entry.oldPath ? `${entry.oldPath}  →  ${entry.path}` : entry.path}
        </span>
        <span className={`shrink-0 rounded px-1.5 py-px text-[11px] font-medium ${source.className}`}>{source.label}</span>
        <button
          type="button"
          onClick={copyPath}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-ink"
        >
          {copied ? "Tersalin" : "Salin path"}
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-xs font-medium">
          {entry.additions > 0 && <span className="text-tag-green-ink">+{entry.additions}</span>}
          {entry.deletions > 0 && <span className="text-tag-red-ink">−{entry.deletions}</span>}
          <ChangeBar additions={entry.additions} deletions={entry.deletions} />
        </span>
      </header>
      {!collapsed && body}
    </section>
  );
});
