/**
 * Uji siklus hidup runner: biaya per sesi, Stop, turn yang dimulai CLI, Query basi, dan panel Tanya.
 * Deterministik, tanpa model dan tanpa menyentuh data asli: bun run check:runner
 *
 * Query SDK diganti tiruan (async iterable) yang meniru perilaku pentingnya: pesan dari prompt
 * stream dikonsumsi, result membawa total biaya berjalan sesi + echo uuid pesan, dan pesan yang
 * sudah tertahan di buffer tetap keluar setelah close().
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STOP_GRACE_MS = 80;
const sandbox = mkdtempSync(join(tmpdir(), "ai-team-runner-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");
process.env.STOP_GRACE_MS = String(STOP_GRACE_MS);

const { addAssignment, createTask, getTask, loadTasks, patchAssignment, recordSessionCost, updateTask } = await import(
  "../server/tasks.ts"
);
const { TaskRunner } = await import("../server/agent/runner.ts");
const { Semaphore } = await import("../server/agent/semaphore.ts");
const { bus } = await import("../server/agent/bus.ts");
const { scheduler } = await import("../server/agent/scheduler.ts");
const { AskSession } = await import("../server/agent/ask.ts");
const { workspaceForTask } = await import("../server/context.ts");
const { createProject } = await import("../server/projects.ts");
import type { TurnOutcome } from "../server/agent/runner.ts";
import type { AttentionEvent, StoredEvent } from "../server/types.ts";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Query tiruan ----------

type Sent = { uuid?: string; text: string };

function fakeQuery(owner: Record<string, any>, options: { holdOnClose?: boolean } = {}) {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;
  const sent: Sent[] = [];
  const calls = { interrupt: 0, close: 0, cancelQueued: false };
  let receipt: (sent: Sent[]) => unknown = () => ({ still_queued: [] });
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const end = () => {
    ended = true;
    notify();
  };
  const q = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<unknown>> {
      for (;;) {
        // Seperti SDK: pesan yang sudah tertahan tetap keluar walau close() sudah dipanggil.
        if (queue.length > 0) return { value: queue.shift(), done: false };
        if (failure) {
          const error = failure;
          failure = undefined;
          ended = true;
          throw error;
        }
        if (ended) return { value: undefined, done: true };
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    async return(): Promise<IteratorResult<unknown>> {
      ended = true;
      return { value: undefined, done: true };
    },
    interrupt: async (options?: { cancelQueued?: boolean }) => {
      calls.interrupt += 1;
      calls.cancelQueued = options?.cancelQueued === true;
      return receipt(sent);
    },
    close: () => {
      calls.close += 1;
      if (!options.holdOnClose) end();
    },
    getContextUsage: async () => ({ totalTokens: 1, maxTokens: 100, percentage: 1 }),
    setPermissionMode: async () => undefined,
    setModel: async () => undefined,
  };
  // SDK membaca prompt stream terus-menerus; di sini isinya dicatat supaya bisa diperiksa.
  void (async () => {
    for await (const message of owner.input()) sent.push({ uuid: message.uuid, text: String(message.message.content) });
  })();
  return {
    q,
    sent,
    calls,
    push: (...messages: unknown[]) => {
      queue.push(...messages);
      notify();
    },
    end,
    fail: (error: Error) => {
      failure = error;
      notify();
    },
    /** Kuitansi interrupt berikutnya, mis. pesan yang dibatalkan CLI (`cancelled`). */
    setReceipt: (fn: (sent: Sent[]) => unknown) => {
      receipt = fn;
    },
  };
}
type Fake = ReturnType<typeof fakeQuery>;

const init = (sessionId: string) => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model: "m",
  permissionMode: "default",
  apiKeySource: "none",
  tools: [],
  mcp_servers: [],
});
const text = (value: string) => ({ type: "assistant", message: { content: [{ type: "text", text: value }] } });
let toolCounter = 0;
const tool = (name = "Bash") => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: `tu-${++toolCounter}`, name, input: {} }] },
});
type ResultOptions = {
  sessionId: string;
  total: number;
  uuids?: string[];
  queued?: number;
  subtype?: string;
  isError?: boolean;
  turns?: number;
};
const result = (o: ResultOptions) => ({
  type: "result",
  subtype: o.subtype ?? "success",
  is_error: o.isError ?? false,
  duration_ms: 1,
  num_turns: o.turns ?? 1,
  total_cost_usd: o.total,
  session_id: o.sessionId,
  ...(o.uuids ? { user_message_uuids: o.uuids, user_message_uuid: o.uuids.at(-1) } : {}),
  ...(o.queued !== undefined ? { queued_turn_count: o.queued } : {}),
});

