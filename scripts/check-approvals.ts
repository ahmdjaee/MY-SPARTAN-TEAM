/** Uji alur kartu persetujuan. Deterministik, tanpa model dan tanpa menyentuh data asli: bun run check:approvals */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-approvals-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");

const { bus } = await import("../server/agent/bus.ts");
const { TaskRunner } = await import("../server/agent/runner.ts");
const { Semaphore } = await import("../server/agent/semaphore.ts");
const { mergeEvents } = await import("../web/useTaskThread.ts");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Kunci workspace tiruan: FIFO, satu pemegang — sama seperti kunci di scheduler. */
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
  return { acquire, isHeld: () => held, waiting: () => waiters.length };
}

let counter = 0;
/** Runner di tengah turn yang memegang satu slot (dan kunci, kalau diberi), tanpa proses Claude sungguhan. */
async function setup(size = 1, options: { lock?: ReturnType<typeof fakeLock> } = {}) {
  const taskId = `T-${++counter}`;
  const slots = new Semaphore(size);
  const events: Array<Record<string, unknown>> = [];
  const unsubscribe = bus.subscribe(taskId, (event) => events.push(event as never));
  const lock = options.lock;
  const runner = new TaskRunner(taskId, "engineer", {
    acquire: () => slots.acquire(),
    ...(lock ? { lockWorkspace: () => lock.acquire() } : {}),
    onStatus: () => undefined,
    onSession: () => undefined,
    onTurnEnd: () => undefined,
    onIdleShutdown: () => undefined,
    onContext: () => undefined,
  }) as never as Record<string, any>;
  runner.busy = true;
  if (lock) runner.lockRelease = await lock.acquire();
  runner.release = await slots.acquire();
  const ask = (tool = "Bash", signal = new AbortController().signal) =>
    runner.handlePermission(tool, { command: tool }, { signal, suggestions: [] }) as Promise<{ behavior: string }>;
  const open = () => events.filter((event) => event.type === "approval").map((event) => String(event.approvalId));
  const resolved = () => events.filter((event) => event.type === "approval_resolved").map((event) => String(event.approvalId));
  return { runner, slots, ask, open, resolved, unsubscribe };
}

{
  const t = await setup();
  const first = t.ask("A");
  const second = t.ask("B");
  await tick();
  check("slot dilepas selama menunggu", t.slots.inUse === 0, t.slots.inUse);
  const [a, b] = t.open();
  t.runner.resolveRequest(a, { decision: "allow" });
  await first;
  check("status tetap waiting selama masih ada kartu", t.runner.status === "waiting", t.runner.status);
  check("slot belum diambil selama masih ada kartu", t.slots.inUse === 0, t.slots.inUse);
  t.runner.resolveRequest(b, { decision: "allow" });
  await second;
  check("keputusan terakhir mengambil slot", t.slots.inUse === 1 && t.runner.status === "working", t.slots.inUse);
  t.runner.finishTurn("success", false);
  check("dua approval paralel tidak membocorkan slot", t.slots.inUse === 0, t.slots.inUse);
  await t.runner.close();
  t.unsubscribe();
}

{
  const t = await setup();
  const pending = t.ask();
  await tick();
  const holder = await t.slots.acquire(); // tugas lain mengisi satu-satunya slot
  const [id] = t.open();
  t.runner.resolveRequest(id, { decision: "allow" });
  await tick();
  check("kartu tertutup walau slot penuh", t.resolved().includes(id!), t.resolved());
  check("status mengantre saat slot penuh", t.runner.status === "starting", t.runner.status);
  holder();
  const result = await pending;
  check("lanjut setelah slot kosong", result.behavior === "allow" && t.runner.status === "working", result);
  t.runner.finishTurn("success", false);
  check("slot kembali", t.slots.inUse === 0, t.slots.inUse);
  await t.runner.close();
  t.unsubscribe();
}

{
  const t = await setup();
  const pending = t.ask();
  await tick();
  const holder = await t.slots.acquire();
  t.runner.resolveRequest(t.open()[0], { decision: "allow" });
  await tick();
  await t.runner.interrupt();
  holder();
  const result = await pending;
  await tick();
  check("Stop saat mengantre membatalkan tool", result.behavior === "deny", result);
  check("Stop saat mengantre tidak membocorkan slot", t.slots.inUse === 0, t.slots.inUse);
  await t.runner.close();
  t.unsubscribe();
}

{
  const t = await setup();
  const controller = new AbortController();
  const pending = t.ask("Bash", controller.signal);
  await tick();
  const [id] = t.open();
  controller.abort();
  const result = await pending;
  await tick();
  check("permintaan yang dicabut SDK menutup kartu", t.resolved().includes(id!) && !t.runner.hasRequest(id), t.resolved());
  check("permintaan dicabut ditolak", result.behavior === "deny", result);
  check("turn lanjut setelah dicabut", t.runner.status === "working" && t.slots.inUse === 1, t.runner.status);
  t.runner.finishTurn("success", false);
  await t.runner.close();
  t.unsubscribe();
}

