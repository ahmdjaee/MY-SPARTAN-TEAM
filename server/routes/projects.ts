import { Router } from "express";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  readContext,
  readProjectMemory,
  updateProject,
  validateWorkspaceDir,
  workspaceForProject,
  writeContext,
  writeProjectMemory,
  type Project,
} from "../projects.ts";
import { listTasks } from "../tasks.ts";

export const projectsRouter = Router();

function withStats(project: Project) {
  const tasks = listTasks({ project: project.id });
  return {
    ...project,
    workspaceDir: workspaceForProject(project.id),
    /** Kosong = project memakai workspace bawaan aplikasi, bukan folder sendiri. */
    ownWorkspaceDir: project.workspaceDir,
    taskCount: tasks.length,
    waitingCount: tasks.filter((task) => task.status === "waiting").length,
    reviewCount: tasks.filter((task) => task.status === "needs_review").length,
    costUsd: Number(tasks.reduce((total, task) => total + task.costUsd, 0).toFixed(6)),
  };
}

projectsRouter.get("/projects", (_req, res) => {
  res.json({ projects: listProjects().map(withStats) });
});

projectsRouter.post("/projects", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "nama project wajib diisi" });
    return;
  }
  const workspace = validateWorkspaceDir(req.body?.workspaceDir);
  if (workspace.error) {
    res.status(400).json({ error: workspace.error });
    return;
  }
  const project = createProject({
    name,
    targetUrl: typeof req.body?.targetUrl === "string" ? req.body.targetUrl : undefined,
    workspaceDir: workspace.dir,
  });
  res.json({ project: withStats(project) });
});

projectsRouter.get("/projects/:id", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "project tidak ditemukan" });
    return;
  }
  res.json({
    project: withStats(project),
    context: readContext(project.id),
    memory: readProjectMemory(project.id),
    tasks: listTasks({ project: project.id }),
  });
});

projectsRouter.patch("/projects/:id", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "project tidak ditemukan" });
    return;
  }
  const patch: Partial<Project> = {};
  if (typeof req.body?.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 80);
  if (typeof req.body?.targetUrl === "string") patch.targetUrl = req.body.targetUrl.trim() || undefined;
  if (typeof req.body?.archived === "boolean") patch.archived = req.body.archived || undefined;
  if (req.body?.workspaceDir !== undefined) {
    const workspace = validateWorkspaceDir(req.body.workspaceDir);
    if (workspace.error) {
      res.status(400).json({ error: workspace.error });
      return;
    }
    patch.workspaceDir = workspace.dir;
  }
  const next = updateProject(project.id, patch);
  res.json({ project: next ? withStats(next) : undefined });
});

projectsRouter.put("/projects/:id/context", (req, res) => {
  const project = getProject(req.params.id);
  if (!project || typeof req.body?.text !== "string") {
    res.status(project ? 400 : 404).json({ error: project ? "text wajib diisi" : "project tidak ditemukan" });
    return;
  }
  res.json({ text: writeContext(project.id, req.body.text) });
});

projectsRouter.put("/projects/:id/memory", (req, res) => {
  const project = getProject(req.params.id);
  if (!project || typeof req.body?.text !== "string") {
    res.status(project ? 400 : 404).json({ error: project ? "text wajib diisi" : "project tidak ditemukan" });
    return;
  }
  res.json({ text: writeProjectMemory(project.id, req.body.text) });
});

/** Hanya project kosong yang boleh dihapus — tugas tidak boleh jadi yatim. */
projectsRouter.delete("/projects/:id", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "project tidak ditemukan" });
    return;
  }
  const tasks = listTasks({ project: project.id });
  if (tasks.length > 0) {
    res.status(400).json({ error: `project masih punya ${tasks.length} tugas — pindahkan atau arsipkan dulu` });
    return;
  }
  if (listProjects().length <= 1) {
    res.status(400).json({ error: "harus ada minimal satu project" });
    return;
  }
  deleteProject(project.id);
  res.json({ ok: true });
});