function fakeLock() {
  let held = false;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<() => void> => {
    if (held) await new Promise<void>((resolve) => waiters.push(resolve));
    held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) next();
      else held = false;
    };
  };
  return { acquire, isHeld: () => held };
}

const newTask = () => createTask({ title: "uji", description: "uji", role: "engineer", projectId: "P-uji" });

/** Runner sungguhan dengan hook yang tersambung ke tasks.ts; query() diganti Query tiruan. */
async function harness(
  options: { slots?: number; lock?: ReturnType<typeof fakeLock>; sessionId?: string; taskId?: string; holdOnClose?: boolean } = {},
) {
  const task = options.taskId ? getTask(options.taskId)! : newTask();
  const slots = new Semaphore(options.slots ?? 1);
  const outcomes: TurnOutcome[] = [];
  const events: StoredEvent[] = [];
  const unsubscribe = bus.subscribe(task.id, (event) => events.push(event));
  const fakes: Fake[] = [];
  const lock = options.lock;
  const lockDirs: string[] = [];
  const runner = new TaskRunner(
    task.id,
    "engineer",
    {
      acquire: () => slots.acquire(),
      ...(lock
        ? {
            lockWorkspace: (_role: unknown, dir: string) => {
              lockDirs.push(dir);
              return lock.acquire();
            },
          }
        : {}),
      onStatus: () => undefined,
      onSession: (taskId, sessionId) => {
        patchAssignment(taskId, { sessionId });
      },
      onCost: (taskId, sessionId, totalUsd, costOptions) => recordSessionCost(taskId, sessionId, totalUsd, costOptions),
      onTurnEnd: (_taskId, outcome) => {
        outcomes.push(outcome);
      },
      onIdleShutdown: () => undefined,
      onContext: () => undefined,
    },
    options.sessionId,
  ) as never as Record<string, any>;
  // Sama seperti ensureStarted asli, tapi tanpa proses Claude Code.
  runner.ensureStarted = () => {
    if (runner.q || runner.closed) return;
    runner.generation += 1;
    runner.wake?.();
    const fake = fakeQuery(runner, { holdOnClose: options.holdOnClose });
    runner.q = fake.q;
    void runner.consume(fake.q);
    fakes.push(fake);
  };
  return {
    task,
    runner,
    slots,
    outcomes,
    events,
    fakes,
    lockDirs,
    current: () => fakes.at(-1)!,
    results: () => events.filter((event): event is Extract<StoredEvent, { type: "result" }> => event.type === "result"),
    done: async () => {
      await runner.close();
      unsubscribe();
    },
  };
}

