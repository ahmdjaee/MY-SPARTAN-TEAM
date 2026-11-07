/**
 * Hitung ulang biaya tugas lama dari thread.jsonl.
 *
 * Dulu setiap result menambahkan `total_cost_usd` ke biaya tugas, padahal angka itu total BERJALAN
 * per sesi (dan sesi yang di-resume melanjutkan totalnya). Akibatnya biaya tercatat berlipat.
 * Skrip ini menelusuri ulang result per sesi dengan aturan yang sama seperti `recordSessionCost`:
 * total 0 (result crash) dilewati, total yang turun dianggap reset (/clear), dan tanda per sesi
 * dibawa lintas resume.
 *
 *   bun run fix:costs              # dry-run: tabel biaya lama → baru, tidak menulis apa pun
 *   bun run fix:costs -- --apply   # tulis; menolak jalan selama server masih hidup
 *
 * Yang ditulis hanya task.json (`costUsd`, `assignments[].costUsd`, `assignments[].costMark`), dengan
 * cadangan `task.json.bak-costs-<waktu>` di sebelahnya. thread.jsonl tidak pernah ditulis.
 *
 * Penugasan yang sudah punya `costMark` (dicatat server baru, atau hasil jalan sebelumnya) tidak disentuh:
 * result dari sesi yang sudah ditutup ikut dicatat server tapi tidak masuk transcript, jadi menghitung
 * ulang dari transcript justru menurunkan angka yang sudah benar. Aman dijalankan ulang kapan saja.
 * `askCostUsd` (panel Tanya) tidak bisa dihitung ulang karena jawabannya tidak disimpan — dibiarkan.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../server/config.ts";

type Assignment = { role: string; sessionId?: string; costUsd: number; costMark?: { sessionId: string; totalUsd: number } };
type TaskFile = { id: string; title: string; costUsd: number; assignments: Assignment[] };
type Event = { type: string; sessionId?: string; costUsd?: number };

const apply = process.argv.includes("--apply");
const round = (value: number): number => Number(value.toFixed(6));
const money = (value: number): string => `$${value.toFixed(2)}`;

type Plan = {
  id: string;
  title: string;
  before: number;
  after: number;
  /** Penugasan yang biayanya dipertahankan karena tidak ada result di transcript. */
  kept: number;
  /** Penugasan yang sudah dicatat dengan cara baru (punya costMark) — dipertahankan. */
  marked: number;
  assignments: Array<{ costUsd: number; costMark?: { sessionId: string; totalUsd: number } }>;
};

function recompute(task: TaskFile, events: Event[]): Plan | string {
  const handoffs = events.filter((event) => event.type === "handoff").length;
  if (handoffs !== task.assignments.length - 1) {
    return `${handoffs} oper di transcript, ${task.assignments.length} penugasan di task.json`;
  }
  const costs = task.assignments.map(() => 0);
  /** Penugasan yang punya result berbiaya di transcript; sisanya (mis. migrasi v1 tanpa thread) tidak disentuh. */
  const seen = task.assignments.map(() => false);
  /** Total berjalan terakhir per sesi — sama dengan costMark di recordSessionCost. */
  const marks = new Map<string, number>();
  /** Sesi terakhir yang tercatat per penugasan, untuk costMark. */
  const lastSession = task.assignments.map((assignment) => assignment.sessionId);
  let position = 0;
  let session: string | undefined;

  for (const event of events) {
    if (event.type === "handoff") {
      position += 1;
      session = undefined;
      continue;
    }
    if (event.type === "init" && event.sessionId) {
      session = event.sessionId;
      continue;
    }
    if (event.type !== "result") continue;
    const total = event.costUsd;
    if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) continue;
    const key = session ?? `?${position}`;
    const mark = marks.get(key);
    const delta = mark === undefined || total < mark ? total : total - mark;
    marks.set(key, total);
    // Atribusi lewat sessionId kalau penugasannya diketahui; selain itu urutan oper.
    const owner = session ? task.assignments.findLastIndex((assignment) => assignment.sessionId === session) : -1;
    const index = owner >= 0 ? owner : Math.min(position, costs.length - 1);
    costs[index] = (costs[index] ?? 0) + delta;
    seen[index] = true;
    if (session) lastSession[index] = session;
  }

  const assignments = task.assignments.map((assignment, index) => {
    if (!seen[index] || assignment.costMark) {
      return { costUsd: assignment.costUsd ?? 0, ...(assignment.costMark ? { costMark: assignment.costMark } : {}) };
    }
    const sessionId = lastSession[index];
    const totalUsd = sessionId ? marks.get(sessionId) : undefined;
    return {
      costUsd: round(costs[index] ?? 0),
      ...(sessionId && totalUsd !== undefined ? { costMark: { sessionId, totalUsd } } : {}),
    };
  });
  return {
    id: task.id,
    title: task.title,
    kept: seen.filter((value, index) => !value && (task.assignments[index]?.costUsd ?? 0) > 0).length,
    marked: task.assignments.filter((assignment, index) => seen[index] && assignment.costMark).length,
    before: task.costUsd,
    after: round(assignments.reduce((sum, assignment) => sum + assignment.costUsd, 0)),
    assignments,
  };
}

