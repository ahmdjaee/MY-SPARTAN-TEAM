/**
 * Uji tool browser QA tanpa biaya model: bun run check:browser
 *
 * Fixture-nya meniru kasus nyata yang pernah salah dilaporkan sebagai bug —
 * tabel lebar di dalam container `overflow-x: auto` (T-019 temuan R-1) — plus
 * sel ber-ellipsis, tombol hapus dengan `confirm()`, select, dan tooltip hover.
 */
import { chromium } from "playwright";
import { BrowserSession } from "../server/browser/mcp.ts";
import { DialogWatcher, formatInspect, inspect, readText, scroll, verdictLines } from "../server/browser/ops.ts";

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>fixture QA</title>
<style>body{margin:0;font:14px sans-serif}td{border:1px solid #ccc}</style>
<div id="box" style="width:600px;overflow-x:auto">
  <table id="t" style="min-width:1200px;border-collapse:collapse"><tbody><tr>
    <td style="width:300px">Time</td><td style="width:300px">User</td>
    <td style="width:300px">Activity</td><td id="last" style="width:300px">Go to</td>
  </tr></tbody></table>
  <div id="cutin" style="width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">catatan di dalam container yang bisa di-scroll</div>
</div>
<div id="cut" style="width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">teks panjang yang dipotong ellipsis</div>
<button id="del">Hapus</button>
<select id="s"><option value="a">Opsi A</option><option value="b">Opsi B</option></select>
<div id="h">hover saya</div><div id="tip" style="display:none">tooltip muncul</div>
<div style="height:2000px"></div>
<script>
  document.getElementById('del').addEventListener('click', () => {
    if (confirm('Hapus data ini?')) document.title = 'terhapus';
  });
  document.getElementById('h').addEventListener('mouseover', () => {
    document.getElementById('tip').style.display = 'block';
  });
</script>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const dialogs = new DialogWatcher();
dialogs.attach(page);
await page.setContent(FIXTURE);

let gagal = 0;
async function check(name: string, run: () => Promise<string | true>): Promise<void> {
  let hasil: string | true;
  try {
    hasil = await run();
  } catch (error) {
    hasil = error instanceof Error ? error.message : String(error);
  }
  if (hasil !== true) gagal += 1;
  console.log(`${hasil === true ? "  ok  " : "GAGAL "} ${name}${hasil === true ? "" : `\n         → ${hasil}`}`);
}

const need = (kondisi: boolean, pesan: string): string | true => (kondisi ? true : pesan);

// 1. Scroller ketemu di nenek-moyang, bukan di elemen yang diminta.
await check("inspect(#t): scroller ketemu di div#box, bukan di tabelnya", async () => {
  const [report] = await inspect(page, "#t");
  if (!report) return "tidak ada laporan";
  return need(
    report.scrollableX === false &&
      report.scroller?.name === "div#box" &&
      report.scroller.scrollableX === true &&
      report.scroller.scrollWidth > report.scroller.clientWidth,
    `scrollableX=${report.scrollableX} scroller=${report.scroller?.name} scrollableX(scroller)=${report.scroller?.scrollableX}`,
  );
});

await check("inspect(#t): kesimpulannya 'BUKAN teks terpotong'", async () => {
  const [report] = await inspect(page, "#t");
  if (!report) return "tidak ada laporan";
  const verdict = verdictLines(report).join(" ");
  return need(verdict.includes("BUKAN teks terpotong"), verdict);
});

// 2. Kolom terakhir di luar container sebelum di-scroll, masuk setelah di-scroll ke kanan.
await check("sebelum scroll: kolom #last ada di luar kotak div#box", async () => {
  const box = await page.locator("#box").boundingBox();
  const last = await page.locator("#last").boundingBox();
  if (!box || !last) return "boundingBox kosong";
  return need(last.x >= box.x + box.width, `last.x=${last.x} batas kanan box=${box.x + box.width}`);
});

await check("scroll(#t, to:right): mentok kanan dan kolom #last jadi terlihat", async () => {
  const report = await scroll(page, { selector: "#t", to: "right" });
  if (report.scroller !== "div#box") return `scroller=${report.scroller}`;
  if (!(report.maxLeft > 0 && report.left === report.maxLeft)) return `left=${report.left} maxLeft=${report.maxLeft}`;
  const box = await page.locator("#box").boundingBox();
  const last = await page.locator("#last").boundingBox();
  if (!box || !last) return "boundingBox kosong";
  return need(
    last.x >= box.x - 1 && last.x + last.width <= box.x + box.width + 1,
    `last=${last.x}..${last.x + last.width} box=${box.x}..${box.x + box.width}`,
  );
});

await check("scroll(#t, to:left): kembali ke posisi awal", async () => {
  const report = await scroll(page, { selector: "#t", to: "left" });
  return need(report.left === 0, `left=${report.left}`);
});

await check("scroll(#t, dx:120): geser relatif", async () => {
  const report = await scroll(page, { selector: "#t", dx: 120 });
  await scroll(page, { selector: "#t", to: "left" });
  return need(report.left === 120, `left=${report.left}`);
});

// 3. Teks yang benar-benar dipotong ellipsis: teks penuhnya tetap bisa dibaca.
await check("inspect(#cut): terdeteksi dipotong ellipsis, teks penuh tetap terbaca", async () => {
  const [report] = await inspect(page, "#cut");
  if (!report) return "tidak ada laporan";
  return need(
    report.clippedByEllipsis === true &&
      report.scrollableX === false &&
      report.hiddenOverflowX === true &&
      report.text === "teks panjang yang dipotong ellipsis",
    `ellipsis=${report.clippedByEllipsis} scrollableX=${report.scrollableX} hidden=${report.hiddenOverflowX} teks="${report.text}"`,
  );
});

// 3b. Sel ber-ellipsis DI DALAM container yang bisa di-scroll: jangan "diselamatkan" container.
await check("inspect(#cutin): ellipsis di dalam container scrollable tetap dinilai terpotong", async () => {
  const [report] = await inspect(page, "#cutin");
  if (!report) return "tidak ada laporan";
  const verdict = verdictLines(report).join(" ");
  if (report.scroller?.scrollableX !== true) return `scroller=${report.scroller?.name}`;
  return need(
    report.clippedByEllipsis === true &&
      verdict.includes("dipotong ellipsis") &&
      !verdict.includes("BUKAN teks terpotong"),
    verdict,
  );
});

// 4. Baca isi tabel sebagai teks, tanpa bergantung pada gambar.
await check("text(#t td): 4 sel terbaca termasuk kolom yang tidak terlihat", async () => {
  const { texts, total } = await readText(page, "#t td");
  return need(total === 4 && texts[3] === "Go to", `total=${total} texts=${JSON.stringify(texts)}`);
});

// 5. Dialog native: bawaan tetap dismiss, dan tercatat.
await check("click tanpa dialog(): confirm dibatalkan (perilaku bawaan) tapi tercatat", async () => {
  const before = dialogs.count();
  await page.locator("#del").click();
  const seen = dialogs.takeSince(before);
  const title = await page.title();
  return need(
    title === "fixture QA" && seen.length === 1 && seen[0]!.includes("dismiss (bawaan"),
    `title="${title}" seen=${JSON.stringify(seen)}`,
  );
});

// 6. Dialog native: dipasang accept → tombol hapus benar-benar jalan.
await check("dialog(accept) lalu click: confirm ditekan OK", async () => {
  dialogs.arm("accept", undefined, 1);
  const before = dialogs.count();
  await page.locator("#del").click();
  const seen = dialogs.takeSince(before);
  const title = await page.title();
  return need(
    title === "terhapus" && seen.length === 1 && seen[0]!.includes("→ accept"),
    `title="${title}" seen=${JSON.stringify(seen)}`,
  );
});

// 7. Interaksi yang sebelumnya tidak ada tool-nya.
await check("select_option: opsi b terpilih", async () => {
  const selected = await page.locator("#s").first().selectOption({ value: "b" });
  return need(selected.join(",") === "b", `selected=${JSON.stringify(selected)}`);
});

await check("hover: tooltip muncul", async () => {
  await page.locator("#h").hover();
  return need(await page.locator("#tip").isVisible(), "tooltip tidak terlihat");
});

// 8. Tanpa selector, yang digulung adalah dokumennya.
await check("scroll(to:bottom) tanpa selector: dokumen tergulung sampai bawah", async () => {
  const report = await scroll(page, { to: "bottom" });
  return need(
    report.target === "dokumen" && report.maxTop > 0 && report.top === report.maxTop,
    `target=${report.target} top=${report.top} maxTop=${report.maxTop}`,
  );
});

await check("inspect selector tidak ada: pesan error yang jelas", async () => {
  try {
    await inspect(page, "#tidak-ada");
    return "seharusnya melempar error";
  } catch (error) {
    return need(String(error).includes("tidak ada elemen"), String(error));
  }
});

// 9. Gaya visual untuk audit UI/UX: angkanya dihitung, atau jujur bilang tidak bisa.
const VISUAL = `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#fff;color:#000">
<p id="hitam">hitam di putih</p>
<p id="abu" style="color:#777">abu-abu di putih</p>
<div style="background:#111"><p id="gelap" style="color:#fff">putih di ancestor gelap</p></div>
<p id="oklch" style="color:oklch(0 0 0)">warna oklch</p>
<p id="alpha" style="color:rgba(0,0,0,.5)">teks setengah transparan</p>
<div style="background:rgba(0,0,0,.5)"><p id="latar-alpha" style="color:#fff">background setengah transparan</p></div>
<div style="background:linear-gradient(#000,#fff)"><p id="gradient">di atas gradient</p></div>
<div style="opacity:.5"><p id="redup">di dalam opacity</p></div>
<p id="besar" style="color:#777;font-size:24px">teks besar</p>
<div id="wadah"><span>teks ada di anak</span></div>
</body>`;
await page.setContent(VISUAL);

const visual = async (selector: string) => {
  const [report] = await inspect(page, selector);
  if (!report) throw new Error(`tidak ada laporan untuk ${selector}`);
  return report.visual;
};

await check("kontras: hitam di putih = 21:1", async () => {
  const { contrast, color, background } = await visual("#hitam");
  return need(contrast === 21 && color === "#000000" && background === "#ffffff", `${contrast} ${color} ${background}`);
});

await check("kontras: #777 di putih gagal AA dan dibulatkan ke bawah (4,47 < 4,5)", async () => {
  const { contrast, contrastTarget } = await visual("#abu");
  return need(contrast === 4.47 && contrastTarget === 4.5, `${contrast} target ${contrastTarget}`);
});

await check("kontras: background diambil dari ancestor", async () => {
  const { contrast, background } = await visual("#gelap");
  return need(background === "#111111" && contrast === 18.88, `${contrast} ${background}`);
});

await check("kontras: warna oklch() terbaca", async () => {
  const { contrast } = await visual("#oklch");
  return need(contrast === 21, `${contrast}`);
});

await check("kontras: teks transparan dicampur dengan background", async () => {
  const { contrast } = await visual("#alpha");
  return need(contrast !== undefined && contrast > 3.9 && contrast < 4.1, `${contrast}`);
});

await check("kontras: background transparan dicampur dengan lapisan bawahnya", async () => {
  const { contrast, background } = await visual("#latar-alpha");
  // Alpha 0,5 dibaca canvas sebagai 127 atau 128 dari 255, jadi hasilnya boleh meleset satu angka.
  return need(/^#(7f7f7f|808080)$/.test(background ?? "") && contrast !== undefined && contrast > 3.9 && contrast < 4.1, `${contrast} ${background}`);
});

await check("kontras: gradient tidak dihitung", async () => {
  const { contrast, background, contrastNote } = await visual("#gradient");
  return need(contrast === undefined && background === undefined && /gradient/.test(contrastNote ?? ""), `${contrast} ${contrastNote}`);
});

await check("kontras: opacity pada ancestor tidak dihitung", async () => {
  const { contrast, contrastNote } = await visual("#redup");
  return need(contrast === undefined && /opacity/.test(contrastNote ?? ""), `${contrast} ${contrastNote}`);
});

await check("kontras: teks besar memakai batas 3:1", async () => {
  const { contrast, contrastTarget } = await visual("#besar");
  return need(contrast === 4.47 && contrastTarget === 3, `${contrast} target ${contrastTarget}`);
});

await check("kontras: elemen tanpa teks langsung tidak diberi angka", async () => {
  const { contrast, contrastNote } = await visual("#wadah");
  return need(contrast === undefined && /teks langsung/.test(contrastNote ?? ""), `${contrast} ${contrastNote}`);
});

await check("formatInspect: vonis AA tertulis", async () => {
  const gagalAa = formatInspect(await inspect(page, "#abu"), "#abu");
  const lolosAa = formatInspect(await inspect(page, "#hitam"), "#hitam");
  return need(gagalAa.includes("GAGAL AA") && lolosAa.includes("lolos AA"), `${gagalAa}\n${lolosAa}`);
});

// 10. Viewport berubah pada open kedua. Dulu diam-diam tetap memakai ukuran pertama.
const session = new BrowserSession(() => undefined);
await check("BrowserSession: viewport mengikuti permintaan terakhir", async () => {
  const width = async (page: Awaited<ReturnType<BrowserSession["getPage"]>>) => await page.evaluate("window.innerWidth");
  const pertama = await width(await session.getPage({ width: 1440, height: 900 }));
  const kedua = await width(await session.getPage({ width: 390, height: 844 }));
  const tanpaUkuran = await width(await session.getPage());
  return need(pertama === 1440 && kedua === 390 && tanpaUkuran === 390, `${pertama} → ${kedua} → ${tanpaUkuran}`);
});
await session.close();

await page.setContent(FIXTURE);

console.log("\nContoh keluaran inspect yang dibaca QA:\n");
console.log(formatInspect(await inspect(page, "#t"), "#t"));

await browser.close();
console.log(`\n${gagal === 0 ? "Semua kasus sesuai harapan" : `${gagal} kasus GAGAL`}`);
if (gagal > 0) process.exitCode = 1;
