/**
 * Uji tab Live seperti computer use: overlay aksi agen, ambil alih browser oleh owner, dan tool
 * berbasis layar (view/click_at/…) — plus pemetaan koordinat yang dipakai ketiganya.
 * Deterministik, Chromium sungguhan, tanpa model dan tanpa menyentuh data asli: bun run check:control
 */
import { mkdtempSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-control-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");

const { ensureDirs } = await import("../server/config.ts");
ensureDirs();
const { live } = await import("../server/browser/live.ts");
type BrowserAction = import("../server/browser/live.ts").BrowserAction;
const { BrowserSession, createBrowserServer, ownerInput, browserActiveFor, viewScale } = await import("../server/browser/mcp.ts");
const { control } = await import("../server/browser/control.ts");
const { createProject } = await import("../server/projects.ts");
const { createTask } = await import("../server/tasks.ts");
const { threads } = await import("../server/store.ts");
const { fitContain, toScreen, toViewport } = await import("../web/live-geometry.ts");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}
const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
type ToolServer = { instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<ToolResult> }> } };
const textOf = (result: ToolResult) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

/** Ukuran gambar JPEG dari penanda SOF, tanpa pustaka gambar. */
function jpegSize(base64: string): { width: number; height: number } | undefined {
  const bytes = Buffer.from(base64, "base64");
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return undefined;
}

// ---------- pemetaan koordinat (murni) ----------
{
  const viewport = { width: 1440, height: 900 };
  const wide = fitContain({ width: 1000, height: 400 }, viewport)!;
  const tall = fitContain({ width: 400, height: 1000 }, viewport)!;
  check("G1 kotak lebar: gambar di tengah horizontal, menempel atas-bawah", near(wide.top, 0) && wide.left > 0 && near(wide.scale, 400 / 900, 1e-9), wide);
  check("G2 kotak tinggi: gambar di tengah vertikal, menempel kiri-kanan", near(tall.left, 0) && tall.top > 0, tall);
  const point = { x: 700, y: 333 };
  const back = toViewport(toScreen(point, wide), wide, viewport);
  check("G3 viewport → layar → viewport kembali ke titik semula", Boolean(back && near(back.x, point.x, 1e-6) && near(back.y, point.y, 1e-6)), back);
  check("G4 titik di pita kosong samping gambar bukan titik halaman", toViewport({ x: 1, y: 200 }, wide, viewport) === undefined);
  check("G5 kotak berukuran nol tidak menghasilkan pemetaan", fitContain({ width: 0, height: 0 }, viewport) === undefined);
}

// ---------- aksi agen dari tool browser ----------
const PAGE = `<!doctype html><meta charset="utf-8"><title>overlay</title>
<style>body{margin:0;font:16px sans-serif} button,input,select{position:absolute}</style>
<button id="go" style="left:100px;top:50px;width:120px;height:40px">Masuk</button>
<label for="email" style="position:absolute;left:300px;top:20px">Email kantor</label>
<input id="email" style="left:300px;top:50px;width:200px;height:30px">
<input id="pw" type="password" aria-label="Kata sandi" style="left:300px;top:100px;width:200px;height:30px">
<select id="pick" style="left:100px;top:150px"><option value="a">Opsi A</option><option value="b">Opsi B</option></select>
<button id="far" style="left:100px;top:2400px;width:100px;height:30px">Jauh di bawah</button>
<div style="height:3000px"></div>
<script>document.getElementById('far').onclick = () => { document.title = 'jauh diklik'; };</script>`;

const project = createProject({ name: "Uji kendali" });
const TASK = createTask({ title: "uji kendali", description: "uji", role: "qa", projectId: project.id }).id;
const session = new BrowserSession(() => TASK);
const server = createBrowserServer(session, () => TASK) as unknown as ToolServer;
const call = (name: string, args: Record<string, unknown>, extra: unknown = {}) => server.instance._registeredTools[name]!.handler(args, extra);

const page = await session.getPage({ width: 1024, height: 700 });
await page.setContent(PAGE);
check("C1 viewport tercatat di keadaan Live", live.view(TASK).viewport?.width === 1024 && live.view(TASK).viewport?.height === 700, live.view(TASK));

const seen: BrowserAction[] = [];
{
  await call("click", { selector: "#go" });
  check("C2 tanpa penyimak overlay tidak ada aksi yang disiarkan", seen.length === 0);
}

