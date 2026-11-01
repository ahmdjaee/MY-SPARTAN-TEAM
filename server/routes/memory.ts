import { Router } from "express";
import { readMemory, writeMemory } from "../memory.ts";

export const memoryRouter = Router();

memoryRouter.get("/memory", (_req, res) => {
  res.json({ text: readMemory() });
});

memoryRouter.put("/memory", (req, res) => {
  if (typeof req.body?.text !== "string") {
    res.status(400).json({ error: "text wajib diisi" });
    return;
  }
  res.json({ text: writeMemory(req.body.text) });
});
