import { Router } from "express";
import { scheduler } from "../agent/scheduler.ts";
import type { ApprovalDecision } from "../agent/runner.ts";

export const approvalsRouter = Router();

approvalsRouter.post("/approvals/:id", (req, res) => {
  const runner = scheduler.findRunnerWithRequest(req.params.id);
  if (!runner) {
    res.status(404).json({ error: "approval tidak ditemukan atau sudah kedaluwarsa" });
    return;
  }
  const decision: ApprovalDecision = {
    decision: req.body?.decision === "allow" ? "allow" : "deny",
    message: typeof req.body?.message === "string" ? req.body.message : undefined,
    remember: req.body?.remember === true,
  };
  runner.resolveRequest(req.params.id, decision);
  res.json({ ok: true });
});

approvalsRouter.post("/questions/:id", (req, res) => {
  const runner = scheduler.findRunnerWithRequest(req.params.id);
  if (!runner) {
    res.status(404).json({ error: "pertanyaan tidak ditemukan atau sudah kedaluwarsa" });
    return;
  }
  const answers = typeof req.body?.answers === "object" && req.body.answers ? req.body.answers : {};
  runner.resolveRequest(req.params.id, answers);
  res.json({ ok: true });
});
