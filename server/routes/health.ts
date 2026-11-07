import { Router } from "express";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "../config.ts";
import { scheduler } from "../agent/scheduler.ts";

export const healthRouter = Router();

type Account = { email?: string; organization?: string; subscriptionType?: string; apiProvider?: string; apiKeySource?: string };
type Result = { at: number; account: Account | null; error?: string };

/** Identitas sesi jarang berubah; tiap pemeriksaan menjalankan subprocess Claude Code. */
const CACHE_MS = 10 * 60_000;

let cache: Result | undefined;
let inflight: Promise<Result> | undefined;

/** Prompt yang tidak pernah mengirim pesan: subprocess cukup untuk accountInfo(), tanpa panggilan model. */
async function* silent(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function check(): Promise<Result> {
  const stop = new AbortController();
  const instance = query({
    prompt: silent(stop.signal),
    options: { disallowedTools: ["*"], settingSources: [], persistSession: false, env: agentEnv() },
  });
  try {
    return { at: Date.now(), account: (await instance.accountInfo()) as Account };
  } catch (error) {
    return { at: Date.now(), account: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    stop.abort();
    try {
      instance.close();
    } catch {
      // proses mungkin sudah berhenti
    }
  }
}

/** Menanyakan identitas yang dipakai SDK — bukti bahwa sesi login Claude terpakai. */
healthRouter.get("/health/auth", async (req, res) => {
  const fresh = req.query.fresh === "1";
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) {
    res.status(cache.account ? 200 : 500).json({ ...cache, slots: scheduler.stats(), cached: true });
    return;
  }
  // Permintaan yang datang bersamaan berbagi satu subprocess.
  inflight ??= check().finally(() => {
    inflight = undefined;
  });
  const result = await inflight;
  // Kegagalan tidak di-cache lama: sesi yang baru login harus segera terlihat.
  cache = result.account ? result : { ...result, at: Date.now() - CACHE_MS + 60_000 };
  res.status(result.account ? 200 : 500).json({ ...result, slots: scheduler.stats(), cached: false });
});
