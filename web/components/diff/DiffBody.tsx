import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import { memo, useMemo } from "react";
import type { DiffFileEntry } from "../../lib/splitDiff.ts";

/**
 * Satu-satunya tempat library diff diimpor, supaya Diff.tsx memuatnya lazy:
 * orang yang tidak membuka tab "Perubahan" tidak ikut mengunduhnya.
 */
const DiffBody = memo(function DiffBody({
  entry,
  mode,
  theme,
}: {
  entry: DiffFileEntry;
  mode: "unified" | "split";
  theme: "light" | "dark";
}) {
  const data = useMemo(
    () => ({
      oldFile: { fileName: entry.oldPath ?? entry.path },
      newFile: { fileName: entry.path },
      hunks: entry.hunks,
    }),
    [entry],
  );
  return (
    <div className="dv-host">
      <DiffView
        data={data}
        diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewTheme={theme}
        diffViewHighlight
        diffViewFontSize={12}
      />
    </div>
  );
});

export default DiffBody;