const off = live.watchActions(TASK, (action) => seen.push(action));
const last = () => seen.at(-1);
try {
  await call("click", { selector: "#go" });
  const click = last();
  check(
    "C3 click: kind, nama dari teks tombol, dan kotak sama dengan posisi elemen",
    click?.kind === "click" &&
      click.label.includes("Masuk") &&
      near(click.box?.x ?? -1, 100) &&
      near(click.box?.y ?? -1, 50) &&
      near(click.box?.width ?? -1, 120) &&
      near(click.box?.height ?? -1, 40),
    click,
  );

  await call("fill", { selector: "#email", value: "budi@contoh.id" });
  const fill = last();
  check("C4 fill: nama dari <label>, isi ketikan ditampilkan", fill?.kind === "fill" && fill.label.includes("Email kantor") && fill.text === "budi@contoh.id", fill);

  await call("fill", { selector: "#pw", value: "rahasia-sekali" });
  const secret = last();
  check(
    "C5 fill password: isi selalu dimask, tidak ada di event",
    secret?.kind === "fill" && secret.text === "••••••" && !JSON.stringify(seen).includes("rahasia-sekali"),
    secret,
  );

  await call("press", { key: "Enter", selector: "#email" });
  check("C6 press: tombol keyboard ikut dikirim", last()?.kind === "press" && last()?.key === "Enter" && Boolean(last()?.box), last());

  await call("select_option", { selector: "#pick", value: "b" });
  check("C7 select_option: keterangan memuat pilihan", last()?.kind === "select" && last()!.label.includes("b"), last());

  await call("click", { selector: "#far" });
  const far = last();
  check(
    "C8 elemen di bawah lipatan: kotaknya di dalam viewport (sudah digulung) dan kliknya tetap jadi",
    far?.kind === "click" && (far.box?.y ?? -1) >= 0 && (far.box?.y ?? Infinity) + (far.box?.height ?? 0) <= 700 && (await page.title()) === "jauh diklik",
    { far, title: await page.title() },
  );

  const before = seen.length;
  const missing = await call("click", { selector: "#tidak-ada" }).catch((error: unknown) => ({ isError: true, thrown: String(error), content: [] }));
  check(
    "C9 elemen tidak ada: tool tetap gagal seperti biasa, aksi disiarkan tanpa kotak",
    missing.isError === true && seen.length === before + 1 && last()?.box === undefined,
    { missing, action: last() },
  );

  await call("screenshot", { name: "overlay-uji" });
  check("C10 screenshot memancarkan aksi `shot`", last()?.kind === "shot", last());
  await call("snapshot", {});
  check("C11 snapshot memancarkan aksi `read`", last()?.kind === "read", last());
  check("C12 setiap aksi punya cap waktu", seen.every((action) => typeof action.at === "number" && action.at > 0));
} finally {
  off();
}
check("C13 penyimak dilepas → hitungan kembali nol", live.actionWatcherCount(TASK) === 0);