// ---------- R1: biaya = selisih total berjalan sesi ----------
{
  const h = await harness();
  const id = h.task.id;
  h.runner.send("pertama");
  await tick();
  const f = h.current();
  f.push(init("S1"), result({ sessionId: "S1", total: 1.0, uuids: [f.sent[0]!.uuid!] }));
  await tick();
  const turn = async (total: number, extra: Partial<ResultOptions> = {}) => {
    h.runner.send(`pesan ${total}`);
    await tick();
    f.push(result({ sessionId: "S1", total, uuids: [f.sent.at(-1)!.uuid!], ...extra }));
    await tick();
  };
  await turn(2.5);
  // Result tanpa model dari CLI mengulang total yang sama; result crash bernilai 0.
  f.push(result({ sessionId: "S1", total: 2.5, turns: 0 }));
  await tick();
  await turn(0, { subtype: "error_during_execution", isError: true });
  await turn(3.0);
  const costs = h.results().map((event) => event.turnCostUsd);
  check("R1 biaya per turn = selisih total sesi", JSON.stringify(costs) === "[1,1.5,0,0,0.5]", costs);
  const afterFirst = getTask(id)!;
  check(
    "R1 biaya tugas = total sesi terakhir, tanda tidak turun karena result 0",
    afterFirst.costUsd === 3 && afterFirst.assignments[0]?.costMark?.totalUsd === 3,
    { costUsd: afterFirst.costUsd, mark: afterFirst.assignments[0]?.costMark },
  );
  await h.done();

  // Server dimulai ulang: indeks dibaca dari disk dan sesi di-resume dengan total yang tersimpan.
  loadTasks();
  const resumed = await harness({ taskId: id, sessionId: "S1" });
  resumed.runner.send("lanjut");
  await tick();
  const g = resumed.current();
  g.push(init("S1"), result({ sessionId: "S1", total: 3.6, uuids: [g.sent[0]!.uuid!] }));
  await tick();
  check("R1 setelah resume hanya selisihnya yang ditambah", getTask(id)!.costUsd === 3.6, getTask(id)!.costUsd);
  resumed.runner.send("/clear lalu lanjut");
  await tick();
  g.push(result({ sessionId: "S1", total: 0.2, uuids: [g.sent[1]!.uuid!] }));
  await tick();
  check("R1 total yang turun = sesi di-reset", getTask(id)!.costUsd === 3.8, getTask(id)!.costUsd);
  await resumed.done();

  // Oper: penugasan baru punya sesi baru, biayanya masuk ke penugasan itu.
  addAssignment(id, "engineer");
  const next = await harness({ taskId: id });
  next.runner.send("baru");
  await tick();
  const k = next.current();
  k.push(init("S2"), result({ sessionId: "S2", total: 0.7, uuids: [k.sent[0]!.uuid!] }));
  await tick();
  const afterHandoff = getTask(id)!;
  check(
    "R1 sesi baru dicatat di penugasannya sendiri",
    afterHandoff.assignments[1]?.costUsd === 0.7 && afterHandoff.assignments[0]?.costUsd === 3.8 && afterHandoff.costUsd === 4.5,
    afterHandoff.assignments.map((assignment) => assignment.costUsd),
  );
  await next.done();
}
{
  // Penugasan dari sebelum perbaikan: biayanya sudah dijumlah cara lama dan belum punya tanda.
  const task = newTask();
  patchAssignment(task.id, { sessionId: "L1", costUsd: 5 });
  updateTask(task.id, { costUsd: 5 });
  const first = recordSessionCost(task.id, "L1", 7);
  const second = recordSessionCost(task.id, "L1", 8);
  check(
    "R1 penugasan lama: tanda dipasang tanpa menghitung ulang",
    first === 0 && second === 1 && getTask(task.id)!.costUsd === 6,
    { first, second, costUsd: getTask(task.id)!.costUsd },
  );
}

// ---------- R2: turn yang dimulai CLI tidak menutup turn kita ----------
{
  const h = await harness();
  h.runner.send("deploy ulang");
  await tick();
  const f = h.current();
  const mine = f.sent[0]!.uuid!;
  // Pola T-038: notifikasi Bash background dijalankan CLI duluan → result tanpa model, tanpa uuid kita.
  f.push(init("S3"), result({ sessionId: "S3", total: 1.7, queued: 1, turns: 0 }));
  await tick();
  check(
    "R2 result turn CLI tidak menutup turn kita",
    h.outcomes.length === 0 && h.slots.inUse === 1 && h.runner.status === "working",
    { outcomes: h.outcomes.length, inUse: h.slots.inUse, status: h.runner.status },
  );
  check("R2 result itu ditandai dimulai CLI", h.results().at(-1)?.background === true);
  f.push(tool(), text("selesai deploy"), result({ sessionId: "S3", total: 4.4, uuids: [mine], turns: 19 }));
  await tick();
  check("R2 result ber-uuid kita menutup turn", h.outcomes.length === 1 && h.slots.inUse === 0);
  check("R2 biaya tidak dihitung dua kali", getTask(h.task.id)!.costUsd === 4.4, getTask(h.task.id)!.costUsd);
  await h.done();
}
{
  // CLI lama tanpa echo uuid: pakai queued_turn_count.
  const h = await harness();
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S4"), result({ sessionId: "S4", total: 1, queued: 1, turns: 0 }));
  await tick();
  check("R2 tanpa echo: queued > 0 bukan akhir turn kita", h.outcomes.length === 0);
  f.push(result({ sessionId: "S4", total: 2, queued: 0 }));
  await tick();
  check("R2 tanpa echo: queued 0 menutup turn", h.outcomes.length === 1 && h.slots.inUse === 0);
  await h.done();
}
{
  // CLI bekerja sendiri saat runner idle: tampil sebagai kerja, lalu dilaporkan sebagai background.
  const h = await harness();
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S5"), result({ sessionId: "S5", total: 1, uuids: [f.sent[0]!.uuid!] }));
  await tick();
  f.push(tool(), text("menindaklanjuti job background"));
  await tick();
  check("R2 turn yang dimulai CLI tampil sebagai kerja", h.runner.status === "working", h.runner.status);
  f.push(result({ sessionId: "S5", total: 1.4, turns: 2 }));
  await tick();
  check(
    "R2 akhir turn CLI dilaporkan sebagai background",
    h.outcomes.length === 2 && h.outcomes[1]?.background === true && h.runner.status === "idle",
    { outcomes: h.outcomes, status: h.runner.status },
  );
  await h.done();
}

