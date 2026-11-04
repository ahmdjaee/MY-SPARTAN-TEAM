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
import { buildProjectRecap } from "../recap.ts";
import { renderFindingsMarkdown, renderReportMarkdown } from "../report-markdown.ts";
import { curator } from "../agent/curator.ts";
import {
  FINDING_STATUSES,
  canRevert,
  counts,
  mergeFinding,
  readCoverage,
  readLog,
  readRegister,
  readState,
  revertLog,
  setFindingStatus,
  unlinkedFindings,
  type FindingStatus,
  type Register,
} from "../findings.ts";
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

/**
 * Rekap project: laporan tiap tugas dipanen ulang dari disk setiap kali dipanggil.
 * Sengaja tanpa cache — tombol Sync di UI memang berarti "baca ulang berkasnya".
 */
projectsRouter.get("/projects/:id/recap", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "project tidak ditemukan" });
    return;
  }
  res.json(buildProjectRecap(project.id, { fresh: true }));
});

/**
 * Report utama project: kesimpulan, register temuan, cakupan, status kurator, dan
 * log kurasi. Rekap per tugas ikut sebagai lampiran.
 */
projectsRouter.get("/projects/:id/report", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "project tidak ditemukan" });
    return;
  }
  try {
    const register = readRegister(project.id);
    const recap = buildProjectRecap(project.id);
    res.json({
      projectId: project.id,
      generatedAt: new Date().toISOString(),
      state: readState(project.id),
      findings: register.findings,
      unlinked: unlinkedFindings(project.id, register, recap.entries),
      counts: counts(project.id, register),
      coverage: readCoverage(project.id),
      curator: curator.status(project.id),
      log: readLog(project.id, 40).map((entry) => ({
        at: entry.at,
        by: entry.by,
        action: entry.action,
        target: entry.target,
        detail: entry.detail,
        revertible: canRevert(entry),
      })),
      recap,
    });
  } catch (error) {
    // Register rusak tidak boleh diam-diam ditimpa; tampilkan sebabnya ke pemilik produk.
    res.status(500).json({ error: (error as Error).message });
  }
});

/** Route unduhan Markdown: nama berkas `<awalan>-<project>-<tanggal>.md`. */
function markdownDownload(path: string, prefix: string, render: (project: Project, register: Register) => string): void {
  projectsRouter.get(path, (req, res) => {
    const project = getProject(req.params.id as string);
    if (!project) {
      res.status(404).json({ error: "project tidak ditemukan" });
      return;
    }
    try {
      const markdown = render(project, readRegister(project.id));
      const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const safeId = project.id.replace(/[^A-Za-z0-9_-]+/g, "-");
      // sv-SE memberi YYYY-MM-DD menurut zona waktu server.
      const date = new Date().toLocaleDateString("sv-SE");
      res.attachment(`${prefix}-${slug || safeId}-${date}.md`);
      res.type("text/markdown").send(markdown);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
}

/** Report lengkap: sama dengan isi tab Report, tanpa log kurasi. */
markdownDownload("/projects/:id/report.md", "report", (project, register) =>
  renderReportMarkdown({
    project,
    generatedAt: new Date().toISOString(),
    state: readState(project.id),
    findings: register.findings,
    counts: counts(project.id, register),
    coverage: readCoverage(project.id),
    recap: buildProjectRecap(project.id),
  }),
);

/** Temuan saja: Ringkasan dan register, tanpa kesimpulan, cakupan, lampiran, dan daftar pelapor. */
markdownDownload("/projects/:id/findings.md", "temuan", (project, register) =>
  renderFindingsMarkdown({
    project,
    generatedAt: new Date().toISOString(),
    findings: register.findings,
    counts: counts(project.id, register),
  }),
);

/** Sync = jalankan kurator sekarang (tanpa jeda), walaupun tidak ada sumber baru. */
projectsRouter.post("/projects/:id/curate", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "project tidak ditemukan" });
    return;
  }
  void curator.run(project.id, true);
  res.json({ ok: true, curator: { ...curator.status(project.id), running: true } });
});

/** Koreksi pemilik produk atas register: ubah status (wajib alasan untuk penutupan) atau gabungkan duplikat. */
projectsRouter.patch("/projects/:id/findings/:fid", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "project tidak ditemukan" });
    return;
  }
  try {
    if (typeof req.body?.mergeInto === "string" && req.body.mergeInto.trim()) {
      const target = mergeFinding(project.id, req.params.fid, req.body.mergeInto, "owner");
      res.json({ ok: true, finding: target });
      return;
    }
    const status = req.body?.status as FindingStatus;
    if (!FINDING_STATUSES.includes(status)) {
      res.status(400).json({ error: "status tidak dikenal" });
      return;
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    const finding = setFindingStatus(project.id, req.params.fid, status, note ? { by: "owner", note } : undefined, "owner", {
      verified: req.body?.verified === true,
    });
    res.json({ ok: true, finding });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

projectsRouter.post("/projects/:id/curation-log/revert", (req, res) => {
  const project = getProject(req.params.id);
  if (!project || typeof req.body?.at !== "string") {
    res.status(project ? 400 : 404).json({ error: project ? "at wajib diisi" : "project tidak ditemukan" });
    return;
  }
  try {
    const detail = revertLog(
      project.id,
      req.body.at,
      "owner",
      (text) => writeProjectMemory(project.id, text),
      () => readProjectMemory(project.id),
      {
        action: typeof req.body.action === "string" ? req.body.action : undefined,
        target: typeof req.body.target === "string" ? req.body.target : undefined,
      },
    );
    res.json({ ok: true, detail });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
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
