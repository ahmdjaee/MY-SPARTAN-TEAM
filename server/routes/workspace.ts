import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import { workspaceForProject } from "../projects.ts";

const run = promisify(execFile);

export const workspaceRouter = Router();

async function git(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", dir, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
    });
    return stdout;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return err.stdout || err.stderr || err.message || "";
  }
}

workspaceRouter.get("/workspace/diff", async (req, res) => {
  // Workspace mengikuti project; tanpa parameter dipakai workspace bawaan.
  const dir = workspaceForProject(typeof req.query.project === "string" ? req.query.project : undefined);
  const isRepo = (await git(dir, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  if (!isRepo) {
    res.json({ isRepo: false, dir, status: "", diff: "", branch: "" });
    return;
  }
  const [status, diff, staged, branch] = await Promise.all([
    git(dir, ["status", "--porcelain=v1"]),
    git(dir, ["diff"]),
    git(dir, ["diff", "--staged"]),
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  res.json({ isRepo: true, dir, status, diff: `${staged}${diff}`, branch: branch.trim() });
});
