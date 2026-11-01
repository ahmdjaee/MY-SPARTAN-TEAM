import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { workspaceForTask } from "../context.ts";
import { CATEGORY_LABEL, classifyCommand } from "../policy.ts";
import { taskDir } from "../tasks.ts";

/**
 * Pagar keras sebagai PreToolUse hook.
 *
 * Hook berjalan sebelum deny/ask/allow dan sebelum permission mode, jadi inilah
 * satu-satunya tempat yang bisa menilai isi `ssh host '…'` secara utuh — dan
 * satu-satunya yang tetap berlaku ketika tugas dijalankan dalam mode auto.
 */
export function guardHooks(taskId: string): Partial<Record<"PreToolUse", HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          async (input) => {
            const command = (input as { tool_input?: { command?: unknown } }).tool_input?.command;
            if (typeof command !== "string") return {};

            const verdict = classifyCommand(command, {
              // Workspace project tugas ini — bukan workspace global.
              workspaceDir: workspaceForTask(taskId),
              taskDir: taskDir(taskId),
            });
            if (verdict.decision === "pass") return {};

            const label = verdict.category ? ` · ${CATEGORY_LABEL[verdict.category]}` : "";
            const head = verdict.decision === "deny" ? "Ditolak pagar keras" : "Perlu persetujuan owner";
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: verdict.decision,
                permissionDecisionReason: `${head}${label}: ${verdict.reason}.`,
              },
            };
          },
        ],
      },
    ],
  };
}