function readEvents(path: string): Event[] {
  if (!existsSync(path)) return [];
  const events: Event[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as Event);
    } catch {
      // baris rusak dilewati, sama seperti ThreadStore
    }
  }
  return events;
}

async function serverIsUp(): Promise<boolean> {
  const host = CONFIG.host === "0.0.0.0" || CONFIG.host === "::" ? "127.0.0.1" : CONFIG.host;
  try {
    await fetch(`http://${host}:${CONFIG.port}/api/roles`, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

if (apply && (await serverIsUp())) {
  console.error(
    `Server masih hidup di ${CONFIG.host}:${CONFIG.port}. Hentikan dulu (systemctl --user stop ai-team) —` +
      " kalau tidak, server menimpa task.json dengan angka lama begitu ada result berikutnya.",
  );
  process.exit(1);
}

const plans: Plan[] = [];
const skipped: string[] = [];
const dirs = existsSync(CONFIG.tasksDir)
  ? readdirSync(CONFIG.tasksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  : [];
for (const entry of dirs) {
  const dir = join(CONFIG.tasksDir, entry.name);
  const metaPath = join(dir, "task.json");
  if (!existsSync(metaPath)) continue;
  let task: TaskFile;
  try {
    task = JSON.parse(readFileSync(metaPath, "utf8")) as TaskFile;
  } catch (error) {
    skipped.push(`${entry.name}: task.json rusak (${(error as Error).message})`);
    continue;
  }
  if (!Array.isArray(task.assignments) || task.assignments.length === 0) continue;
  const plan = recompute(task, readEvents(join(dir, "thread.jsonl")));
  if (typeof plan === "string") skipped.push(`${task.id}: dilewati — ${plan}`);
  else plans.push(plan);
}

plans.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
/** Yang ditulis hanya tugas yang angkanya atau tandanya benar-benar berubah — jalan kedua tidak menulis apa pun. */
const signature = (assignments: Array<{ costUsd?: number; costMark?: unknown }>): string =>
  JSON.stringify(assignments.map((assignment) => [round(assignment.costUsd ?? 0), assignment.costMark ?? null]));
const originals = new Map<string, TaskFile>();
for (const plan of plans) {
  originals.set(plan.id, JSON.parse(readFileSync(join(CONFIG.tasksDir, plan.id, "task.json"), "utf8")) as TaskFile);
}
const changed = plans.filter((plan) => {
  const original = originals.get(plan.id)!;
  return Math.abs(original.costUsd - plan.after) > 0.000001 || signature(original.assignments) !== signature(plan.assignments);
});

console.log(`Tugas      ${"lama".padStart(10)} → ${"baru".padEnd(10)}  judul`);
for (const plan of plans) {
  if (Math.abs(plan.before - plan.after) <= 0.000001) continue;
  const ratio = plan.after > 0 ? ` (${(plan.before / plan.after).toFixed(1)}×)` : "";
  console.log(
    `${plan.id.padEnd(10)} ${money(plan.before).padStart(10)} → ${money(plan.after).padEnd(10)}  ${plan.title.slice(0, 50)}${ratio}`,
  );
}
const before = plans.reduce((sum, plan) => sum + plan.before, 0);
const after = plans.reduce((sum, plan) => sum + plan.after, 0);
console.log(`\nTotal ${plans.length} tugas: ${money(before)} → ${money(after)}`);
for (const line of skipped) console.log(`  ${line}`);
for (const plan of plans.filter((item) => item.kept > 0)) {
  console.log(`  ${plan.id}: ${plan.kept} penugasan tanpa result di transcript — biaya lamanya dipertahankan`);
}
const marked = plans.reduce((sum, plan) => sum + plan.marked, 0);
if (marked > 0) console.log(`  ${marked} penugasan sudah dicatat dengan cara baru (costMark) — tidak dihitung ulang`);

if (!apply) {
  console.log(`\nDry-run: ${changed.length} task.json akan ditulis. Jalankan dengan \`-- --apply\` setelah server dihentikan.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let written = 0;
for (const plan of changed) {
  const metaPath = join(CONFIG.tasksDir, plan.id, "task.json");
  const task = JSON.parse(readFileSync(metaPath, "utf8")) as TaskFile;
  task.costUsd = plan.after;
  task.assignments = task.assignments.map((assignment, index) => {
    const next = plan.assignments[index]!;
    const { costMark: _old, ...rest } = assignment;
    return { ...rest, costUsd: next.costUsd, ...(next.costMark ? { costMark: next.costMark } : {}) };
  });
  copyFileSync(metaPath, `${metaPath}.bak-costs-${stamp}`);
  const tmp = `${metaPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(task, null, 2));
  renameSync(tmp, metaPath);
  written += 1;
}
console.log(`\n${written} task.json ditulis; cadangan: task.json.bak-costs-${stamp}`);
