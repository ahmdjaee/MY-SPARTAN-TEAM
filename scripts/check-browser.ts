/**
 * Uji tool browser QA tanpa biaya model: npm run check:browser
 *
 * Fixture-nya meniru kasus nyata yang pernah salah dilaporkan sebagai bug —
 * tabel lebar di dalam container `overflow-x: auto` (T-019 temuan R-1) — plus
 * sel ber-ellipsis, tombol hapus dengan `confirm()`, select, dan tooltip hover.
 */
import { chromium } from "playwright";
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

console.log("\nContoh keluaran inspect yang dibaca QA:\n");
console.log(formatInspect(await inspect(page, "#t"), "#t"));

await browser.close();
console.log(`\n${gagal === 0 ? "Semua kasus sesuai harapan" : `${gagal} kasus GAGAL`}`);
if (gagal > 0) process.exitCode = 1;
