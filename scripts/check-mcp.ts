/** Pastikan MCP browser in-process terhubung dan tool-nya terdaftar untuk QA. */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { BrowserSession, createBrowserServer } from "../server/browser/mcp.ts";
import { agentEnv } from "../server/config.ts";
import { ROLES } from "../server/roles.ts";

const q = query({
  prompt: "Balas satu kata: OK",
  options: {
    model: "claude-haiku-5-5",
    maxTurns: 1,
    settingSources: [],
    persistSession: false,
    mcpServers: { browser: createBrowserServer(new BrowserSession(() => undefined), () => undefined) },
    settings: { permissions: ROLES.qa.permissions },
    env: agentEnv(),
  },
});

for await (const message of q) {
  if (message.type === "system" && message.subtype === "init") {
    console.log("mcp servers :", message.mcp_servers.map((s) => `${s.name}=${s.status}`).join(", "));
    console.log("tool mcp    :", message.tools.filter((tool) => tool.startsWith("mcp__")).join(", "));
  }
  if (message.type === "result") console.log("hasil       :", message.subtype);
}
