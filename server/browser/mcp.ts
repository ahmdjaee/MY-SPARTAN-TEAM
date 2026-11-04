import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { z } from "zod";
import { CONFIG } from "../config.ts";
import { assetsDir } from "../tasks.ts";
import { live } from "./live.ts";
import { KINDS, kindFromName, makeTestFile, type TestFileKind } from "./files.ts";
import { DialogWatcher, formatInspect, formatScroll, inspect, readText, scroll } from "./ops.ts";

type CallResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>;

const ok = (text: string): CallResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): CallResult => ({ content: [{ type: "text", text: `ERROR: ${text}` }], isError: true });

/** Sesi browser yang sedang hidup, supaya bisa ditutup dari luar saat tugas berakhir. */
const sessions = new Map<string, BrowserSession>();

/** Tutup browser milik satu tugas (dipanggil runner saat tugas ditutup/dioper/dibatalkan). */
export async function closeBrowserFor(taskId: string): Promise<void> {
  const session = sessions.get(taskId);
  if (!session) return;
  await session.close();
}

/** Satu sesi browser per tugas, dipakai ulang antar tool call. */
export class BrowserSession {
  private browser?: Browser;
  private page?: Page;
  private cdp?: CDPSession;
  private taskId?: string;
  private logs: string[] = [];
  readonly dialogs = new DialogWatcher();

  constructor(private readonly getTaskId: () => string | undefined) {}

