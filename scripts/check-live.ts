/**
 * Uji tab Live (screencast → MJPEG): framing, backpressure, screencast menyala hanya selama ditonton,
 * frame akhir, dan laju frame dengan Chromium sungguhan.
 * Deterministik, tanpa model dan tanpa menyentuh data asli: bun run check:live
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-live-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");

const { ensureDirs } = await import("../server/config.ts");
ensureDirs();
const { BOUNDARY, LiveHub, live } = await import("../server/browser/live.ts");
const { BrowserSession } = await import("../server/browser/mcp.ts");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (condition()) return true;
    await wait(5);
  }
  return condition();
}

const HEADER = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\n`);
const TAIL = Buffer.concat([Buffer.from("\r\n"), HEADER]);

/** Penonton palsu bergaya Response Express: mencatat tiap tulisan dan waktunya. */
class FakeViewer extends EventEmitter {
  readonly chunks: Buffer[] = [];
  readonly times: number[] = [];
  writableLength = 0;
  write(chunk: Buffer): boolean {
    this.chunks.push(chunk);
    this.times.push(performance.now());
    return true;
  }
  /** Frame yang diterima, tanpa header pembuka dan tanpa ekor. */
  frames(): Buffer[] {
    return this.chunks.filter((chunk) => !chunk.equals(HEADER)).map((chunk) => chunk.subarray(0, chunk.length - TAIL.length));
  }
}

/** JPEG palsu yang mudah dibedakan. */
const fake = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1_000, n), Buffer.from([0xff, 0xd9])]);

function split(buffer: Buffer, separator: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let at = buffer.indexOf(separator); at >= 0; at = buffer.indexOf(separator, start)) {
    parts.push(buffer.subarray(start, at));
    start = at + separator.length;
  }
  parts.push(buffer.subarray(start));
  return parts;
}