// ---------- ambil alih browser ----------
await page.setContent(PAGE);
await page.evaluate(() => window.scrollTo(0, 0));
{
  check("K1 browser hidup → boleh diambil alih", browserActiveFor(TASK) && !browserActiveFor("T-TIDAK-ADA"));
  control.take(TASK, "tab-a");
  const since = live.view(TASK).controlledSince;
  check("K2 ambil alih tercatat di keadaan Live", typeof since === "number");
  const notices = threads.read(TASK).filter((event) => event.type === "notice").map((event) => (event as { text: string }).text);
  check("K3 thread mendapat notice ambil alih", notices.some((text) => text.includes("mengambil alih")), notices);

  // Tool agen dimulai saat owner memegang kendali: harus menunggu.
  let settled = false;
  const pending = call("text", { selector: "#go" }).then((result) => {
    settled = true;
    return result;
  });
  await wait(300);
  check("K4 tool agen menunggu selama owner memegang kendali", !settled);

  // Owner: klik tombol, ketik di field email (keyboard + paste), gulung halaman.
  ownerInput(TASK, { t: "down", x: 160, y: 70, button: "left", clicks: 1 });
  ownerInput(TASK, { t: "up", x: 160, y: 70, button: "left", clicks: 1 });
  ownerInput(TASK, { t: "down", x: 400, y: 65, button: "left", clicks: 1 });
  ownerInput(TASK, { t: "up", x: 400, y: 65, button: "left", clicks: 1 });
  for (const key of ["a", "b", "c"]) {
    ownerInput(TASK, { t: "key", phase: "down", key });
    ownerInput(TASK, { t: "key", phase: "up", key });
  }
  ownerInput(TASK, { t: "text", text: "xyz" });
  ownerInput(TASK, { t: "move", x: 99_999, y: -50 });
  ownerInput(TASK, { t: "wheel", x: 500, y: 400, dx: 0, dy: 600 });
  control.take(TASK, "tab-b");
  check("K5 pindah ke tab lain tidak membangunkan agen dan tidak mengubah waktu mulai", live.view(TASK).controlledSince === since && control.holderOf(TASK) === "tab-b");
  await wait(600);
  check("K6 input owner sampai ke halaman (ketikan + paste)", (await page.inputValue("#email")) === "abcxyz", await page.inputValue("#email"));
  check("K7 roda mouse owner menggulung halaman", (await page.evaluate(() => window.scrollY)) > 0);
  check("K8 tab lama tidak bisa mencabut kendali yang sudah dipindah", control.release(TASK, "tab-a") === false && control.isHeld(TASK));

  check("K9 tab yang memegang terputus → kendali kembali ke agen", (control.releaseHolder("tab-b"), !control.isHeld(TASK)));
  const result = await pending;
  const report = result.content[0]?.text ?? "";
  check(
    "K10 tool agen lanjut dengan ringkasan aksi owner di depan hasilnya",
    !result.isError && report.startsWith("[Owner sempat mengambil alih") && report.includes("klik “Masuk”") && report.includes("mengetik 6 karakter di “Email kantor”") && report.includes("menggulung halaman"),
    report,
  );
  check("K11 isi ketikan owner tidak ada di ringkasan", !report.includes("abc") && !report.includes("xyz"), report);
  check("K12 kendali kembali tercatat di keadaan Live", live.view(TASK).controlledSince === undefined);
}
{
  const free = await call("text", { selector: "#go" });
  check("K13 tanpa owner, tool tidak membawa ringkasan", !textOf(free).includes("Owner sempat"), textOf(free));

  control.take(TASK, "tab-a");
  const abort = new AbortController();
  const pending = call("text", { selector: "#go" }, { signal: abort.signal });
  await wait(100);
  abort.abort();
  const aborted = await pending;
  check("K14 Stop saat owner memegang: tool berhenti menunggu dan gagal dengan pesan jelas", aborted.isError === true && textOf(aborted).includes("owner"), textOf(aborted));
  const timedOut = await control.waitIfHeld(TASK, undefined, 50);
  check("K15 batas tunggu habis → tool diberi tahu owner masih memegang browser", timedOut.kind === "held");
  control.release(TASK, "tab-a");
}

