import { Link, useSearchParams } from "react-router-dom";
import type { ProjectInfo } from "../api.ts";
import { projectPath } from "../routes.tsx";
import { Combobox, type ComboOption } from "./Combobox.tsx";

/**
 * Pemilih induk tugas di atas daftar tugas. Nilai "" berarti semua project.
 * Pilihannya disimpan di alamat (?project=…) oleh pemanggil, jadi tahan refresh.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
  onCreate,
}: {
  projects: ProjectInfo[];
  value: string;
  onChange: (projectId: string) => void;
  onCreate: () => void;
}) {
  const [search] = useSearchParams();
  const active = projects.find((project) => project.id === value);
  const waiting = active?.waitingCount ?? projects.reduce((total, project) => total + project.waitingCount, 0);

  const options: ComboOption[] = [
    { value: "", label: "Semua project", hint: `${projects.length} project`, badge: undefined },
    ...projects.map((project) => ({
      value: project.id,
      label: project.archived ? `${project.name} (arsip)` : project.name,
      hint: project.workspaceDir,
      badge: String(project.taskCount),
    })),
  ];

  return (
    <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
      <Combobox
        compact
        className="min-w-0 flex-1"
        value={value}
        options={options}
        onChange={onChange}
        ariaLabel="Pilih project"
        searchPlaceholder="Cari project…"
        emptyText="Tidak ada project yang cocok."
        action={{ label: "+ Project baru…", onSelect: onCreate }}
      />
      {waiting > 0 && (
        <span
          className="shrink-0 rounded bg-tag-yellow px-1.5 py-0.5 text-[11px] text-tag-yellow-ink"
          title="tugas yang menunggu keputusan Anda"
        >
          {waiting}
        </span>
      )}
      {active && (
        <Link
          to={projectPath(active.id, search)}
          title={`Buka halaman ${active.name}`}
          aria-label={`Buka halaman project ${active.name}`}
          className="shrink-0 rounded-lg border border-line px-1.5 py-1 text-xs text-muted hover:bg-hover hover:text-ink"
        >
          ⚙
        </Link>
      )}
    </div>
  );
}
