import { Router } from "express";
import { askHub, type AskEvent } from "../agent/ask.ts";
import { CONFIG } from "../config.ts";
import { getTask } from "../tasks.ts";

export const askRouter = Router();

/** Model yang boleh dipakai panel Tanya: QA (murah) untuk tanya biasa, Engineer untuk analisis berat. */
const MODELS = [
  { id: CONFIG.models.qa, label: "Cepat & murah" },
  { id: CONFIG.models.engineer, label: "Analisis berat" },
];

askRouter.get("/tasks/:id/ask", (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  res.json({ ...askHub.state(req.params.id), models: MODELS });
});

askRouter.post("/tasks/:id/ask", async (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "text wajib diisi" });
    return;
  }
  const requested = typeof req.body?.model === "string" ? req.body.model : "";
  const model = MODELS.some((item) => item.id === requested) ? requested : MODELS[0]!.id;

  if (askHub.state(req.params.id).busy) {
    res.status(409).json({ error: "masih menjawab pertanyaan sebelumnya" });
    return;
  }
  try {
    const message = await askHub.ask(req.params.id, text, model);
    res.json({ message, state: askHub.state(req.params.id) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Aliran jawaban; tidak ada satu pun event di sini yang ditulis ke disk. */
askRouter.get("/tasks/:id/ask/events", (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const unsubscribe = askHub.subscribe(req.params.id, (event: AskEvent) =>
    res.write(`data: ${JSON.stringify(event)}\n\n`),
  );
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

askRouter.delete("/tasks/:id/ask", (req, res) => {
  if (!getTask(req.params.id)) {
    res.status(404).json({ error: "tugas tidak ditemukan" });
    return;
  }
  askHub.clear(req.params.id);
  res.json({ ok: true });
});