// ---------- tool berbasis layar ----------
const SCREEN = `<!doctype html><meta charset="utf-8"><title>layar</title>
<style>body{margin:0;font:16px sans-serif}#top{height:1000px;background:rgb(255,0,0)}#bottom{height:1500px;background:rgb(0,0,255)}
#hit{position:fixed;left:700px;top:430px;width:40px;height:40px;background:#0f0}
#field{position:fixed;left:100px;top:100px;width:200px}#pw{position:fixed;left:100px;top:150px;width:200px}
#pad{position:fixed;left:900px;top:100px;width:300px;height:300px;background:#eee}
#box{position:fixed;left:100px;top:300px;width:200px;height:200px;overflow:auto}</style>
<div id="top"></div><div id="bottom"></div>
<button id="hit" aria-label="Tombol hijau"></button>
<input id="field" aria-label="Catatan"><input id="pw" type="password" aria-label="Sandi">
<div id="pad"></div>
<div id="box"><div style="height:2000px">isi panjang</div></div>
<script>
  document.getElementById('hit').onclick = () => { document.title = 'kena'; };
  const pad = document.getElementById('pad');
  pad.onmousedown = (e) => { window.__drag = { from: [e.clientX, e.clientY] }; };
  pad.onmouseup = (e) => { if (window.__drag) window.__drag.to = [e.clientX, e.clientY]; };
</script>`;
{
  check("S1 skala view: 1440×900 diperkecil ke sisi panjang 1280", near(viewScale({ width: 1440, height: 900 }), 1280 / 1440, 1e-9));
  check("S2 skala view: viewport kecil tidak diperbesar", viewScale({ width: 1024, height: 700 }) === 1);
  check("S3 skala view: viewport tinggi dibatasi jumlah piksel", viewScale({ width: 1000, height: 1250 }) * viewScale({ width: 1000, height: 1250 }) * 1000 * 1250 <= 1_150_001);

  await call("open", { url: "about:blank", width: 1440, height: 900 });
  await page.setContent(SCREEN);
  const scale = 1280 / 1440;
  const toImage = (x: number) => Math.round(x * scale);

  const view = await call("view", {});
  const image = view.content.find((part) => part.type === "image");
  const size = image?.data ? jpegSize(image.data) : undefined;
  check("S4 view mengembalikan gambar 1280×800 dan menyebut ukurannya", size?.width === 1280 && size.height === 800 && textOf(view).includes("1280×800"), { size, text: textOf(view) });

  await page.evaluate(() => window.scrollTo(0, 1500));
  const scrolled = await call("view", {});
  const decoder = await chromium.launch({ headless: true });
  const decodePage = await decoder.newPage();
  const pixel = await decodePage.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(img, 0, 0);
    return [...context.getImageData(20, 700, 1, 1).data.slice(0, 3)];
  }, scrolled.content.find((part) => part.type === "image")?.data ?? "");
  await decoder.close();
  check("S5 view setelah digulung menampilkan bagian yang sedang terlihat (biru), bukan atas dokumen (merah)", pixel[2]! > 200 && pixel[0]! < 60, pixel);

  const off = live.watchActions(TASK, (action) => seen.push(action));
  try {
    const hit = await call("click_at", { x: toImage(720), y: toImage(450) });
    check("S6 click_at pada koordinat gambar mengenai elemen yang benar", !hit.isError && (await page.title()) === "kena" && textOf(hit).includes("Tombol hijau"), textOf(hit));
    check("S7 click_at memancarkan aksi dengan titik viewport persis", last()?.kind === "click" && near(last()?.point?.x ?? -1, 720, 1) && near(last()?.point?.y ?? -1, 450, 1), last());

    await call("click_at", { x: toImage(150), y: toImage(110) });
    const typed = await call("type_text", { text: "halo dunia" });
    check("S8 type_text mengetik ke field yang fokus", (await page.inputValue("#field")) === "halo dunia" && textOf(typed).includes("Catatan"), textOf(typed));

    await call("click_at", { x: toImage(150), y: toImage(160) });
    await call("type_text", { text: "rahasia-dua" });
    check("S9 type_text ke field password: aksi dimask", last()?.text === "••••••" && !JSON.stringify(seen).includes("rahasia-dua"), last());

    await call("scroll_at", { x: toImage(200), y: toImage(400), dy: 300 });
    check("S10 scroll_at menggulung container di bawah titik", (await page.evaluate(() => document.getElementById("box")!.scrollTop)) > 0);

    await call("drag", { from: { x: toImage(950), y: toImage(150) }, to: { x: toImage(1150), y: toImage(350) } });
    const drag = (await page.evaluate("window.__drag")) as { from?: number[]; to?: number[] } | undefined;
    check(
      "S11 drag menekan di titik awal dan melepas di titik akhir",
      Boolean(drag?.from && drag.to && near(drag.from[0]!, 950, 2) && near(drag.to[0]!, 1150, 2) && near(drag.to[1]!, 350, 2)),
      drag,
    );

    const outside = await call("click_at", { x: 5000, y: 10 });
    check("S12 titik di luar gambar ditolak dengan pesan yang menyuruh view", outside.isError === true && textOf(outside).includes("view"), textOf(outside));
  } finally {
    off();
  }
}
{
  control.take(TASK, "tab-a");
  const pending = call("view", {});
  await wait(100);
  await session.close();
  const woken = await pending;
  check("K16 browser ditutup saat owner memegang: tool yang menunggu ikut bangun", !control.isHeld(TASK) && textOf(woken).includes("browser ditutup"), textOf(woken));
}

await session.close();
rmSync(sandbox, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} pengujian gagal`);
  process.exit(1);
}
console.log("Semua pengujian lulus.");
process.exit(0);