// ---------- R3: Stop bukan kegagalan ----------
{
  const h = await harness();
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S6"));
  await tick();
  await h.runner.interrupt();
  check("R3 Stop memanggil interrupt SDK", f.calls.interrupt === 1);
  f.push(
    result({ sessionId: "S6", total: 0.3, uuids: [f.sent[0]!.uuid!], subtype: "error_during_execution", isError: true }),
  );
  await tick();
  check(
    "R3 result setelah Stop ditandai dihentikan",
    h.outcomes[0]?.interrupted === true && h.results().at(-1)?.interrupted === true,
    h.outcomes,
  );
  await h.done();
}
{
  const task = newTask();
  patchAssignment(task.id, { summary: "ringkasan lama" });
  updateTask(task.id, { status: "running" });
  const seen: AttentionEvent[] = [];
  const off = bus.subscribeAll((event) => seen.push(event));
  const onTurnEnd = (outcome: TurnOutcome) => (scheduler as never as Record<string, any>).onTurnEnd(task.id, outcome);
  onTurnEnd({ subtype: "error_during_execution", isError: true, interrupted: true, lastText: "terpotong" });
  const stopped = getTask(task.id)!;
  check(
    "R3 Stop → perlu dibaca tanpa notifikasi",
    seen[0]?.kind === "needs_review" && seen[0]?.silent === true && stopped.status === "needs_review",
    { attention: seen[0], status: stopped.status },
  );
  check("R3 ringkasan tidak ditimpa turn yang dihentikan", stopped.assignments.at(-1)?.summary === "ringkasan lama");
  onTurnEnd({ subtype: "error_during_execution", isError: true, lastText: "" });
  check("R3 error biasa tetap gagal", seen[1]?.kind === "failed" && !seen[1]?.silent && getTask(task.id)!.status === "failed");
  updateTask(task.id, { status: "running" });
  onTurnEnd({ subtype: "success", isError: false, followUp: true, lastText: "lanjut" });
  check(
    "R3 pesan berikutnya langsung jalan: tanpa notifikasi, status tidak berubah",
    seen[2]?.silent === true && getTask(task.id)!.status === "running",
    { attention: seen[2], status: getTask(task.id)!.status },
  );
  off();
}

// ---------- R4: pesan yang dikirim tepat setelah Stop ----------
{
  const h = await harness();
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S7"));
  await tick();
  await h.runner.interrupt();
  h.runner.send("b");
  await tick();
  check("R4 pesan baru menunggu result turn yang dihentikan", f.sent.length === 1, f.sent);
  f.push(
    result({ sessionId: "S7", total: 0.5, uuids: [f.sent[0]!.uuid!], subtype: "error_during_execution", isError: true }),
  );
  await tick();
  check("R4 turn lama berakhir sebagai dihentikan", h.outcomes[0]?.interrupted === true && h.outcomes[0]?.followUp === true);
  check(
    "R4 pesan baru jalan dengan slotnya sendiri",
    f.sent.length === 2 && f.sent[1]?.text === "b" && h.slots.inUse === 1 && h.runner.status === "working",
    { sent: f.sent, inUse: h.slots.inUse, status: h.runner.status },
  );
  await h.done();
}

