/**
 * Uji aksi browser yang meniru ide browser-use: sasaran ber-ref dari snapshot, hanya elemen terlihat,
 * menunggu halaman tenang, ringkasan perubahan halaman, unduhan/ekspor, tab baru, dan pesan galat
 * yang bisa ditindaklanjuti. Deterministik, Chromium sungguhan, tanpa model dan tanpa menyentuh data
 * asli: bun run check:actions
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "ai-team-actions-"));
process.env.DATA_DIR = sandbox;
process.env.WORKSPACE_DIR = join(sandbox, "workspace");

const { ensureDirs } = await import("../server/config.ts");
ensureDirs();
const { BrowserSession, createBrowserServer } = await import("../server/browser/mcp.ts");
const { diffSnapshots, formatChanges, redact, refName, pageOverview } = await import("../server/browser/outcome.ts");
const { explainFailure } = await import("../server/browser/targets.ts");
const { describeDownload, safeDownloadName } = await import("../server/browser/downloads.ts");
const { createProject } = await import("../server/projects.ts");
const { createTask, listDocs, taskDir } = await import("../server/tasks.ts");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${!ok && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

// ---------- bagian murni (tanpa browser) ----------
{
  const before = [
    "- generic [ref=e1]:",
    '  - checkbox "Setuju" [ref=e2]',
    "  - table [ref=e3]:",
    "    - rowgroup [ref=e4]:",
    '      - row "Budi aktif Edit" [ref=e5]:',
    '        - cell "Budi" [ref=e6]',
    '        - cell "aktif" [ref=e7]',
    '      - row "Sari aktif Edit" [ref=e8]:',
    '        - cell "Sari" [ref=e9]',
    '        - cell "aktif" [ref=e10]',
    '  - textbox "Email" [active] [ref=e11]',
  ].join("\n");
  const after = [
    "- generic [ref=e1]:",
    '  - checkbox "Setuju" [checked] [ref=e2]',
    "  - table [ref=e3]:",
    "    - rowgroup [ref=e4]:",
    '      - row "Budi nonaktif Edit" [ref=e5]:',
    '        - cell "Budi" [ref=e6]',
    '        - cell "nonaktif" [ref=e7]',
    '  - textbox "Email" [ref=e11]:',
    "    - text: abcde",
    '  - dialog "Hapus data?" [ref=e20]:',
    '    - heading "Hapus data?" [level=2] [ref=e21]',
    '    - button "Batal" [ref=e22]',
    '    - button "Hapus" [ref=e23]',
  ].join("\n");
  const changes = diffSnapshots(before, after);
  const text = formatChanges(changes).text;
  check("U1 diff: elemen baru teratas muncul sekali beserta isinya (ref tombolnya ikut)", (text.match(/^\+ /gm) ?? []).length === 1 && text.includes('+ dialog "Hapus data?" [ref=e20]') && text.includes('button "Hapus" [ref=e23]'), text);
  check("U2 diff: checkbox tercentang dan isi textbox dilaporkan berubah", text.includes('~ checkbox "Setuju" [checked] [ref=e2]') && /~ textbox "Email" \[ref=e11\]\n\s+- text: abcde/.test(text), text);
  check("U3 diff: baris tabel yang hilang dilaporkan sekali, tanpa sel-selnya", text.includes('− row "Sari aktif Edit" [ref=e8]') && !text.includes("− cell"), text);
  check("U4 diff: leluhur yang namanya berubah karena selnya berubah tidak ikut dilaporkan; sel-nya iya", !text.includes('row "Budi nonaktif Edit"') && text.includes('~ cell "nonaktif" [ref=e7]'), text);
  check("U5 diff: pindah fokus ([active]) saja bukan perubahan", diffSnapshots(before, before.replace(" [active]", "")).length === 0);
  const many = Array.from({ length: 80 }, (_, i) => `- button "B${i}" [ref=e${100 + i}]`).join("\n");
  const limited = formatChanges(diffSnapshots("- generic [ref=e1]", many));
  check("U6 daftar perubahan dibatasi dan sisanya disebut jumlahnya", limited.omitted > 0 && limited.text.split("\n").length <= 41 && /… \d+ perubahan lain/.test(limited.text), limited.text.split("\n").length);
  const emptyForm = '- generic [ref=e1]:\n  - listbox "Saran"\n  - button "Muat" [ref=e2]\n  - paragraph';
  const filledForm = '- generic [ref=e1]:\n  - listbox "Saran" [ref=e3]:\n    - option "Bekasi" [ref=e4]\n  - button "Muat" [ref=e2]\n  - paragraph [ref=e5]: "Hasil: 3"';
  const promotedText = formatChanges(diffSnapshots(emptyForm, filledForm)).text;
  check("U6b elemen kosong yang mendapat ref saat berisi: hanya + elemennya, induknya tidak ikut", promotedText === '+ listbox "Saran" [ref=e3]\n    - option "Bekasi" [ref=e4]\n+ paragraph [ref=e5]: "Hasil: 3"', promotedText);
  const demotedText = formatChanges(diffSnapshots(filledForm, emptyForm)).text;
  check("U6c dan kebalikannya: hanya − elemennya", demotedText === '− listbox "Saran" [ref=e3]\n− paragraph [ref=e5]: "Hasil: 3"', demotedText);
  const goneText = formatChanges(diffSnapshots('- generic [ref=e1]:\n  - text: Email wajib diisi\n  - textbox "Email" [ref=e2]', '- generic [ref=e1]:\n  - textbox "Email" [ref=e2]')).text;
  check("U6d teks lepas yang hilang ditampilkan di bawah induknya", goneText === "~ generic [ref=e1]\n    − text: Email wajib diisi", goneText);

  const withButton = after.replace('"Budi" [ref=e6]', '"Budi" [ref=e6]\n        - cell [ref=e30]:\n          - button "Edit" [ref=e31]');
  const edit = refName(withButton, "e31");
  check("U7 refName: tombol kembar di tabel dibedakan dengan sel pertama barisnya", edit === 'button "Edit" (baris "Budi")', edit);
  check("U8 refName: nilai textbox tidak ikut di nama", refName('- textbox "Sandi" [ref=e3]: ••••••', "e3") === 'textbox "Sandi"');

  const masked = redact('- textbox "Sandi" [ref=e3]: Rahasia123!\n- text: Rahasia123! bocor\n- textbox "PIN" [ref=e4]: 12\n- text: angka 12 di tempat lain', ["Rahasia123!", "12"]);
  check("U9 redact: password panjang disamarkan di mana pun; yang pendek hanya di nilai textbox", !masked.includes("Rahasia123!") && masked.includes('"PIN" [ref=e4]: ••••••') && masked.includes("angka 12 di tempat lain"), masked);

  const covered = explainFailure(
    'click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator(\'#x\')\n      - <div class="modal-backdrop fade show"></div> intercepts pointer events\n    - retrying click action',
  );
  check("U10 explainFailure: penghalang klik disebut namanya", covered.startsWith('tertutup oleh <div class="modal-backdrop fade show"></div>') && covered.includes("Timeout 5000ms"), covered);
  check("U11 explainFailure: <select> kustom diarahkan ke click", explainFailure("selectOption: Error: Element is not a <select> element\nCall log:").includes("buka dropdown-nya dengan click"));
  check("U12 explainFailure: kode warna ANSI dibuang", !explainFailure("\u001b[2mclick: Timeout 10ms exceeded.\u001b[22m").includes("\u001b"));

  check("U13 nama unduhan: tanpa path dan tanpa titik di depan", safeDownloadName("../../etc/.passwd") === "passwd" && safeDownloadName("laporan:Q3?.csv") === "laporan-Q3-.csv" && safeDownloadName("") === "unduhan");
  const dir = join(sandbox, "contoh-unduhan");
  mkdirSync(dir, { recursive: true });
  const record = (file: string, content: string | Buffer) => {
    writeFileSync(join(dir, file), content);
    return { seq: 1, url: "http://contoh.test/ekspor?id=1", suggested: file, file, path: join(dir, file), size: Buffer.byteLength(content), finished: true, done: Promise.resolve() };
  };
  const csv = describeDownload(record("data.csv", "﻿id,nama\n1,Budi\n2,Sari\n"));
  check("U14 unduhan CSV: ukuran, jenis, jumlah baris, dan cuplikan (BOM dibuang)", csv.includes("./downloads/data.csv (25 byte, CSV)") && csv.includes("3 baris") && csv.includes("│ id,nama") && !csv.includes("﻿"), csv);
  const fake = describeDownload(record("laporan.xlsx", "<!DOCTYPE html><html><body>500 Internal Server Error</body></html>"));
  check("U15 unduhan 'xlsx' yang ternyata halaman HTML ketahuan dari isinya", fake.includes("HTML (padahal namanya .xlsx") && fake.includes("500 Internal Server Error"), fake);
  check("U16 unduhan kosong disebut KOSONG", describeDownload(record("kosong.csv", "")).includes("KOSONG"));
  check("U17 ringkasan halaman kosong menyarankan menunggu", pageOverview("- generic [ref=e1]").includes("tampak kosong"));
}

// ---------- fixture HTTP ----------
const MAIN = `<!doctype html><meta charset="utf-8"><title>Fixture aksi</title>
<style>body{margin:0;font:14px sans-serif}.mobile{display:none}iframe{height:60px}</style>
<nav class="mobile"><a href="#ms">Model Skor</a></nav>
<nav><a href="#ms" onclick="document.title='model skor diklik'">Model Skor</a></nav>
<div id="kartu" style="cursor:pointer" onclick="this.textContent='Kartu diklik'">Kartu kustom</div>
<div style="display:none"><button>Arsipkan</button></div>
<form onsubmit="return false">
  <label>Email <input id="email" type="email" maxlength="5"></label>
  <label>Sandi <input id="pw" type="password"></label>
  <label><input type="checkbox" id="setuju"> Setuju</label>
  <label>Kota <select id="kota"><option value="bdg">Bandung</option><option value="jkt">Jakarta</option></select></label>
  <label>Cari kota <input id="cari" role="combobox" aria-autocomplete="list" aria-controls="saran"></label>
  <div id="saran" role="listbox" aria-label="Saran kota"></div>
  <button type="button" id="simpan">Simpan</button>
  <button type="button" id="muat">Muat</button>
  <button type="button" id="proses">Proses</button>
  <p id="hasil"></p>
</form>
<table><tr><td>Budi</td><td><button onclick="document.title='edit Budi'">Edit</button></td></tr>
<tr><td>Sari</td><td><button onclick="document.title='edit Sari'">Edit</button></td></tr></table>
<iframe src="/bingkai" title="Bingkai"></iframe>
<p><a href="/ekspor.csv">Ekspor CSV</a> <a href="/tujuan" target="_blank">Buka laporan</a> <a href="/tujuan">Ke laporan</a></p>
<button id="tertutup">Tertutup</button>
<span id="info" onmouseenter="setTimeout(() => { const tip = document.createElement('div'); tip.setAttribute('role', 'tooltip'); tip.textContent = 'Penjelasan singkat'; document.body.append(tip); }, 600)">Info</span>
<div id="tirai" class="modal-backdrop" style="position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.2);display:none"></div>
<script>
  const hasil = document.getElementById('hasil');
  document.getElementById('simpan').onclick = () => setTimeout(() => {
    const toast = document.createElement('div'); toast.setAttribute('role', 'alert'); toast.textContent = 'Data tersimpan'; document.body.append(toast);
  }, 300);
  document.getElementById('muat').onclick = () => fetch('/api/lambat').then((r) => r.json()).then((d) => { hasil.textContent = 'Hasil dimuat: ' + d.n; });
  document.getElementById('proses').onclick = () => setTimeout(() => { hasil.textContent = 'Proses selesai'; }, 900);
  document.getElementById('cari').oninput = (event) => {
    const list = document.getElementById('saran'); list.innerHTML = '';
    for (const kota of ['Bandung', 'Bekasi'].filter((k) => event.target.value && k.toLowerCase().startsWith(event.target.value.toLowerCase()))) {
      const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = kota;
      option.onclick = () => { event.target.value = kota; list.innerHTML = ''; document.title = 'kota ' + kota; };
      list.append(option);
    }
  };
</script>`;

const rows = Array.from({ length: 2000 }, (_, i) => `<tr><td>Orang ${i}</td><td>${i}@contoh.id</td><td>aktif</td><td><button>Edit</button><button>Hapus</button></td></tr>`).join("");
const BIG = `<!doctype html><meta charset="utf-8"><title>Besar</title><button id="tambah" onclick="document.title='ditambah'">Tambah</button><table>${rows}</table>`;
// Autocomplete sungguhan: debounce 350 ms lalu fetch 200 ms — saran datang ±550 ms setelah mengetik.
const SUGGEST = `<!doctype html><meta charset="utf-8"><title>Saran</title>
<label>Kota tujuan <input id="tujuan" role="combobox" aria-autocomplete="list" aria-controls="daftar"></label>
<ul id="daftar" role="listbox" aria-label="Daftar kota"></ul>
<script>
  let timer;
  document.getElementById('tujuan').addEventListener('input', (event) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const kota = await (await fetch('/api/kota?q=' + encodeURIComponent(event.target.value))).json();
      document.getElementById('daftar').innerHTML = kota.map((k) => '<li role="option">' + k + '</li>').join('');
    }, 350);
  });
</script>`;
// Halaman "sibuk" yang sebenarnya diam: long-poll sejak dimuat, marquee JS tiap frame, dan telemetri.
const BUSY = `<!doctype html><meta charset="utf-8"><title>Sibuk</title>
<div id="marquee" style="white-space:nowrap">Promo hari ini · Promo hari ini</div>
<button id="diam">Diam</button>
<button id="lacak" onclick="fetch('https://www.google-analytics.com/g/collect?v=2', { mode: 'no-cors' }).catch(() => {})">Lacak</button>
<script>
  fetch('/api/longpoll').catch(() => {});
  let x = 0;
  (function tick() { x = (x + 1) % 300; document.getElementById('marquee').style.transform = 'translateX(' + x + 'px)'; requestAnimationFrame(tick); })();
</script>`;
const SPA = `<!doctype html><meta charset="utf-8"><title>Dasbor</title><div id="app">Memuat…</div>
<script>fetch('/api/lambat').then((r) => r.json()).then(() => { document.getElementById('app').innerHTML = '<h1>Dasbor</h1><button>Segarkan</button>'; });</script>`;

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  const html = (body: string) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  };
  if (url.startsWith("/api/lambat")) {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"n":3}');
    }, 800);
    return;
  }
  if (url.startsWith("/api/kota")) {
    const q = new URL(url, "http://x").searchParams.get("q")?.toLowerCase() ?? "";
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(["Bandung", "Bekasi", "Bogor"].filter((kota) => q && kota.toLowerCase().startsWith(q))));
    }, 200);
    return;
  }
  if (url.startsWith("/api/longpoll")) {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }, 20_000).unref();
    return;
  }
  if (url === "/saran") return html(SUGGEST);
  if (url === "/sibuk") return html(BUSY);
  if (url.startsWith("/ekspor.csv")) {
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="data ekspor.csv"' });
    res.end("id,nama,status\n1,Budi,aktif\n2,Sari,nonaktif\n");
    return;
  }
  if (url === "/bingkai") return html(`<button onclick="parent.document.title='bingkai diklik'">Tombol bingkai</button>`);
  if (url === "/tujuan") return html("<title>Laporan</title><h1>Laporan bulanan</h1><p>Isi laporan</p>");
  if (url === "/besar") return html(BIG);
  if (url === "/spa") return html(SPA);
  if (url === "/kosong") return html("<title>Kosong</title>");
  return html(MAIN);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type ToolServer = { instance: { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<ToolResult> }> } };
const textOf = (result: ToolResult) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

const project = createProject({ name: "Uji aksi" });
const TASK = createTask({ title: "uji aksi", description: "uji", role: "qa", projectId: project.id }).id;
const session = new BrowserSession(() => TASK);
const tools = createBrowserServer(session, () => TASK) as unknown as ToolServer;
async function call(name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; text: string; ms: number }> {
  const start = performance.now();
  const result = await tools.instance._registeredTools[name]!.handler(args, {});
  const outcome = { result, text: textOf(result), ms: Math.round(performance.now() - start) };
  // VERBOSE=1 bun run check:actions — tampilkan teks hasil tool persis seperti yang dibaca agen.
  if (process.env.VERBOSE === "1") console.log(`\n── ${name} ${JSON.stringify(args)} · ${outcome.ms} ms\n${outcome.text}\n`);
  return outcome;
}
const refOf = (text: string, pattern: RegExp): string | undefined => text.match(pattern)?.[1];

try {
  const opened = await call("open", { url: `${base}/`, width: 1200, height: 800 });
  const page = await session.getPage();
  check("A0 open: halaman tenang dan ringkasan isinya disebut", !opened.result.isError && opened.text.includes("Halaman tenang setelah") && /Isi: .*tautan, .*tombol, .*field/.test(opened.text), opened.text);

  // ---------- snapshot ----------
  const snap = await call("snapshot", {});
  check("A1 snapshot: elemen ber-ref, posisi gulir disebut", !snap.result.isError && snap.text.includes("[ref=e") && snap.text.includes("Posisi:"), snap.text.slice(0, 300));
  check("A1b snapshot: div kustom yang bisa diklik ditandai cursor=pointer", /Kartu kustom/.test(snap.text) && /\[cursor=pointer\]: Kartu kustom/.test(snap.text), snap.text);
  check("A1c snapshot: menu tersembunyi tidak tercantum", !snap.text.includes("Arsipkan") && (snap.text.match(/link "Model Skor"/g) ?? []).length === 1);
  const scoped = await call("snapshot", { selector: "table" });
  check("A1d snapshot terbatas: hanya isi tabel", !scoped.result.isError && scoped.text.includes('button "Edit"') && !scoped.text.includes("Model Skor") && scoped.text.includes("Bagian: table"), scoped.text);

  // ---------- klik lewat ref ----------
  const sari = [...snap.text.matchAll(/button "Edit" \[ref=(e\d+)\]/g)].map((match) => match[1])[1];
  const clickSari = await call("click", { ref: sari });
  check("A2 click ref: tombol Edit baris Sari yang kena, dan namanya disebut dengan barisnya", (await page.title()) === "edit Sari" && clickSari.text.includes('Diklik: button "Edit" (baris "Sari")'), clickSari.text);
  const frameRef = refOf(snap.text, /button "Tombol bingkai" \[ref=(f\d+e\d+)\]/);
  const clickFrame = await call("click", { ref: frameRef });
  check("A2b click ref di dalam iframe", Boolean(frameRef) && !clickFrame.result.isError && (await page.title()) === "bingkai diklik", { frameRef, text: clickFrame.text });
  await call("snapshot", { selector: "table" });
  const kartuRef = refOf(snap.text, /generic \[ref=(e\d+)\] \[cursor=pointer\]: Kartu kustom/);
  const outside = await call("click", { ref: kartuRef });
  check("A2c ref dari snapshot penuh tetap berlaku setelah snapshot terbatas", !outside.result.isError && (await page.textContent("#kartu")) === "Kartu diklik", outside.text);

  await page.evaluate(() => document.querySelectorAll("table button")[0]?.remove());
  const budi = [...snap.text.matchAll(/button "Edit" \[ref=(e\d+)\]/g)].map((match) => match[1])[0];
  const stale = await call("click", { ref: budi });
  check("A3 ref basi gagal cepat dan menyuruh snapshot", stale.result.isError === true && stale.ms < 1_500 && stale.text.includes("snapshot"), { ms: stale.ms, text: stale.text });
  const bogus = await call("click", { ref: "tombol-simpan" });
  check("A3b ref yang bukan format ref ditolak", bogus.result.isError === true && bogus.text.includes("tidak dikenal"), bogus.text);

  // ---------- selector/teks hanya mengenai yang terlihat ----------
  const byText = await call("click", { text: "Model Skor" });
  check("A4 click teks dengan duplikat tersembunyi: yang terlihat kena, cepat", !byText.result.isError && byText.ms < 2_000 && (await page.title()) === "model skor diklik", { ms: byText.ms, text: byText.text });
  const hidden = await call("click", { text: "Arsipkan" });
  check("A5 teks yang hanya cocok dengan elemen tersembunyi: gagal ±2 s dengan penjelasan", hidden.result.isError === true && hidden.ms >= 1_800 && hidden.ms < 3_500 && hidden.text.includes("tidak satu pun terlihat"), { ms: hidden.ms, text: hidden.text });

  await page.evaluate(() => {
    (document.getElementById("tirai") as HTMLElement).style.display = "block";
  });
  const covered = await call("click", { selector: "#tertutup" });
  check("A6 elemen tertutup overlay: gagal ≤ 7 s dan menyebut penghalangnya", covered.result.isError === true && covered.ms < 7_000 && covered.text.includes("tertutup oleh") && covered.text.includes("modal-backdrop"), { ms: covered.ms, text: covered.text });
  await page.evaluate(() => {
    (document.getElementById("tirai") as HTMLElement).style.display = "none";
  });

  // ---------- menunggu halaman tenang + perubahan ----------
  const muat = await call("click", { selector: "#muat" });
  check("A7 klik yang memuat data 800 ms: hasilnya sudah memuat datanya tanpa wait", muat.text.includes("Hasil dimuat: 3") && muat.text.includes("tenang setelah") && muat.ms < 3_000, { ms: muat.ms, text: muat.text });
  check("A7b paragraf hasil yang baru terisi muncul sebagai + saja, tanpa ~ induk yang kosong", !/^~ /m.test(muat.text) && /^\+ paragraph \[ref=e\d+\]: "Hasil dimuat: 3"$/m.test(muat.text), muat.text);
  const simpan = await call("click", { text: "Simpan" });
  const alertRef = refOf(simpan.text, /\+ alert \[ref=(e\d+)\]: Data tersimpan/);
  check("A8 toast yang muncul setelah klik tercantum dengan ref-nya", Boolean(alertRef), simpan.text);
  const fresh = await call("snapshot", {});
  const setuju = refOf(fresh.text, /checkbox "Setuju" \[ref=(e\d+)\]/);
  const centang = await call("click", { ref: setuju });
  check("A8b checkbox yang dicentang dilaporkan [checked]", /~ checkbox "Setuju" \[checked\] \[ref=e\d+\]/.test(centang.text), centang.text);
  const tanpaEfek = await call("click", { selector: "#tertutup" });
  check("A8c klik tanpa efek dilaporkan 'tidak ada perubahan'", tanpaEfek.text.includes("Tidak ada perubahan di halaman"), tanpaEfek.text);

  // ---------- fill ----------
  const email = await call("fill", { selector: "#email", value: "abcdefgh" });
  check("A9 fill yang dipotong maxlength diberi catatan nilai sebenarnya", email.text.includes('nilai field sekarang "abcde" (5 karakter), bukan yang diisi (8 karakter)'), email.text);
  const sandi = await call("fill", { selector: "#pw", value: "Rahasia123!" });
  const afterPw = await call("snapshot", {});
  check("A9b isi field password tidak pernah muncul di hasil fill maupun snapshot", !sandi.text.includes("Rahasia123!") && !afterPw.text.includes("Rahasia123!") && afterPw.text.includes("••••••"), { fill: sandi.text, snapshot: afterPw.text.match(/textbox "Sandi".*/)?.[0] });
  const cari = await call("fill", { selector: "#cari", value: "Be" });
  const bekasi = refOf(cari.text, /option "Bekasi" \[ref=(e\d+)\]/);
  check("A9c fill autocomplete: diberi arahan dan sarannya muncul dengan ref", cari.text.includes("autocomplete/combobox") && Boolean(bekasi), cari.text);
  const pilih = await call("click", { ref: bekasi });
  check("A9d saran dipilih lewat ref-nya", !pilih.result.isError && (await page.title()) === "kota Bekasi", pilih.text);
  check(
    "A9e daftar saran yang muncul/hilang tidak membuat induknya ikut dilaporkan",
    !cari.text.includes("~ generic") && !pilih.text.includes("~ generic") && /^− listbox "Saran kota" \[ref=e\d+\]$/m.test(pilih.text),
    { cari: cari.text, pilih: pilih.text },
  );

  // ---------- select ----------
  const klikSelect = await call("click", { selector: "#kota" });
  check("A10 klik <select> native diberi catatan berisi opsinya", klikSelect.text.includes("pakai select_option") || klikSelect.text.includes("Pakai select_option"), klikSelect.text);
  check("A10b catatan memuat daftar opsi", klikSelect.text.includes("Bandung | Jakarta"), klikSelect.text);
  const salah = await call("select_option", { selector: "#kota", label: "Surabaya" });
  check("A10c opsi yang tidak ada: daftar opsi yang tersedia disebut", salah.result.isError === true && salah.text.includes("Bandung (value=bdg)") && salah.text.includes("Jakarta (value=jkt)"), salah.text);
  const benar = await call("select_option", { selector: "#kota", label: "Jakarta" });
  check("A10d select_option yang benar tetap jalan, dinamai dari label tanpa teks opsinya", !benar.result.isError && (await page.inputValue("#kota")) === "jkt" && benar.text.startsWith("Terpilih pada “Kota” (#kota): jkt"), benar.text);
  check("A10e perubahan pilihan tampil sebagai opsi yang kini [selected]", /~ combobox "Kota" \[ref=e\d+\]\n\s+- option "Bandung"\n\s+- option "Jakarta" \[selected\]/.test(benar.text), benar.text);

  // ---------- unduhan ----------
  const viaOpen = await call("open", { url: `${base}/ekspor.csv` });
  const downloads = join(taskDir(TASK), "downloads");
  check(
    "A11 open ke URL ekspor: bukan galat, berkasnya dilaporkan dengan cuplikan isi",
    !viaOpen.result.isError && viaOpen.text.includes("./downloads/data ekspor.csv") && viaOpen.text.includes("3 baris") && viaOpen.text.includes("1,Budi,aktif"),
    viaOpen.text,
  );
  check("A11b berkas unduhan ada di folder tugas dan tampil di Lampiran", existsSync(join(downloads, "data ekspor.csv")) && listDocs(TASK).some((doc) => doc.path === "downloads/data ekspor.csv"), listDocs(TASK).map((doc) => doc.path));
  await call("open", { url: `${base}/` });
  const viaClick = await call("click", { text: "Ekspor CSV" });
  check("A12 klik tautan Ekspor: unduhan dilaporkan, nama kembar tidak menimpa, halaman tetap", viaClick.text.includes("./downloads/data ekspor (2).csv") && page.url() === `${base}/` && readFileSync(join(downloads, "data ekspor (2).csv"), "utf8").startsWith("id,nama"), viaClick.text);

  writeFileSync(join(downloads, "qr.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  check("A12b gambar hasil ekspor di downloads/ ikut tampil di Lampiran", listDocs(TASK).some((doc) => doc.path === "downloads/qr.png"), listDocs(TASK).map((doc) => doc.path));

  // ---------- tab baru & pindah halaman ----------
  const tab = await call("click", { text: "Buka laporan" });
  check("A13 tautan target=_blank: tab baru dilaporkan lalu ditutup", tab.text.includes("Tab baru dibuka") && tab.text.includes("/tujuan") && tab.text.includes("Laporan") && page.context().pages().length === 1, { text: tab.text, pages: page.context().pages().length });
  const pindah = await call("click", { text: "Ke laporan" });
  check("A13b pindah halaman diringkas: judul dan heading halaman baru", pindah.text.includes("Pindah halaman") && pindah.text.includes('H1 "Laporan bulanan"'), pindah.text);

  // ---------- wait ----------
  await call("open", { url: `${base}/` });
  await call("click", { selector: "#proses" });
  const tunggu = await call("wait", { text: "Proses selesai" });
  check("A14 wait({ text }) menunggu teks yang muncul belakangan", !tunggu.result.isError && tunggu.text.includes("sudah terlihat") && tunggu.ms < 2_000, { ms: tunggu.ms, text: tunggu.text });

  const tooltip = await call("hover", { selector: "#info" });
  check("A14b hover: tooltip yang ditunda 600 ms tetap tercantum di perubahan", /^\+ tooltip.*Penjelasan singkat/m.test(tooltip.text), tooltip.text);

  await page.focus("#email");
  const tabbed = await call("press", { key: "Tab" });
  check("A14c press Tab menyebut elemen yang fokus sesudahnya beserta ref-nya", /^Fokus sekarang: textbox "Sandi" \[(f\d+)?e\d+\]$/m.test(tabbed.text), tabbed.text);

  // ---------- open SPA & halaman kosong ----------
  const spa = await call("open", { url: `${base}/spa` });
  check("A15 open SPA: konten dari fetch 800 ms sudah ada di ringkasan tanpa wait", spa.text.includes('H1 "Dasbor"') && spa.text.includes("1 tombol"), spa.text);
  const kosong = await call("open", { url: `${base}/kosong` });
  check("A15b open halaman kosong: disarankan menunggu", kosong.text.includes("tampak kosong"), kosong.text);

  // ---------- autocomplete dengan debounce ----------
  await call("open", { url: `${base}/saran` });
  const ketik = await call("fill", { selector: "#tujuan", value: "Be" });
  check("A17 fill autocomplete ber-debounce 350 ms + fetch: sarannya sudah ada di hasil fill", /option "Bekasi" \[ref=(f\d+)?e\d+\]/.test(ketik.text) && ketik.ms < 3_000, { ms: ketik.ms, text: ketik.text });

  // ---------- halaman yang terus "sibuk" ----------
  await page.route("https://www.google-analytics.com/**", (route) => {
    setTimeout(() => route.fulfill({ status: 204, body: "" }).catch(() => undefined), 3_000);
  });
  const sibuk = await call("open", { url: `${base}/sibuk` });
  check(
    "A18 open halaman dengan long-poll: berhenti menunggu setelah ±3 s dan menyebut request yang menggantung",
    sibuk.ms < 5_000 && sibuk.text.includes("tenang setelah") && sibuk.text.includes("kecuali request yang masih berjalan lama: GET /api/longpoll"),
    { ms: sibuk.ms, text: sibuk.text },
  );
  const diam = await call("click", { selector: "#diam" });
  check("A18b long-poll dari sebelum aksi + marquee JS tiap frame: klik tetap tenang cepat", diam.ms < 1_500 && diam.text.includes("tenang setelah"), { ms: diam.ms, text: diam.text });
  const lacak = await call("click", { selector: "#lacak" });
  check("A18c request telemetri (google-analytics) tidak ditunggu", lacak.ms < 1_500 && lacak.text.includes("tenang setelah"), { ms: lacak.ms, text: lacak.text });
  await page.unroute("https://www.google-analytics.com/**");
  // Long-poll yang baru tersambung ulang tepat sebelum aksi (masih muda, < 3 s) bukan akibat aksi ini.
  await page.evaluate(() => {
    fetch("/api/longpoll").catch(() => {});
  });
  await page.waitForTimeout(200);
  const sambungUlang = await call("click", { selector: "#diam" });
  check("A18d request yang dimulai sebelum aksi tidak ditunggu walau masih muda", sambungUlang.ms < 1_500 && sambungUlang.text.includes("tenang setelah"), { ms: sambungUlang.ms, text: sambungUlang.text });

  // ---------- halaman berat ----------
  await call("open", { url: `${base}/besar` });
  const berat = await call("click", { selector: "#tambah" });
  check("A16 halaman 2.000 baris: aksi tetap cepat dan ringkasan perubahan dilewati", !berat.result.isError && berat.ms < 3_500 && berat.text.includes("dilewati"), { ms: berat.ms, text: berat.text });
  const berat2 = await call("click", { selector: "#tambah" });
  check("A16b aksi berikutnya di halaman yang sama tidak memotret ulang", berat2.ms < 1_500, { ms: berat2.ms });
} finally {
  await session.close();
  server.close();
}

rmSync(sandbox, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} pengujian gagal`);
  process.exit(1);
}
console.log("Semua pengujian lulus.");
process.exit(0);
