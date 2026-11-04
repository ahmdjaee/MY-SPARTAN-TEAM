import { memo, useEffect, useState } from "react";
import {
  ROLE_SHORT,
  STATUS_LABEL,
  STATUS_STYLE,
  type ProjectInfo,
  type RoleId,
  type TaskListItem,
  type TaskStatus,
} from "../api.ts";

function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}j` : `${Math.round(hours / 24)}h`;
}

/**
 * Daftar hanya render ulang kalau props-nya berubah (App membandingkan payload dulu).
 * Umur relatif ("3m") tetap bergerak lewat detak satu menit.
 */
export const TaskList = memo(function TaskList({
  tasks,
  projects,
  showProject,
  selectedId,
  filterRole,
  filterStatus,
  onSelect,
  onFilterRole,
  onFilterStatus,
}: {
  tasks: TaskListItem[];
  projects: ProjectInfo[];
  /** Nama project hanya perlu tampil saat daftar memuat beberapa project sekaligus. */
  showProject: boolean;
  selectedId?: string;
  filterRole: RoleId | "";
  filterStatus: TaskStatus | "";
  onSelect: (id: string) => void;
  onFilterRole: (role: RoleId | "") => void;
  onFilterStatus: (status: TaskStatus | "") => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const names = new Map(projects.map((item) => [item.id, item.name]));
  const nameOf = (projectId: string): string | undefined => names.get(projectId);
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-2 border-b border-line px-3 py-2">
        <select
          value={filterRole}
          onChange={(e) => onFilterRole(e.target.value as RoleId | "")}
          className="flex-1 rounded-lg border border-line bg-page px-2 py-1 text-xs text-ink"
        >
          <option value="">semua bot</option>
          <option value="qa">QA</option>
          <option value="engineer">Engineer</option>
          <option value="devops">DevOps</option>
        </select>
        <select
          value={filterStatus}
          onChange={(e) => onFilterStatus(e.target.value as TaskStatus | "")}
          className="flex-1 rounded-lg border border-line bg-page px-2 py-1 text-xs text-ink"
        >
          <option value="">semua status</option>
          {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tasks.length === 0 && <p className="px-4 py-6 text-sm text-faint">Belum ada tugas.</p>}
        {tasks.map((task) => (
          <button
            key={task.id}
            onClick={() => onSelect(task.id)}
            className={`block w-full border-l-2 px-4 py-3 text-left ${
              selectedId === task.id ? "border-accent bg-hover" : "border-transparent hover:bg-hover"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-muted">{task.id}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[task.status]}`}>
                {STATUS_LABEL[task.status]}
              </span>
              {task.live && (
                <span className="flex items-center gap-1 text-[10px] text-tag-red-ink">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-tag-red-ink" />
                  live
                </span>
              )}
              <span className="ml-auto text-[10px] text-faint">{age(task.updatedAt)}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-sm text-ink">{task.title}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] whitespace-nowrap text-muted">
              <span>{ROLE_SHORT[task.role]}</span>
              {showProject && nameOf(task.projectId) && <span className="truncate">· {nameOf(task.projectId)}</span>}
              {task.assignments.length > 1 && <span>· {task.assignments.length} penugasan</span>}
              {task.assetCount > 0 && <span>· {task.assetCount} bukti</span>}
              {task.costUsd > 0 && <span>· ${task.costUsd.toFixed(3)}</span>}
              {task.suggestedNext && <span className="text-tag-orange-ink">· usul operan</span>}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
});