// ---------- R5: pump yang basi tidak melepas slot milik pump baru ----------
{
  const h = await harness({ slots: 2 });
  const holderA = await h.slots.acquire();
  const holderB = await h.slots.acquire();
  h.runner.send("a");
  await tick();
  await h.runner.interrupt();
  h.runner.send("b");
  await tick();
  holderA();
  await tick();
  holderB();
  await tick();
  const f = h.current();
  check("R5 hanya pesan sesudah Stop yang terkirim", JSON.stringify(f?.sent.map((item) => item.text)) === '["b"]', f?.sent);
  check("R5 slot tidak bocor atau terpakai ganda", h.slots.inUse === 1, h.slots.inUse);
  check(
    "R5 pesan yang dibatalkan Stop diberitahukan",
    h.events.some((event) => event.type === "notice" && /1 pesan/.test(event.text)),
  );
  await h.done();
}

// ---------- R6: Query yang sudah ditutup tidak menggerakkan runner ----------
{
  const h = await harness();
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S8"));
  await tick();
  const before = h.events.length;
  // Pesan sudah tertahan saat runner ditutup (mis. oper ke bot lain).
  f.push(text("telat"), result({ sessionId: "S8", total: 0.9, uuids: [f.sent[0]!.uuid!] }));
  await h.runner.close();
  await tick();
  check("R6 pesan tertahan dari Query yang ditutup diabaikan", h.events.length === before && h.outcomes.length === 0, {
    events: h.events.slice(before).map((event) => event.type),
    outcomes: h.outcomes.length,
  });
  check("R6 biayanya tetap dicatat", getTask(h.task.id)!.costUsd === 0.9, getTask(h.task.id)!.costUsd);
  await h.done();
}
{
  const h = await harness({ holdOnClose: true });
  h.runner.send("a");
  await tick();
  const old = h.current();
  old.push(init("S9"), result({ sessionId: "S9", total: 0.1, uuids: [old.sent[0]!.uuid!] }));
  await tick();
  h.runner.stopSession(); // seperti idle shutdown; aliran lama baru benar-benar berakhir belakangan
  h.runner.send("b");
  await tick();
  const fresh = h.current();
  check("R6 sesi baru dimulai", fresh !== old && fresh.sent[0]?.text === "b");
  const approval = h.runner.handlePermission("Bash", { command: "ls" }, {
    signal: new AbortController().signal,
    suggestions: [],
  }) as Promise<unknown>;
  await tick();
  const id = h.events.filter((event) => event.type === "approval").at(-1)?.approvalId as string;
  old.end();
  await tick();
  check("R6 akhir aliran sesi lama tidak menutup kartu sesi baru", Boolean(id) && h.runner.hasRequest(id));
  h.runner.resolveRequest(id, { decision: "deny" });
  await approval;
  await h.done();
}

// ---------- R7: aliran berakhir tanpa result ----------
{
  const lock = fakeLock();
  const h = await harness({ lock });
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S10"));
  await tick();
  f.end();
  await tick();
  check("R7 turn terbuka: slot dan kunci dikembalikan", h.slots.inUse === 0 && !lock.isHeld(), {
    inUse: h.slots.inUse,
    lock: lock.isHeld(),
  });
  check("R7 turn ditutup sebagai error", h.outcomes[0]?.isError === true && h.runner.status === "error", h.outcomes);
  await h.done();
}
{
  const h = await harness();
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S11"), result({ sessionId: "S11", total: 0.2, uuids: [f.sent[0]!.uuid!] }));
  await tick();
  f.fail(new Error("proses mati"));
  await tick();
  check("R7 proses mati saat idle tidak menggagalkan tugas", h.outcomes.length === 1 && h.runner.status === "idle", {
    outcomes: h.outcomes.length,
    status: h.runner.status,
  });
  await h.done();
}

// ---------- R8: result Stop tidak pernah datang ----------
{
  const h = await harness();
  h.runner.send("a");
  await tick();
  const old = h.current();
  old.push(init("S12"));
  await tick();
  await h.runner.interrupt();
  h.runner.send("b");
  await tick(STOP_GRACE_MS + 60);
  check("R8 sesi yang tidak merespons Stop ditutup paksa", old.calls.close === 1, old.calls);
  check("R8 turn lama ditutup sebagai dihentikan", h.outcomes[0]?.interrupted === true, h.outcomes);
  check(
    "R8 owner diberi tahu",
    h.events.some((event) => event.type === "notice" && /ditutup paksa/.test(event.text)),
  );
  const fresh = h.current();
  check("R8 pesan berikutnya jalan di sesi baru", fresh !== old && fresh.sent[0]?.text === "b" && h.slots.inUse === 1);
  await h.done();
}

