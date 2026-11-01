import { useEffect, useState } from "react";
import { api } from "../api.ts";

export function Diff({ projectId }: { projectId?: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.diff>>>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setData(undefined);
    void api.diff(projectId).then(setData);
  }, [tick, projectId]);

  if (!data) return <p className="p-6 text-sm text-faint">Memuat…</p>;

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-ink">Perubahan di workspace</h2>
        <span className="font-mono text-xs text-muted">{data.dir}</span>
        {data.isRepo && <span className="rounded bg-hover px-2 py-0.5 text-xs text-muted">{data.branch}</span>}
        <button onClick={() => setTick((v) => v + 1)} className="ml-auto text-xs text-muted hover:text-ink">
          muat ulang
        </button>
      </div>

      {!data.isRepo && (
        <p className="mt-4 rounded-lg border border-line bg-panel p-3 text-sm text-muted">
          Workspace bukan repositori git, jadi diff tidak tersedia. Jalankan `git init` di folder itu kalau Anda ingin
          me-review perubahan Engineer sebagai diff.
        </p>
      )}

      {data.isRepo && (
        <>
          <h3 className="mt-5 text-xs uppercase tracking-wide text-muted">git status</h3>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-page p-3 font-mono text-xs text-ink">
            {data.status.trim() || "bersih — tidak ada perubahan"}
          </pre>
          <h3 className="mt-5 text-xs uppercase tracking-wide text-muted">git diff</h3>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-page p-3 font-mono text-xs leading-relaxed">
            {(data.diff.trim() || "tidak ada diff").split("\n").map((line, index) => (
              <div
                key={index}
                className={
                  line.startsWith("+") && !line.startsWith("+++")
                    ? "text-tag-green-ink"
                    : line.startsWith("-") && !line.startsWith("---")
                      ? "text-tag-red-ink"
                      : line.startsWith("@@")
                        ? "text-tag-blue-ink"
                        : "text-muted"
                }
              >
                {line || " "}
              </div>
            ))}
          </pre>
        </>
      )}
    </div>
  );
}