  async getPage(viewport?: { width: number; height: number }): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    if (!this.page || this.page.isClosed()) {
      const context = await this.browser.newContext({
        viewport: viewport ?? { width: 1440, height: 900 },
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          this.logs.push(`[console.${message.type()}] ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => this.logs.push(`[pageerror] ${error.message}`));
      page.on("requestfailed", (request) =>
        this.logs.push(`[requestfailed] ${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "?"}`),
      );
      page.on("response", (response) => {
        if (response.status() >= 400) this.logs.push(`[http ${response.status()}] ${response.url()}`);
      });
      this.dialogs.attach(page);
      this.page = page;
      await this.startLive(page);
    }
    return this.page;
  }

  /**
   * Alirkan isi halaman ke panel Live lewat CDP screencast.
   * Kegagalan di sini tidak boleh menjatuhkan pengujian — fitur menonton itu tambahan.
   */
  private async startLive(page: Page): Promise<void> {
    const taskId = this.getTaskId();
    if (!taskId) return;
    this.taskId = taskId;
    sessions.set(taskId, this);

    try {
      const client = await page.context().newCDPSession(page);
      this.cdp = client;
      client.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
        live.publishFrame(taskId, Buffer.from(frame.data, "base64"));
        void client.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      });
      await client.send("Page.startScreencast", {
        format: "jpeg",
        quality: 55,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 2,
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) live.setState(taskId, { url: frame.url() });
      });
      page.on("close", () => live.stop(taskId));
      live.setState(taskId, { active: true, url: page.url() });
    } catch {
      this.cdp = undefined;
      live.setState(taskId, { active: false });
    }
  }

  requirePage(): Page {
    if (!this.page || this.page.isClosed()) throw new Error("belum ada halaman terbuka — panggil open() dulu");
    return this.page;
  }

  drainLogs(): string[] {
    const logs = this.logs;
    this.logs = [];
    return logs;
  }

  async close(): Promise<void> {
    if (this.taskId) {
      live.stop(this.taskId);
      sessions.delete(this.taskId);
    }
    await this.cdp?.detach().catch(() => undefined);
    await this.page?.context().close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.cdp = undefined;
    this.page = undefined;
    this.browser = undefined;
  }
}

/**
 * MCP server in-process berisi tool browser untuk QA.
 * `getTaskId` dievaluasi saat tool dipanggil, sehingga screenshot selalu
 * mendarat di folder tugas yang sedang dikerjakan.
 */
export function createBrowserServer(session: BrowserSession, getTaskId: () => string | undefined) {

  const shotDir = (): string => {
    const id = getTaskId();
    const dir = id ? assetsDir(id) : join(CONFIG.tasksDir, "_adhoc", "assets");
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  /** Berkas uji unggahan hidup di run_dir/uploads — ikut tampil di tab Lampiran sebagai bukti. */
  const uploadDir = (): string => {
    const id = getTaskId();
    const dir = id ? join(assetsDir(id), "..", "uploads") : join(CONFIG.tasksDir, "_adhoc", "uploads");
    mkdirSync(dir, { recursive: true });
    return resolve(dir);
  };

  /** Hanya berkas di dalam folder uploads yang boleh diserahkan ke halaman (penutup path traversal). */
  const resolveUpload = (name: string): string => {
    const dir = uploadDir();
    const target = resolve(dir, basename(name));
    if (!target.startsWith(`${dir}/`)) throw new Error(`${name}: di luar folder uploads`);
    if (!existsSync(target)) throw new Error(`${name}: tidak ada di ./uploads/ — buat dulu dengan make_file`);
    return target;
  };

  const locate = (page: Page, selector?: string, text?: string) => {
    if (selector) return page.locator(selector).first();
    if (text) return page.getByText(text, { exact: false }).first();
    throw new Error("butuh `selector` atau `text`");
  };

  return createSdkMcpServer({
    name: "browser",
    version: "0.1.0",
    instructions:
      "Browser Chromium headless untuk pengujian QA. Alur yang disarankan: open → snapshot → (click/fill/press/hover/select_option) → scroll/inspect → screenshot → console. Screenshot otomatis disimpan ke folder bukti laporan. " +
      "Sebelum melaporkan apa pun sebagai terpotong/tidak terlihat/hilang, panggil `inspect` — isi yang bisa di-scroll (scrollWidth > clientWidth dengan overflow auto|scroll) bukan teks terpotong, dan `scroll` bisa menggesernya. " +
      "Dialog native confirm/alert/prompt dibatalkan otomatis kecuali Anda memasang `dialog` lebih dulu.",
    tools: [
      tool(
        "open",
        "Buka URL di browser dan kembalikan judul serta status halaman.",
        {
          url: z.string().describe("URL lengkap termasuk http/https"),
          width: z.number().int().min(320).max(3840).optional(),
          height: z.number().int().min(320).max(2160).optional(),
        },
        async (args) => {
          try {
            const page = await session.getPage(
              args.width && args.height ? { width: args.width, height: args.height } : undefined,
            );
            const response = await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
            const taskId = getTaskId();
            if (taskId) live.setState(taskId, { url: page.url(), title: await page.title() });
            return ok(
              `Terbuka: ${page.url()}\nStatus HTTP: ${response?.status() ?? "(tidak ada respons)"}\nJudul: ${await page.title()}`,
            );
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "snapshot",
        "Ambil struktur accessibility halaman (elemen & teks yang bisa diklik). Pakai ini sebelum click/fill agar selector yang dipakai benar-benar ada.",
        { maxChars: z.number().int().min(500).max(40_000).optional() },
        async (args) => {
          try {
            const page = session.requirePage();
            const snapshot = await page.locator("body").ariaSnapshot();
            const max = args.maxChars ?? 12_000;
            return ok(
              `URL: ${page.url()}\nJudul: ${await page.title()}\n\n${snapshot.length > max ? `${snapshot.slice(0, max)}\n… (dipotong)` : snapshot}`,
            );
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "click",
        "Klik elemen berdasarkan CSS selector atau teks yang terlihat.",
        { selector: z.string().optional(), text: z.string().optional() },
        async (args) => {
          try {
            const page = session.requirePage();
            const before = session.dialogs.count();
            await locate(page, args.selector, args.text).click({ timeout: 10_000 });
            await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
            const dialogs = session.dialogs.takeSince(before);
            return ok(
              `Diklik: ${args.selector ?? args.text}\nURL sekarang: ${page.url()}${
                dialogs.length > 0
                  ? `\nDialog native yang muncul:\n${dialogs.join("\n")}\n(pakai tool \`dialog\` sebelum click kalau ingin menekan OK)`
                  : ""
              }`,
            );
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "fill",
        "Isi input/textarea dengan nilai tertentu.",
        { selector: z.string(), value: z.string() },
        async (args) => {
          try {
            const page = session.requirePage();
            await page.locator(args.selector).first().fill(args.value, { timeout: 10_000 });
            return ok(`Terisi: ${args.selector}`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "press",
        "Tekan tombol keyboard (contoh: Enter, Tab, Escape).",
        { key: z.string(), selector: z.string().optional() },
        async (args) => {
          try {
            const page = session.requirePage();
            if (args.selector) await page.locator(args.selector).first().press(args.key, { timeout: 10_000 });
            else await page.keyboard.press(args.key);
            return ok(`Tombol ${args.key} ditekan`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "wait",
        "Tunggu selector muncul/hilang, atau tunggu sejumlah milidetik.",
        {
          selector: z.string().optional(),
          state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
          ms: z.number().int().min(100).max(30_000).optional(),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            if (args.selector) {
              await page.locator(args.selector).first().waitFor({ state: args.state ?? "visible", timeout: 15_000 });
              return ok(`Selector ${args.selector} sudah ${args.state ?? "visible"}`);
            }
            await page.waitForTimeout(args.ms ?? 1_000);
            return ok(`Menunggu ${args.ms ?? 1_000}ms`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "scroll",
        "Gulung halaman atau isi sebuah container (termasuk HORIZONTAL). Tunjuk `selector` elemen yang isinya ingin digeser — tool mencari sendiri elemen yang benar-benar menggulung di atasnya (mis. .table-responsive / .dataTables_scrollBody). Tanpa to/dx/dy ia hanya melaporkan posisi sekarang.",
        {
          selector: z.string().optional().describe("elemen yang isinya ingin digeser; kosong = seluruh halaman"),
          to: z.enum(["left", "right", "top", "bottom"]).optional().describe("gulung sampai mentok ke satu sisi"),
          dx: z.number().optional().describe("geser horizontal relatif dalam px (negatif = ke kiri)"),
          dy: z.number().optional().describe("geser vertikal relatif dalam px"),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const report = await scroll(page, args);
            return ok(formatScroll(report));
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "inspect",
        "WAJIB sebelum melaporkan sesuatu sebagai terpotong/tidak terlihat. Melaporkan ukuran, scrollWidth vs clientWidth, overflow, text-overflow, scroller terdekat, dan TEKS PENUH elemen — sehingga jelas apakah isinya cuma perlu di-scroll atau benar-benar terpotong.",
        {
          selector: z.string().describe("CSS selector; boleh cocok ke beberapa elemen"),
          limit: z.number().int().min(1).max(20).optional().describe("berapa elemen dilaporkan (bawaan 3)"),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const reports = await inspect(page, args.selector, args.limit);
            return ok(formatInspect(reports, args.selector));
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "text",
        "Ambil teks penuh (textContent) elemen-elemen yang cocok — mis. seluruh isi baris tabel — tanpa bergantung pada apa yang terlihat di screenshot.",
        {
          selector: z.string(),
          limit: z.number().int().min(1).max(200).optional().describe("bawaan 20"),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const { texts, total } = await readText(page, args.selector, args.limit);
            const lines = texts.map((text, index) => `${index + 1}. ${text || "(kosong)"}`);
            return ok(
              `${args.selector} — ${total} elemen cocok${texts.length < total ? `, ${texts.length} ditampilkan` : ""}\n${lines.join("\n")}`,
            );
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "hover",
        "Taruh kursor di atas elemen (untuk tooltip, menu, atau tombol yang baru muncul saat di-hover).",
        { selector: z.string().optional(), text: z.string().optional() },
        async (args) => {
          try {
            const page = session.requirePage();
            await locate(page, args.selector, args.text).hover({ timeout: 10_000 });
            return ok(`Hover di: ${args.selector ?? args.text}`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "select_option",
        "Pilih opsi pada elemen <select> berdasarkan value atau label yang terlihat.",
        { selector: z.string(), value: z.string().optional(), label: z.string().optional() },
        async (args) => {
          try {
            if (!args.value && !args.label) throw new Error("butuh `value` atau `label`");
            const page = session.requirePage();
            const selected = await page
              .locator(args.selector)
              .first()
              .selectOption(args.value ? { value: args.value } : { label: args.label as string }, { timeout: 10_000 });
            return ok(`Terpilih pada ${args.selector}: ${selected.join(", ") || "(tidak ada)"}`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "dialog",
        "Tentukan apa yang dilakukan pada dialog native (confirm/alert/prompt) BERIKUTNYA, lalu baru panggil click. Tanpa ini dialog selalu dibatalkan (dismiss) — itu sebabnya tombol hapus yang memakai confirm() tidak pernah jadi. Jangan ganti klik konfirmasi dengan curl.",
        {
          action: z.enum(["accept", "dismiss"]).describe("accept = tekan OK, dismiss = tekan Cancel"),
          promptText: z.string().optional().describe("isi untuk dialog prompt()"),
          forNext: z.number().int().min(1).max(20).optional().describe("berlaku untuk N dialog berikutnya (bawaan 1)"),
        },
        async (args) => {
          const count = args.forNext ?? 1;
          session.dialogs.arm(args.action, args.promptText, count);
          const seen = session.dialogs.drain();
          return ok(
            `${count} dialog berikutnya akan di-${args.action}${args.promptText ? ` dengan teks "${args.promptText}"` : ""}. Sekarang panggil click pada tombol yang memunculkannya.${
              seen.length > 0 ? `\n\nDialog sebelum ini:\n${seen.join("\n")}` : ""
            }`,
          );
        },
      ),
      tool(
        "console",
        "Ambil error console, page error, request gagal, respons HTTP >= 400, dan dialog native yang muncul sejak panggilan terakhir.",
        {},
        async () => {
          const logs = [...session.drainLogs(), ...session.dialogs.drain()];
          return ok(logs.length === 0 ? "Tidak ada error console/jaringan/dialog baru." : logs.join("\n"));
        },
      ),
      tool(
        "screenshot",
        "Simpan screenshot sebagai bukti laporan. File masuk ke folder assets run yang aktif dan gambarnya dikembalikan ke Anda. " +
          "Perhatian: `fullPage` hanya memperbesar TINGGI dokumen — isi container yang bisa di-scroll (tabel lebar di dalam overflow-x: auto) tetap terpotong di gambar, dan scrollbar overlay tidak dilukis di headless. " +
          "Untuk area yang bisa di-scroll, ambil beberapa screenshot: satu di posisi awal, lalu `scroll` ke ujung dan ambil lagi.",
        {
          name: z.string().describe("nama deskriptif tanpa ekstensi, contoh: login-error-kredensial-salah"),
          fullPage: z.boolean().optional(),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const safeName = args.name.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 60) || "shot";
            const file = join(shotDir(), `${safeName}.png`);
            const buffer = await page.screenshot({ fullPage: args.fullPage ?? false, timeout: 20_000 });
            writeFileSync(file, buffer);
            return {
              content: [
                { type: "text", text: `Screenshot disimpan: ./assets/${safeName}.png (URL: ${page.url()})` },
                { type: "image", data: buffer.toString("base64"), mimeType: "image/png" },
              ],
            };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "discard_screenshot",
        "Hapus satu screenshot dari folder bukti run ini, untuk bukti yang ternyata tidak valid (mis. salah langkah). Hanya berlaku di folder bukti run yang aktif.",
        {
          name: z.string().describe("nama file tanpa path, dengan atau tanpa .png"),
          reason: z.string().describe("kenapa bukti ini dibuang — sebutkan juga di laporan"),
        },
        async (args) => {
          try {
            const dir = shotDir();
            const file = basename(args.name.endsWith(".png") ? args.name : `${args.name}.png`);
            const target = resolve(dir, file);
            // Penjaga: hanya file di dalam folder bukti run yang aktif yang boleh dihapus.
            if (!target.startsWith(`${resolve(dir)}/`)) return fail("di luar folder bukti run");
            if (!existsSync(target)) return fail(`tidak ada file ${file} di folder bukti`);
            unlinkSync(target);
            return ok(`Bukti ${file} dihapus. Alasan: ${args.reason}`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "make_file",
        "Buat berkas uji dummy di folder ./uploads/ tugas untuk dipakai `upload`. PNG/JPG/PDF valid, CSV/TXT/JSON berisi contoh, `bin` acak untuk uji tipe tak didukung. " +
          "`sizeKb` memadatkan berkas ke ukuran itu (uji batas ukuran) tanpa merusak formatnya.",
        {
          name: z.string().describe("nama berkas dengan ekstensi, mis. foto.png, data.csv, besar.pdf"),
          kind: z.enum(KINDS as [TestFileKind, ...TestFileKind[]]).optional().describe("bawaan: dari ekstensi nama"),
          sizeKb: z.number().int().min(1).max(50_000).optional().describe("ukuran akhir dalam KB"),
          text: z.string().optional().describe("isi untuk csv/txt/json (bawaan: contoh kecil yang valid)"),
          width: z.number().int().min(1).max(4096).optional().describe("png/jpg, bawaan 320"),
          height: z.number().int().min(1).max(4096).optional().describe("png/jpg, bawaan 240"),
        },
        async (args) => {
          try {
            const kind = args.kind ?? kindFromName(args.name);
            if (!kind) return fail(`ekstensi ${args.name} tidak dikenal — isi \`kind\` (${KINDS.join("/")})`);
            const safeName = basename(args.name).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || `uji.${kind}`;
            let jpeg: Buffer | undefined;
            if (kind === "jpg") {
              // Node tidak punya encoder JPEG; render halaman polos lewat Chromium.
              const page = await session.getPage();
              const scratch = await page.context().newPage();
              try {
                await scratch.setViewportSize({ width: args.width ?? 320, height: args.height ?? 240 });
                await scratch.setContent(
                  `<body style="margin:0;background:linear-gradient(135deg,#dbeafe,#2383e2);font:20px sans-serif;color:#fff;display:grid;place-items:center">${safeName}</body>`,
                );
                jpeg = await scratch.screenshot({ type: "jpeg", quality: 80 });
              } finally {
                await scratch.close().catch(() => undefined);
              }
            }
            const { buffer, mime } = makeTestFile({ ...args, name: safeName, kind, jpeg });
            const file = join(uploadDir(), safeName);
            writeFileSync(file, buffer);
            return ok(`Berkas uji dibuat: ./uploads/${safeName} (${buffer.length} byte, ${mime}). Pakai \`upload\` dengan files: ["${safeName}"].`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool(
        "upload",
        "Serahkan berkas dari ./uploads/ (buat dulu dengan make_file) ke input file halaman. Beri `selector` <input type=file> (boleh tersembunyi), " +
          "ATAU `clickSelector`/`clickText` tombol kustom yang membuka dialog pilih berkas. Tanpa keduanya dipakai input file pertama di halaman. `files: []` mengosongkan pilihan.",
        {
          files: z.array(z.string()).max(20).describe("nama berkas di ./uploads/"),
          selector: z.string().optional(),
          clickSelector: z.string().optional(),
          clickText: z.string().optional(),
        },
        async (args) => {
          try {
            const page = session.requirePage();
            const paths = args.files.map(resolveUpload);
            const before = session.dialogs.count();
            let target: string;
            if (args.clickSelector || args.clickText) {
              const [chooser] = await Promise.all([
                page.waitForEvent("filechooser", { timeout: 10_000 }),
                locate(page, args.clickSelector, args.clickText).click({ timeout: 10_000 }),
              ]);
              if (paths.length > 1 && !chooser.isMultiple()) {
                return fail("input ini hanya menerima satu berkas (tanpa atribut multiple) — kirim satu nama saja");
              }
              await chooser.setFiles(paths);
              target = `dialog pilih berkas dari ${args.clickSelector ?? args.clickText}`;
            } else {
              const selector = args.selector ?? 'input[type="file"]';
              const input = page.locator(selector).first();
              if ((await input.count()) === 0) {
                return fail(
                  args.selector
                    ? `tidak ada elemen ${selector}`
                    : "tidak ada <input type=file> di halaman — pakai clickSelector/clickText pada tombol unggahnya",
                );
              }
              await input.setInputFiles(paths, { timeout: 10_000 });
              target = selector;
            }
            // Banyak form langsung mengunggah begitu berkas dipilih; beri waktu requestnya jalan.
            await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
            const dialogs = session.dialogs.takeSince(before);
            return ok(
              `${paths.length === 0 ? "Pilihan berkas dikosongkan" : `Terunggah ke ${target}: ${args.files.join(", ")}`}\nURL sekarang: ${page.url()}${
                dialogs.length > 0 ? `\nDialog native yang muncul:\n${dialogs.join("\n")}` : ""
              }`,
            );
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      ),
      tool("close", "Tutup browser dan bebaskan resource.", {}, async () => {
        await session.close();
        return ok("Browser ditutup.");
      }),
    ],
  });
}