// ---------- LiveHub ----------
{
  const hub = new LiveHub({ idleGraceMs: 30 });
  hub.setState("T-A", { active: true });
  const viewer = new FakeViewer();
  const off = hub.subscribe("T-A", viewer);
  const sent = [fake(1), fake(2), fake(3)];
  for (const frame of sent) hub.publishFrame("T-A", frame);
  const stream = Buffer.concat(viewer.chunks);
  const parts = split(stream.subarray(HEADER.length), TAIL);
  check(
    "V1 framing: header pembuka, lalu tiap frame langsung diikuti header bagian berikutnya",
    stream.subarray(0, HEADER.length).equals(HEADER) &&
      viewer.chunks.length === 1 + sent.length &&
      parts.length === sent.length + 1 &&
      parts.at(-1)?.length === 0 &&
      sent.every((frame, index) => parts[index]?.equals(frame)),
    { chunks: viewer.chunks.length, parts: parts.length },
  );
  hub.sendLastFrame("T-A", viewer);
  check("V1 heartbeat mengirim ulang frame terakhir dengan format yang sama", viewer.frames().at(-1)?.equals(sent[2]!) === true);
  off();
}
{
  const hub = new LiveHub({ idleGraceMs: 30 });
  hub.setState("T-B", { active: true });
  const viewer = new FakeViewer();
  const off = hub.subscribe("T-B", viewer);
  for (let n = 1; n <= 10; n += 1) {
    hub.publishFrame("T-B", fake(n));
    await wait(1);
  }
  check("V2 tidak ada frame dibuang karena waktu (10 frame berjarak 1 ms)", viewer.frames().length === 10, viewer.frames().length);
  off();
}
{
  const hub = new LiveHub({ idleGraceMs: 30 });
  hub.setState("T-C", { active: true });
  const viewer = new FakeViewer();
  const off = hub.subscribe("T-C", viewer);
  viewer.writableLength = 2 * 1024 * 1024;
  for (const n of [1, 2, 3]) hub.publishFrame("T-C", fake(n));
  const whileFull = viewer.frames().length;
  viewer.writableLength = 0;
  viewer.emit("drain");
  const afterDrain = viewer.frames();
  hub.publishFrame("T-C", fake(4));
  check(
    "V3 antrean penuh dilewati; setelah drain penonton menerima tepat satu frame, yang terbaru",
    whileFull === 0 && afterDrain.length === 1 && afterDrain[0]?.equals(fake(3)) === true && viewer.frames().length === 2,
    { whileFull, afterDrain: afterDrain.length, total: viewer.frames().length },
  );
  off();
}
{
  const hub = new LiveHub({ idleGraceMs: 30 });
  const calls: boolean[] = [];
  hub.onDemand("T-D", (watched) => calls.push(watched));
  hub.setState("T-D", { active: true });
  const a = hub.subscribe("T-D", new FakeViewer());
  const b = hub.subscribe("T-D", new FakeViewer());
  check("V4 penonton pertama menyalakan screencast, penonton kedua tidak memicu apa pun", calls.join() === "true", calls);
  a();
  b();
  await wait(10);
  const c = hub.subscribe("T-D", new FakeViewer());
  await wait(60);
  check("V4 menyambung lagi di dalam jeda tidak mematikan screencast", calls.join() === "true", calls);
  c();
  await wait(60);
  check("V4 penonton terakhir pergi → screencast dimatikan setelah jeda", calls.join() === "true,false", calls);

  const seen: string[] = [];
  const offOld = hub.onDemand("T-E", () => seen.push("lama"));
  hub.onDemand("T-E", () => seen.push("baru"));
  offOld();
  const x = hub.subscribe("T-E", new FakeViewer());
  x();
  const y = hub.subscribe("T-E", new FakeViewer());
  x();
  check(
    "V4 pelepas lama tidak menghapus pendaftar/penonton yang datang belakangan",
    seen.join() === "baru" && hub.viewerCount("T-E") === 1,
    { seen, viewers: hub.viewerCount("T-E") },
  );
  y();
}
{
  const hub = new LiveHub({ idleGraceMs: 20 });
  hub.setState("T-S", { active: true });
  const first = new FakeViewer();
  const offFirst = hub.subscribe("T-S", first);
  hub.publishFrame("T-S", fake(1));
  offFirst();
  await wait(50);
  const second = new FakeViewer();
  const offSecond = hub.subscribe("T-S", second);
  check("V5 frame basi tidak dikirim ke penonton baru selama sesi aktif", second.frames().length === 0, second.frames().length);
  hub.publishFrame("T-S", fake(2));
  check("V5 frame segar berikutnya langsung sampai", second.frames()[0]?.equals(fake(2)) === true);
  const third = new FakeViewer();
  const offThird = hub.subscribe("T-S", third);
  check("V5 saat screencast menyala penonton tambahan langsung menerima frame terakhir", third.frames()[0]?.equals(fake(2)) === true);
  offSecond();
  offThird();
  hub.stop("T-S");
  const frozen = new FakeViewer();
  const offFrozen = hub.subscribe("T-S", frozen);
  check("V5 sesi yang sudah berhenti langsung menampilkan frame yang membeku", frozen.frames()[0]?.equals(fake(2)) === true);
  offFrozen();
  hub.publishFrame("T-S", fake(3));
  check("V5 frame yang datang terlambat tidak menyalakan lagi sesi yang sudah berhenti", hub.state("T-S").active === false);
}

