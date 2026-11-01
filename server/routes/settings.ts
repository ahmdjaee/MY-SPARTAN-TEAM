import { Router } from "express";
import { getSettings, updateSettings, type Settings } from "../settings.ts";

export const settingsRouter = Router();

settingsRouter.get("/settings", (_req, res) => {
  res.json(getSettings());
});

settingsRouter.put("/settings", (req, res) => {
  const body = req.body as Partial<Settings> | undefined;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "body tidak valid" });
    return;
  }
  res.json(updateSettings(body));
});
