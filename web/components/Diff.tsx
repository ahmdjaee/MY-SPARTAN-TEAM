import { memo, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { type DiffFileEntry, splitDiff, summarize } from "../lib/splitDiff.ts";
import { DiffFileCard } from "./diff/DiffFileCard.tsx";
import { DiffFileList } from "./diff/DiffFileList.tsx";
import { cardId, SOURCE_BADGE, splitPath } from "./diff/status.ts";
import { useDiffTheme } from "./diff/useDiffTheme.ts";

type Mode = "unified" | "split";
const MODE_KEY = "ai-team-diff-mode";
/** Di bawah lebar ini (px) panel memakai unified + dropdown file, bukan split + sidebar. */
const NARROW_PX = 640;

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function ModeToggle({ mode, onChange, splitDisabled }: { mode: Mode; onChange: (m: Mode) => void; splitDisabled: boolean }) {
  const option = (value: Mode, label: string) => {
    const active = mode === value;
    const disabled = value === "split" && splitDisabled;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        disabled={disabled}
        title={disabled ? "Split butuh panel yang lebih lebar" : undefined}
        onClick={() => onChange(value)}
        className={`rounded-md px-3 py-1 text-xs font-medium ${
          active ? "bg-raised text-ink shadow-sm" : "text-muted hover:text-ink"
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {label}
      </button>
    );
  };
  return (
    <div role="radiogroup" aria-label="Mode tampilan diff" className="flex gap-0.5 rounded-lg bg-hover p-0.5">
      {option("unified", "Unified")}
      {option("split", "Split")}
    </div>
  );
}

export const Diff = memo(function Diff({ projectId }: { projectId?: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.diff>>>();
  const [tick, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>(readMode);
  const [narrow, setNarrow] = useState(false);
  const [active, setActive] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useDiffTheme();

  useEffect(() => {
    let alive = true;
    setData(undefined);
    void api
      .diff(projectId)
      .then((next) => {
        if (alive) setData(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tick, projectId]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? NARROW_PX) < NARROW_PX));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const files = useMemo<DiffFileEntry[]>(
    () =>
      data
        ? [
            ...splitDiff(data.staged, "staged"),
            ...splitDiff(data.unstaged, "unstaged"),
            ...splitDiff(data.untracked, "untracked"),
          ]
        : [],
    [data],
  );
  const total = useMemo(() => summarize(files), [files]);
  const effectiveMode: Mode = narrow ? "unified" : mode;

  const changeMode = (next: Mode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // localStorage bisa diblokir; mode tetap berlaku untuk sesi ini
    }
  };

  const selectFile = (key: string) => {
    setActive(key);
    const entry = files.find((file) => file.key === key);
    // Lompat instan: smooth-scroll melewati ribuan baris butuh beberapa detik.
    if (entry) document.getElementById(cardId(entry))?.scrollIntoView({ block: "start" });
  };

  if (!data) return <p className="p-6 text-sm text-faint">Memuat…</p>;

  const activeKey = active ?? files[0]?.key;

  return (
    <div ref={rootRef} className="@container flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold text-ink">Perubahan di workspace</h2>
        {data.isRepo && <span className="rounded bg-hover px-2 py-0.5 font-mono text-xs text-muted">{data.branch}</span>}
        {data.isRepo && files.length > 0 && (
          <span className="text-xs text-muted">
            {total.files} file berubah{" "}
            <span className="font-mono text-tag-green-ink">+{total.additions}</span>{" "}
            <span className="font-mono text-tag-red-ink">−{total.deletions}</span>
          </span>
        )}
        <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-faint @4xl:block" title={data.dir}>
          {data.dir}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {data.isRepo && files.length > 0 && <ModeToggle mode={effectiveMode} onChange={changeMode} splitDisabled={narrow} />}
          <button
            type="button"
            onClick={() => setTick((v) => v + 1)}
            className="rounded-md border border-line-strong px-3 py-1 text-xs font-medium text-ink hover:bg-hover"
          >
            Muat ulang
          </button>
        </div>
      </div>

      {!data.isRepo && (
        <div className="m-5 flex flex-col items-center gap-1 rounded-lg border border-line bg-panel px-4 py-7 text-center">
          <p className="text-sm font-semibold text-ink">Folder ini bukan repositori git</p>
          <p className="font-mono text-xs text-muted">{data.dir}</p>
          <p className="mt-2 max-w-md text-xs text-muted">
            Jalankan <code className="font-mono text-code-ink">git init</code> di folder itu kalau Anda ingin me-review
            perubahan Engineer sebagai diff.
          </p>
        </div>
      )}

      {data.isRepo && files.length === 0 && (
        <div className="m-5 flex flex-col items-center gap-1 rounded-lg border border-line bg-panel px-4 py-7 text-center">
          <p className="text-sm font-semibold text-ink">Tidak ada perubahan</p>
          <p className="text-xs text-muted">Working tree bersih di {data.branch}</p>
        </div>
      )}

      {data.isRepo && files.length > 0 && (
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 @3xl:block">
            <DiffFileList files={files} active={activeKey} onSelect={selectFile} />
          </aside>
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            <label className="mb-3 block @3xl:hidden">
              <span className="sr-only">Pilih file</span>
              <select
                value={activeKey}
                onChange={(event) => selectFile(event.target.value)}
                className="w-full rounded-md border border-line-strong bg-page px-3 py-2 text-[13px] font-medium text-ink"
              >
                {files.map((file, index) => (
                  <option key={file.key} value={file.key}>
                    {splitPath(file.path).name} ({SOURCE_BADGE[file.source].short}) · {index + 1} dari {files.length}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-4">
              {files.map((entry) => (
                <DiffFileCard key={entry.key} entry={entry} mode={effectiveMode} theme={theme} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