// ---------- R11: Stop membatalkan pesan kita yang masih antre di CLI ----------
{
  const lock = fakeLock();
  const h = await harness({ lock });
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S20"), result({ sessionId: "S20", total: 0.1, uuids: [f.sent[0]!.uuid!] }));
  await tick();
  // CLI mulai sendiri (job background selesai), lalu owner mengirim pesan: pesannya antre di belakangnya.
  f.push(tool(), text("cek job background"));
  await tick();
  h.runner.send("b");
  await tick();
  const queued = f.sent[1]!.uuid!;
  f.setReceipt(() => ({ still_queued: [], cancelled: [queued] }));
  await h.runner.interrupt();
  check("R11 Stop meminta cancel_queued", f.calls.cancelQueued === true);
  check(
    "R11 pesan yang dibatalkan CLI langsung ditutup",
    h.outcomes.at(-1)?.interrupted === true && h.slots.inUse === 0 && !lock.isHeld() && h.runner.status === "idle",
    { outcomes: h.outcomes, inUse: h.slots.inUse, lock: lock.isHeld(), status: h.runner.status },
  );
  // Result turn CLI yang dihentikan datang belakangan (tanpa uuid).
  f.push(result({ sessionId: "S20", total: 0.3, subtype: "error_during_execution", isError: true }));
  await tick();
  const last = h.outcomes.at(-1);
  check(
    "R11 turn CLI yang dihentikan = dihentikan, bukan gagal",
    h.outcomes.length === 3 && last?.background === true && last?.interrupted === true,
    h.outcomes,
  );
  await tick(STOP_GRACE_MS + 40);
  check("R11 tidak ada tutup paksa", f.calls.close === 0, f.calls);
  await h.done();
}
{
  // CLI lama mengabaikan cancel_queued: pesannya tetap akan jalan, jadi prosesnya ditutup.
  const h = await harness();
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S21"), result({ sessionId: "S21", total: 0.1, uuids: [f.sent[0]!.uuid!] }));
  await tick();
  f.push(tool(), text("job background"));
  await tick();
  h.runner.send("b");
  await tick();
  f.setReceipt((sent) => ({ still_queued: [sent[1]!.uuid!] }));
  await h.runner.interrupt();
  check(
    "R11 CLI lama: pesan yang tetap akan jalan → proses ditutup",
    f.calls.close === 1 && h.outcomes.at(-1)?.interrupted === true && h.slots.inUse === 0,
    { calls: f.calls, outcomes: h.outcomes, inUse: h.slots.inUse },
  );
  await h.done();
}

// ---------- R12: kunci workspace ditahan sampai CLI benar-benar berhenti ----------
{
  const lock = fakeLock();
  const h = await harness({ lock });
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S22"), tool());
  await tick();
  await h.runner.interrupt();
  check("R12 Stop: slot dilepas, kunci ditahan selama CLI berhenti", h.slots.inUse === 0 && lock.isHeld());
  f.push(
    result({ sessionId: "S22", total: 0.2, uuids: [f.sent[0]!.uuid!], subtype: "error_during_execution", isError: true }),
  );
  await tick();
  check("R12 result turn yang dihentikan melepas kunci", !lock.isHeld() && h.outcomes[0]?.interrupted === true);
  await h.done();
}
{
  const lock = fakeLock();
  const h = await harness({ lock });
  h.runner.send("a");
  await tick();
  h.current().push(init("S23"));
  await tick();
  await h.runner.interrupt();
  await tick(STOP_GRACE_MS + 40);
  check("R12 tutup paksa juga melepas kunci", !lock.isHeld() && h.outcomes[0]?.interrupted === true);
  await h.done();
}

// ---------- R13: turn yang dimulai CLI mati di tengah jalan ----------
{
  const h = await harness();
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S24"), result({ sessionId: "S24", total: 0.1, uuids: [f.sent[0]!.uuid!] }));
  await tick();
  f.push(tool(), text("menunggu build"));
  await tick();
  f.fail(new Error("proses mati"));
  await tick();
  const last = h.outcomes.at(-1);
  check(
    "R13 turn CLI yang mati dilaporkan (tugas tidak tertinggal berjalan)",
    h.outcomes.length === 2 && last?.background === true && last?.isError === true,
    h.outcomes,
  );
  check(
    "R13 runner idle lagi dan bisa ditutup saat idle",
    h.runner.status === "idle" && h.runner.idleTimer !== undefined,
    h.runner.status,
  );
  await h.done();
}