// ---------- Chromium sungguhan ----------
const decoderBrowser = await chromium.launch({ headless: true });
const decoder = await decoderBrowser.newPage();
async function colorOf(jpeg: Buffer | undefined): Promise<string> {
  if (!jpeg) return "tidak ada frame";
  const [r = 0, g = 0, b = 0] = await decoder.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${data}`;
    await image.decode();
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(4, 4, 1, 1).data.slice(0, 3)];
  }, jpeg.toString("base64"));
  if (r > 200 && g < 80 && b < 80) return "merah";
  if (b > 200 && r < 80 && g < 80) return "biru";
  if (r > 200 && g > 200 && b > 200) return "putih";
  return `rgb(${r},${g},${b})`;
}

const PAGE = `<!doctype html><body style="margin:0;background:#fff">
<div id="b" style="position:fixed;top:300px;left:0;width:160px;height:160px;background:#2383e2"></div>
<script>
  let x = 0, run = false;
  const box = document.getElementById("b");
  const step = () => { x = (x + 8) % 1200; box.style.left = x + "px"; };
  window.__spin = () => {
    if (run) return;
    run = true;
    document.body.style.background = "#fff";
    (function tick() { if (!run) return; step(); requestAnimationFrame(tick); })();
  };
  window.__finish = (color) => { run = false; document.body.style.background = color; };
  // Animasi n gambar; perubahan terakhir jatuh di gambar genap atau ganjil tergantung n.
  window.__burst = (n) => new Promise((done) => {
    run = true;
    document.body.style.background = "#fff";
    let k = 0;
    (function tick() {
      if (!run) return;
      step();
      if (++k < n) { requestAnimationFrame(tick); return; }
      run = false;
      document.body.style.background = k % 2 ? "rgb(255, 0, 0)" : "rgb(0, 0, 255)";
      done(k % 2 ? "merah" : "biru");
    })();
  });
</script>`;

const TASK = "T-LIVE";
const session = new BrowserSession(() => TASK);
const page = await session.getPage();
await page.setContent(PAGE);
await page.evaluate("window.__spin()");
await wait(300);
check("tanpa penonton screencast tidak menyala", live.state(TASK).active && live.lastFrame(TASK) === undefined);

{
  const watcher = new FakeViewer();
  const offWatcher = live.subscribe(TASK, watcher);
  await wait(700);
  const counted = watcher.frames().length;
  const started = performance.now();
  await wait(2_000);
  const fps = (watcher.frames().length - counted) / ((performance.now() - started) / 1_000);
  check(`V6 halaman yang bergerak sampai ke penonton ≥ 40 fps (terukur ${fps.toFixed(0)} fps; dulu maks 10)`, fps >= 40, fps);

  await page.evaluate("window.__finish('#fff')");
  await wait(200);
  let right = 0;
  const misses: string[] = [];
  for (let n = 10; n < 20; n += 1) {
    const expected = (await page.evaluate(`window.__burst(${n})`)) as string;
    await wait(250);
    const got = await colorOf(watcher.frames().at(-1));
    if (got === expected) right += 1;
    else misses.push(`${n}:${got}`);
  }
  check("V7 frame terakhir di penonton selalu keadaan akhir halaman (10 animasi)", right === 10, misses);

  await page.evaluate("window.__spin()");
  offWatcher();
}
{
  await wait(3_000 + 500);
  const stale = live.lastFrame(TASK);
  await wait(1_000);
  check("V8 tanpa penonton screencast berhenti walau halaman masih bergerak", stale !== undefined && live.lastFrame(TASK) === stale);
  const returning = new FakeViewer();
  const subscribedAt = performance.now();
  const offReturning = live.subscribe(TASK, returning);
  const immediately = returning.frames().length;
  await waitFor(() => returning.frames().length > 0, 1_000);
  const firstMs = returning.times[1] === undefined ? Infinity : returning.times[1] - subscribedAt;
  check(
    `V8 penonton baru tidak menerima frame basi; frame segar datang dalam ${firstMs.toFixed(0)} ms`,
    immediately === 0 && firstMs < 500 && returning.frames()[0]?.equals(stale!) === false,
    { immediately, firstMs },
  );
  offReturning();
}

const QUIET = "T-LIVE-QUIET";
{
  const quiet = new BrowserSession(() => QUIET);
  const quietPage = await quiet.getPage();
  await quietPage.setContent(`<body style="margin:0;background:rgb(0,0,255)"></body>`);
  await wait(100);
  const before = live.lastFrame(QUIET);
  await quiet.close();
  check(
    "V9 close() tanpa penonton menyimpan frame penutup = keadaan akhir (biru), sesi tidak aktif",
    before === undefined && (await colorOf(live.lastFrame(QUIET))) === "biru" && !live.state(QUIET).active,
    { before: before?.length, color: await colorOf(live.lastFrame(QUIET)), active: live.state(QUIET).active },
  );
}
{
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><img id="i" src="/live">`);
      return;
    }
    res.writeHead(200, { "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`, "Cache-Control": "no-store" });
    const off = live.subscribe(QUIET, res);
    req.on("close", off);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const viewerPage = await decoderBrowser.newPage();
  await viewerPage.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { waitUntil: "commit" });
  let width = 0;
  const end = performance.now() + 1_500;
  while (width === 0 && performance.now() < end) {
    await wait(50);
    width = await viewerPage.evaluate(() => (document.getElementById("i") as HTMLImageElement | null)?.naturalWidth ?? 0);
  }
  check("V10 <img> di Chromium langsung menampilkan satu-satunya frame, tanpa menunggu frame berikutnya", width > 0, width);
  await viewerPage.close();
  server.closeAllConnections();
  server.close();
}

await session.close();
await decoderBrowser.close();
rmSync(sandbox, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} pengujian gagal`);
  process.exit(1);
}
console.log("Semua pengujian lulus.");
process.exit(0);
