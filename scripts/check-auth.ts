/**
 * Fase 1 — bukti bahwa Agent SDK memakai sesi login Claude di mesin ini,
 * tanpa ANTHROPIC_API_KEY. Jalankan: npm run check:auth
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "../server/config.ts";

const started = Date.now();
console.log("ANTHROPIC_API_KEY di shell :", process.env.ANTHROPIC_API_KEY ? "ADA (akan diabaikan)" : "tidak ada");

const q = query({
  prompt: "Balas dengan tepat satu kata: OK",
  options: {
    maxTurns: 1,
    disallowedTools: ["*"],
    settingSources: [],
    persistSession: false,
    env: agentEnv(),
  },
});

try {
  const info = await q.accountInfo();
  console.log("accountInfo               :", JSON.stringify(info));
} catch (error) {
  console.log("accountInfo gagal         :", String(error));
}

try {
  for await (const message of q) {
    if (message.type === "system" && message.subtype === "init") {
      const init = message as unknown as Record<string, unknown>;
      console.log("session_id                :", init.session_id);
      console.log("model                     :", init.model);
      console.log("apiKeySource              :", init.apiKeySource ?? "(tidak dilaporkan)");
      console.log("claude_code_version       :", init.claude_code_version);
    }
    if (message.type === "result") {
      const result = message as unknown as Record<string, unknown>;
      console.log("subtype                   :", result.subtype);
      console.log("jawaban                   :", JSON.stringify(result.result));
      console.log("usage                     :", JSON.stringify(result.usage));
      console.log("total_cost_usd            :", result.total_cost_usd);
    }
  }
  console.log(`\nselesai dalam ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (error) {
  console.error("\nGAGAL:", error);
  process.exitCode = 1;
}
