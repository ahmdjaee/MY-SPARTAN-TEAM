import { Router } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "../config.ts";
import { scheduler } from "../agent/scheduler.ts";

export const healthRouter = Router();

type Account = { email?: string; organization?: string; subscriptionType?: string; apiProvider?: string; apiKeySource?: string };

let cache: { at: number; account: Account | null; error?: string } | undefined;

/** Menanyakan identitas yang dipakai SDK — bukti bahwa sesi login Claude terpakai. */
healthRouter.get("/health/auth", async (_req, res) => {
  if (cache && Date.now() - cache.at < 60_000) {
    res.json({ ...cache, slots: scheduler.stats(), cached: true });
    return;
  }
  const instance = query({
    prompt: "noop",
    options: { disallowedTools: ["*"], settingSources: [], persistSession: false, env: agentEnv() },
  });
  try {
    const account = (await instance.accountInfo()) as Account;
    cache = { at: Date.now(), account };
    res.json({ ...cache, slots: scheduler.stats(), cached: false });
  } catch (error) {
    cache = { at: Date.now(), account: null, error: error instanceof Error ? error.message : String(error) };
    res.status(500).json({ ...cache, slots: scheduler.stats() });
  } finally {
    try {
      instance.close();
    } catch {
      // proses mungkin sudah berhenti
    }
  }
});