// ---------- R14: CLI yang meng-echo uuid — result tanpa uuid bukan milik kita ----------
{
  const h = await harness();
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S25"), result({ sessionId: "S25", total: 0.1, uuids: [f.sent[0]!.uuid!] }));
  await tick();
  h.runner.send("b");
  await tick();
  // Job background selesai saat pesan b masih di jalan: queued_turn_count masih 0.
  f.push(result({ sessionId: "S25", total: 0.2, queued: 0, turns: 0 }));
  await tick();
  check(
    "R14 result tanpa uuid tidak menutup turn kita",
    h.outcomes.length === 1 && h.slots.inUse === 1 && h.runner.status === "working",
    { outcomes: h.outcomes.length, inUse: h.slots.inUse, status: h.runner.status },
  );
  f.push(result({ sessionId: "S25", total: 0.5, uuids: [f.sent[1]!.uuid!] }));
  await tick();
  check("R14 result ber-uuid kita yang menutupnya", h.outcomes.length === 2 && h.slots.inUse === 0);
  await h.done();
}

// ---------- R15: turn CLI yang menelan pesan kita ----------
{
  const h = await harness();
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S26"), result({ sessionId: "S26", total: 0.1, uuids: [f.sent[0]!.uuid!] }));
  await tick();
  f.push(tool(), text("job background"));
  await tick();
  h.runner.send("b");
  await tick();
  // CLI melipat pesan b ke turn yang sedang jalan: result-nya membawa uuid b.
  f.push(result({ sessionId: "S26", total: 0.4, uuids: [f.sent[1]!.uuid!] }));
  await tick();
  check(
    "R15 turn CLI yang menelan pesan kita ikut selesai",
    h.runner.backgroundTurn === false && h.runner.status === "idle" && h.slots.inUse === 0,
    { background: h.runner.backgroundTurn, status: h.runner.status },
  );
  f.push(tool());
  await tick();
  check("R15 turn CLI berikutnya tetap terlihat", h.runner.status === "working", h.runner.status);
  await h.done();
}

// ---------- R16: kunci = folder tempat CLI menulis ----------
{
  const lock = fakeLock();
  const h = await harness({ lock });
  h.runner.send("a");
  await tick();
  const f = h.current();
  f.push(init("S27"), result({ sessionId: "S27", total: 0.1, uuids: [f.sent[0]!.uuid!] }));
  await tick();
  check("R16 sesi baru: folder project tugas", h.lockDirs[0] === workspaceForTask(h.task.id), h.lockDirs);
  // Tugas dipindah project selama sesinya masih hidup: CLI tetap di cwd lamanya.
  h.runner.queryDir = "/folder/sesi-lama";
  updateTask(h.task.id, { projectId: createProject({ name: "Pindahan", workspaceDir: join(sandbox, "lain") }).id });
  h.runner.send("b");
  await tick();
  check("R16 sesi yang masih hidup: folder cwd-nya", h.lockDirs[1] === "/folder/sesi-lama", h.lockDirs);
  await h.done();
}
{
  // Sesi belum ada dan tugas pindah folder selama mengantre kunci: kunci diambil ulang untuk folder baru.
  const lock = fakeLock();
  const blocker = await lock.acquire();
  const h = await harness({ lock });
  h.runner.send("a");
  await tick();
  const before = h.lockDirs[0];
  updateTask(h.task.id, { projectId: createProject({ name: "Tujuan", workspaceDir: join(sandbox, "tujuan") }).id });
  blocker();
  await tick(20);
  check(
    "R16 pindah folder saat mengantre: kunci folder baru",
    h.lockDirs.length === 2 && h.lockDirs[1] === join(sandbox, "tujuan") && before !== h.lockDirs[1] && h.current()?.sent[0]?.text === "a",
    h.lockDirs,
  );
  await h.done();
}