{
  const t = await setup();
  void t.ask();
  await tick();
  const [id] = t.open();
  const first = t.runner.resolveRequest(id, { decision: "allow" });
  const again = t.runner.resolveRequest(id, { decision: "deny" });
  check("klik kedua diabaikan", first === true && again === false);
  await tick();
  t.runner.finishTurn("success", false);
  await t.runner.close();
  t.unsubscribe();
}

{
  // L1: menunggu keputusan melepas slot, tapi kunci workspace tetap dipegang.
  const lock = fakeLock();
  const t = await setup(1, { lock });
  const pending = t.ask();
  await tick();
  check("L1 slot dilepas, kunci tetap dipegang saat menunggu", t.slots.inUse === 0 && lock.isHeld(), t.slots.inUse);
  let otherWriter = false;
  void lock.acquire().then((release) => {
    otherWriter = true;
    release();
  });
  await tick();
  check("L1 penulis lain di workspace yang sama menunggu", !otherWriter && lock.waiting() === 1);
  t.runner.resolveRequest(t.open()[0], { decision: "allow" });
  await pending;
  check(
    "L1 lanjut setelah keputusan tanpa meminta kunci lagi",
    t.slots.inUse === 1 && t.runner.status === "working" && lock.waiting() === 1,
    { inUse: t.slots.inUse, status: t.runner.status, waiting: lock.waiting() },
  );
  t.runner.finishTurn("success", false);
  await tick();
  check("L1 akhir turn melepas slot dan kunci", t.slots.inUse === 0 && otherWriter && !lock.isHeld());
  await t.runner.close();
  t.unsubscribe();
}

{
  // L2: Stop tanpa turn yang sudah sampai ke CLI melepas kunci seketika. (Turn yang sedang jalan
  // menahan kunci sampai CLI benar-benar berhenti — lihat R12 di check-runner.)
  const lock = fakeLock();
  const t = await setup(1, { lock });
  void t.ask();
  await tick();
  const stopping = t.runner.interrupt();
  check("L2 Stop tanpa turn di CLI melepas kunci dan slot seketika", !lock.isHeld() && t.slots.inUse === 0);
  await stopping;
  await t.runner.close();
  t.unsubscribe();
}

{
  // L3: close() mengembalikan slot dan kunci sebelum menunggu browser ditutup.
  const lock = fakeLock();
  const t = await setup(1, { lock });
  const closing = t.runner.close();
  check("L3 close melepas slot dan kunci sebelum browser ditutup", !lock.isHeld() && t.slots.inUse === 0);
  await closing;
  t.unsubscribe();
}

{
  // L4: A menunggu keputusan memegang kunci; QA memakai satu-satunya slot; C menunggu kunci.
  // Setelah keputusan A mengantre slot (masih memegang kunci), lalu C dapat kunci dan slot — tanpa deadlock.
  const lock = fakeLock();
  const t = await setup(1, { lock });
  const pending = t.ask();
  await tick();
  const qa = await t.slots.acquire();
  let writerC = false;
  const c = (async () => {
    const releaseLock = await lock.acquire();
    const releaseSlot = await t.slots.acquire();
    writerC = true;
    releaseSlot();
    releaseLock();
  })();
  t.runner.resolveRequest(t.open()[0], { decision: "allow" });
  await tick();
  check("L4 A mengantre slot sambil memegang kunci", t.runner.status === "starting" && lock.isHeld() && !writerC);
  qa();
  await pending;
  t.runner.finishTurn("success", false);
  await Promise.race([c, new Promise((resolve) => setTimeout(resolve, 500))]);
  check("L4 tidak ada deadlock: C dapat kunci lalu slot", writerC && t.slots.inUse === 0 && !lock.isHeld());
  await t.runner.close();
  t.unsubscribe();
}

{
  const base = { ts: "", taskId: "T", role: "engineer" };
  const request = (seq: number) => ({ ...base, seq, type: "approval", approvalId: "x", toolName: "Bash", input: {} }) as never;
  const note = (seq: number) => ({ ...base, seq, type: "notice", text: String(seq) }) as never;
  const cards = (list: Array<{ type: string }>) => list.filter((event) => event.type === "approval").length;

  const seqs = (list: Array<{ seq: number }>) => list.map((event) => event.seq).join();
  const openedFirst = mergeEvents(mergeEvents([], [request(0)]), [note(4), request(5), note(6)]);
  check("buka tugas: stream lalu snapshot → satu kartu", cards(openedFirst) === 1, seqs(openedFirst));
  check("salinan tersimpan menggantikan seq 0 di urutannya", seqs(openedFirst) === "4,5,6", seqs(openedFirst));
  const liveFirst = mergeEvents(mergeEvents([], [note(4), request(5)]), [request(0)]);
  check("live lalu openRequests → satu kartu", cards(liveFirst) === 1 && seqs(liveFirst) === "4,5", seqs(liveFirst));
  const same = mergeEvents(liveFirst, [note(4), request(5), request(0)]);
  check("muat ulang jendela yang sama tidak mengubah apa pun", same === liveFirst);
  check("event ephemeral tidak masuk", mergeEvents([], [{ ...base, seq: 0, type: "status", status: "idle" } as never]).length === 0);
}

rmSync(sandbox, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} pengujian gagal`);
  process.exit(1);
}
console.log("Semua pengujian lulus.");
process.exit(0);
