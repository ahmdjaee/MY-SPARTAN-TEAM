/** Uji indikator aktivitas agen. Deterministik, tanpa model: bun run check:activity */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { toUiEvents } from "../server/agent/events.ts";
import { deriveActivity, formatElapsed, formatTokens, toolLabel } from "../web/activity.ts";
import type { StoredEvent, TaskStatus, WorkerStatus } from "../web/api.ts";

let failed = 0;
function expect(name: string, actual: unknown, wanted: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${ok ? "" : ` — dapat ${JSON.stringify(actual)}, harusnya ${JSON.stringify(wanted)}`}`);
}

let seq = 0;
const at = (event: Record<string, unknown>) =>
  ({ seq: ++seq, ts: `2026-11-06T00:00:${String(seq).padStart(2, "0")}.000Z`, taskId: "T", role: "engineer", ...event }) as StoredEvent;
const tool = (id: string, command = id) => at({ type: "tool", toolUseId: id, name: "Bash", input: { command } });
const done = (id: string) => at({ type: "tool_result", toolUseId: id, isError: false, preview: "" });
const result = () => at({ type: "result", subtype: "success", isError: false, durationMs: 1, numTurns: 1 });

const label = (status: WorkerStatus, events: StoredEvent[] = [], streaming = false, taskStatus?: TaskStatus) =>
  deriveActivity({ status, taskStatus, streaming, events })?.label;

const boundary = (compact_metadata: Record<string, unknown>) =>
  toUiEvents({ type: "system", subtype: "compact_boundary", compact_metadata } as unknown as SDKMessage);
expect("compact dipetakan", boundary({ trigger: "auto", pre_tokens: 974_123, post_tokens: 120_000 }), [
  { type: "compact", trigger: "auto", preTokens: 974_123, postTokens: 120_000 },
]);
expect("compact tanpa post_tokens", boundary({ trigger: "manual", pre_tokens: 5_000 }), [
  { type: "compact", trigger: "manual", preTokens: 5_000 },
]);
expect("format token", [950, 12_400, 620_000, 999_600, 1_000_000, 1_500_000].map(formatTokens), ["950", "12k", "620k", "1M", "1M", "1.5M"]);

expect("menunggu keputusan", label("waiting"), "Menunggu keputusan Anda");
expect("nada menunggu", deriveActivity({ status: "waiting", streaming: false, events: [] })?.tone, "waiting");
expect("menyiapkan", label("starting"), "Menyiapkan agen…");
expect("mengantre", label("idle", [], false, "queued"), "Mengantre giliran…");
expect("idle tanpa antrean tidak tampil", label("idle", [], false, "needs_review"), undefined);
expect("error tidak tampil", label("error"), undefined);
expect("berpikir saat tak ada sinyal", label("working"), "Berpikir…");
expect("menulis saat streaming", label("working", [], true), "Menulis jawaban…");

const running = tool("a", "bun run build\nbaris kedua");
expect("tool berjalan", label("working", [running]), "Menjalankan Bash…");
expect("waktu dari tool", deriveActivity({ status: "working", streaming: false, events: [running, at({ type: "notice", text: "x" })] })?.since, running.ts);
expect("tool mengalahkan streaming", label("working", [tool("b")], true), "Menjalankan Bash…");
expect("tool selesai → berpikir", label("working", [tool("c"), done("c")]), "Berpikir…");
expect("tool dari turn lalu tidak dihitung", label("working", [tool("d"), result()]), "Berpikir…");
expect("tool paralel", label("working", [tool("e"), tool("f")]), "Menjalankan Bash +1 lainnya…");
expect("satu dari paralel selesai", label("working", [tool("g"), tool("h"), done("h")]), "Menjalankan Bash…");

expect("label mcp", toolLabel("mcp__browser__screenshot"), "browser.screenshot");
expect("detik", formatElapsed(42_000), "42 dtk");
expect("menit", formatElapsed(185_000), "3 mnt");
expect("jam", formatElapsed(3_900_000), "1 jam 5 mnt");
expect("jam klien mundur", formatElapsed(-5_000), "0 dtk");

if (failed > 0) {
  console.error(`${failed} pengujian gagal`);
  process.exit(1);
}
console.log("Semua pengujian lulus.");
