import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { askHub } from "./agent/ask.ts";
import { curator } from "./agent/curator.ts";
import { scheduler } from "./agent/scheduler.ts";
import { CONFIG, ensureDirs } from "./config.ts";
import { httpGuard } from "./http-guard.ts";
import { attachRealtime } from "./realtime.ts";
import { closeOrphanRequests } from "./recover.ts";
import { approvalsRouter } from "./routes/approvals.ts";
import { askRouter } from "./routes/ask.ts";
import { healthRouter } from "./routes/health.ts";
import { memoryRouter } from "./routes/memory.ts";
import { projectsRouter } from "./routes/projects.ts";
import { settingsRouter } from "./routes/settings.ts";
import { tasksRouter } from "./routes/tasks.ts";
import { workspaceRouter } from "./routes/workspace.ts";
import { loadTasks } from "./tasks.ts";
import { adoptOrphanTasks } from "./context.ts";
import { ensureDefaultProject, listProjects, loadProjects } from "./projects.ts";
import { migrateProjects } from "../scripts/migrate-projects.ts";

ensureDirs();
// Urutan penting: migrasi membaca tugas lama, lalu project dimuat, lalu tugas yatim diadopsi.
loadTasks();
const migration = migrateProjects();
loadProjects();
loadTasks();
ensureDefaultProject();
const adopted = adoptOrphanTasks();
const orphans = closeOrphanRequests();
curator.watch();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = express();

// Pagar Host/Origin dulu: permintaan dari situs lain tidak boleh sampai membaca body sekalipun.
app.use("/api", httpGuard);
app.use(express.json({ limit: "20mb" }));
app.use("/api", tasksRouter, askRouter, projectsRouter, approvalsRouter, memoryRouter, settingsRouter, workspaceRouter, healthRouter);

// Aplikasi demo kecil sebagai target uji QA (sengaja punya cacat untuk ditemukan).
// Berkasnya ada di dalam workspace supaya Engineer bisa memperbaikinya seperti kode proyek biasa.
app.get("/demo", (_req, res) => {
  const inWorkspace = join(CONFIG.workspaceDir, "demo", "index.html");
  res.sendFile(existsSync(inWorkspace) ? inWorkspace : join(root, "web", "public", "demo.html"));
});

const dist = join(root, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(join(dist, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send("<h1>AI Team API aktif</h1><p>UI dev: jalankan <code>bun run dev</code> lalu buka port Vite.</p>");
  });
}

const server = app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`AI Team siap di http://${CONFIG.host}:${CONFIG.port}`);
  if (orphans > 0) console.log(`  ${orphans} permintaan persetujuan lama ditutup (sisa restart sebelumnya)`);
  if (migration.length > 0) console.log(`  migrasi project:\n${migration.join("\n")}`);
  if (adopted > 0) console.log(`  ${adopted} tugas tanpa induk diberi project bawaan`);
  console.log(`  project   : ${listProjects().map((project) => project.id).join(", ")}`);
  console.log(`  workspace : ${CONFIG.workspaceDir} (bawaan; project boleh punya sendiri)`);
  console.log(`  data      : ${CONFIG.dataDir}`);
  console.log(`  model     : qa=${CONFIG.models.qa} engineer=${CONFIG.models.engineer} devops=${CONFIG.models.devops} uiux=${CONFIG.models.uiux}`);
  const resumed = scheduler.resumePending();
  if (resumed > 0) console.log(`  ${resumed} tugas yang sempat berjalan dilanjutkan`);
  curator.catchUp();
});
const realtime = attachRealtime(server);

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} — menutup sesi agen…`);
  realtime.close();
  askHub.closeAll();
  curator.closeAll();
  await scheduler.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
