/**
 * Migrasi sekali jalan: laporan QA v1 (data/reports/<run-id>/) menjadi tugas v2.
 * Aman dijalankan berulang — folder yang sudah dipindah ditandai `.migrated`.
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, ensureDirs } from "../server/config.ts";
import { defaultProjectId, ensureDefaultProject, loadProjects } from "../server/projects.ts";
import { assetsDir, createTask, loadTasks, taskDir, updateTask } from "../server/tasks.ts";

type LegacyMeta = {
  id: string;
  role: "qa" | "engineer" | "devops";
  title: string;
  prompt: string;
  target?: string;
  status: "running" | "done" | "failed";
  createdAt: string;
  finishedAt?: string;
  costUsd?: number;
};

ensureDirs();
loadTasks();
loadProjects();
ensureDefaultProject();

if (!existsSync(CONFIG.legacyReportsDir)) {
  console.log("Tidak ada data/reports — tidak ada yang perlu dimigrasi.");
  process.exit(0);
}

let moved = 0;
for (const entry of readdirSync(CONFIG.legacyReportsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
  const source = join(CONFIG.legacyReportsDir, entry.name);
  if (existsSync(join(source, ".migrated"))) continue;

  const metaPath = join(source, "meta.json");
  if (!existsSync(metaPath)) continue;
  const legacy = JSON.parse(readFileSync(metaPath, "utf8")) as LegacyMeta;

  const task = createTask({
    projectId: defaultProjectId(),
    title: legacy.title.slice(0, 120),
    description: legacy.prompt,
    role: legacy.role,
    targetUrl: legacy.target,
  });

  if (existsSync(join(source, "assets"))) cpSync(join(source, "assets"), assetsDir(task.id), { recursive: true });
  if (existsSync(join(source, "report.md"))) cpSync(join(source, "report.md"), join(taskDir(task.id), "report.md"));

  const review = existsSync(join(source, "review.json"))
    ? (JSON.parse(readFileSync(join(source, "review.json"), "utf8")) as {
        status: "approved" | "changes_requested";
        comment: string;
        reviewedAt: string;
      })
    : undefined;

  updateTask(task.id, {
    status: legacy.status === "failed" ? "failed" : review?.status === "approved" ? "done" : "needs_review",
    createdAt: legacy.createdAt,
    startedAt: legacy.createdAt,
    finishedAt: legacy.finishedAt,
    costUsd: legacy.costUsd ?? 0,
    review,
    assignments: [
      {
        role: legacy.role,
        startedAt: legacy.createdAt,
        endedAt: legacy.finishedAt,
        costUsd: legacy.costUsd ?? 0,
        summary: "(dimigrasi dari v1 — ringkasan serah terima belum ada)",
      },
    ],
  });

  writeFileSync(join(source, ".migrated"), task.id);
  console.log(`${entry.name} → ${task.id}`);
  moved += 1;
}

console.log(moved === 0 ? "Tidak ada laporan baru untuk dimigrasi." : `${moved} laporan dipindah menjadi tugas.`);