// ---------- R17: akhir turn yang dimulai CLI di scheduler ----------
{
  const task = newTask();
  patchAssignment(task.id, { summary: "ringkasan asli" });
  updateTask(task.id, { status: "needs_review" });
  const seen: AttentionEvent[] = [];
  const off = bus.subscribeAll((event) => seen.push(event));
  const onTurnEnd = (outcome: TurnOutcome) => (scheduler as never as Record<string, any>).onTurnEnd(task.id, outcome);
  onTurnEnd({ subtype: "success", isError: false, background: true, lastText: "Build selesai." });
  check(
    "R17 turn CLI tanpa bagian serah terima tidak menimpa ringkasan",
    getTask(task.id)!.assignments.at(-1)?.summary === "ringkasan asli",
    getTask(task.id)!.assignments.at(-1)?.summary,
  );
  onTurnEnd({ subtype: "success", isError: false, background: true, lastText: "## Ringkasan serah terima\nDeploy beres." });
  check(
    "R17 turn CLI dengan bagian serah terima memperbaruinya",
    getTask(task.id)!.assignments.at(-1)?.summary === "Deploy beres.",
    getTask(task.id)!.assignments.at(-1)?.summary,
  );
  updateTask(task.id, { status: "done" });
  const count = seen.length;
  onTurnEnd({ subtype: "error_during_execution", isError: true, background: true, lastText: "" });
  check(
    "R17 tugas yang sudah disetujui tidak dibuka lagi",
    getTask(task.id)!.status === "done" && seen.length === count,
    { status: getTask(task.id)!.status, attention: seen.slice(count) },
  );
  off();
}
{
  // Stop lalu pesan baru langsung jalan: status "berjalan" tidak ditimpa jadi "perlu dibaca".
  const target = scheduler as never as Record<string, any>;
  const task = newTask();
  updateTask(task.id, { status: "running" });
  const fake = { status: "working", interrupt: async () => undefined };
  target.runners.set(task.id, fake);
  await scheduler.interrupt(task.id);
  const kept = getTask(task.id)!.status;
  fake.status = "idle";
  await scheduler.interrupt(task.id);
  check(
    "R17 Stop tidak menimpa status pesan yang sudah jalan lagi",
    kept === "running" && getTask(task.id)!.status === "needs_review",
    { kept, after: getTask(task.id)!.status },
  );
  target.runners.delete(task.id);
}

// ---------- R9: kirim pesan tidak mereset status tugas aktif ----------
{
  const target = scheduler as never as Record<string, any>;
  target.runnerFor = () => ({ send() {} });
  const task = newTask();
  updateTask(task.id, { status: "waiting" });
  scheduler.send(task.id, "x");
  check("R9 kirim saat menunggu keputusan: status tetap", getTask(task.id)!.status === "waiting", getTask(task.id)!.status);
  updateTask(task.id, { status: "needs_review" });
  scheduler.send(task.id, "x");
  check("R9 kirim saat perlu dibaca: jadi antre", getTask(task.id)!.status === "queued", getTask(task.id)!.status);
  delete target.runnerFor;
}

// ---------- R10: panel Tanya ----------
{
  const task = newTask();
  const session = new AskSession(task.id, () => undefined) as never as Record<string, any>;
  session.start = () => {
    throw new Error("query() sungguhan dipanggil");
  };
  const f = fakeQuery(session);
  session.q = f.q;
  session.model = "m";
  void session.consume(f.q);
  const first = session.ask("q1", "m", []) as Promise<{ costUsd?: number }>;
  await tick();
  f.push(text("j1"), result({ sessionId: "A", total: 0.1 }));
  const answer1 = await first;
  const second = session.ask("q2", "m", []) as Promise<{ costUsd?: number }>;
  await tick();
  f.push(text("j2"), result({ sessionId: "A", total: 0.25 }));
  const answer2 = await second;
  check("R10 biaya per pertanyaan = selisih total sesi", answer1.costUsd === 0.1 && answer2.costUsd === 0.15, [
    answer1.costUsd,
    answer2.costUsd,
  ]);
  check("R10 askCostUsd = total sesi", getTask(task.id)!.askCostUsd === 0.25, getTask(task.id)!.askCostUsd);
  const third = session.ask("q3", "m", []) as Promise<unknown>;
  await tick();
  f.push(result({ sessionId: "A", total: 0.4 }));
  session.stop();
  const rejected = await third.then(
    () => false,
    () => true,
  );
  await tick();
  check("R10 stop() menolak pertanyaan yang sedang berjalan", rejected);
  check("R10 result tertahan setelah stop tidak dihitung", getTask(task.id)!.askCostUsd === 0.25, getTask(task.id)!.askCostUsd);
  session.close();
}

rmSync(sandbox, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} pengujian gagal`);
  process.exit(1);
}
console.log("Semua pengujian lulus.");
process.exit(0);
