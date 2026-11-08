import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Download, Page } from "playwright";
import { clip, within } from "./outcome.ts";

/**
 * Unduhan dari halaman yang diuji (tombol Ekspor, URL ekspor, PDF). Dulu `open` ke URL ekspor gagal
 * dengan "Download is starting" dan klik Ekspor diam-diam membuang berkasnya; sekarang berkasnya
 * disimpan di `<folder tugas>/downloads/` — otomatis tampil di tab Lampiran — dan dilaporkan ke agen.
 */

export type DownloadRecord = {
  seq: number;
  url: string;
  suggested: string;
  /** Nama berkas di folder downloads, setelah tersimpan. */
  file?: string;
  path?: string;
  size?: number;
  error?: string;
  finished: boolean;
  done: Promise<void>;
};

/** Batas menunggu satu unduhan selesai sebelum aksi melapor; unduhannya sendiri tetap berjalan. */
export const DOWNLOAD_WAIT_MS = 30_000;
const MAX_RECORDS = 50;
/** Bagian awal berkas yang dibaca untuk jenis, jumlah baris, dan cuplikan. */
const HEAD_BYTES = 1 << 20;

/** Nama aman untuk disimpan: tanpa path, tanpa karakter aneh, tidak diawali titik. */
export function safeDownloadName(suggested: string): string {
  const name = basename(suggested.replace(/\\/g, "/"))
    .replace(/[^\p{L}\p{N}._ ()-]/gu, "-")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120);
  return name || "unduhan";
}

export class DownloadTracker {
  private records: DownloadRecord[] = [];
  private seq = 0;
  /** Nama yang sudah dipesan unduhan yang sedang berjalan, supaya dua unduhan bernama sama tidak saling timpa. */
  private readonly taken = new Set<string>();
  private waiters = new Set<() => void>();

  constructor(private readonly dir: () => string) {}

  attach(page: Page): void {
    page.on("download", (download) => this.capture(download));
  }

  count(): number {
    return this.seq;
  }

  private capture(download: Download): void {
    this.seq += 1;
    const record: DownloadRecord = {
      seq: this.seq,
      url: download.url(),
      suggested: download.suggestedFilename(),
      finished: false,
      done: Promise.resolve(),
    };
    record.done = this.save(download, record);
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.shift();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  /**
   * Tunggu sampai ada unduhan baru setelah `seq`. `goto` melempar "Download is starting" sebelum
   * event download-nya sampai, jadi tanpa ini laporan `open` keluar sebelum unduhannya tercatat.
   */
  async started(seq: number, ms: number): Promise<boolean> {
    if (this.seq > seq) return true;
    let wake: (() => void) | undefined;
    const arrived = new Promise<boolean>((resolve) => {
      wake = () => resolve(true);
      this.waiters.add(wake);
    });
    const result = await within(arrived, ms);
    if (wake) this.waiters.delete(wake);
    return result ?? false;
  }

  private async save(download: Download, record: DownloadRecord): Promise<void> {
    try {
      const dir = this.dir();
      mkdirSync(dir, { recursive: true });
      const name = this.reserve(dir, safeDownloadName(record.suggested));
      const path = join(dir, name);
      await download.saveAs(path);
      record.file = name;
      record.path = path;
      record.size = statSync(path).size;
    } catch (error) {
      const failure = await download.failure().catch(() => null);
      record.error = failure ?? (error instanceof Error ? error.message.split("\n")[0] : String(error));
    } finally {
      record.finished = true;
    }
  }

  private reserve(dir: string, name: string): string {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; ; n += 1) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      if (this.taken.has(`${dir}/${candidate}`) || existsSync(join(dir, candidate))) continue;
      this.taken.add(`${dir}/${candidate}`);
      return candidate;
    }
  }

  /** Unduhan sejak `seq`, ditunggu sampai tersimpan (paling lama `waitMs`). */
  async since(seq: number, waitMs = DOWNLOAD_WAIT_MS): Promise<DownloadRecord[]> {
    const fresh = this.records.filter((record) => record.seq > seq);
    if (fresh.length > 0) await within(Promise.all(fresh.map((record) => record.done)), waitMs);
    return fresh;
  }
}

function readHead(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

const TEXT_KINDS: Record<string, string> = {
  ".csv": "CSV",
  ".tsv": "TSV",
  ".json": "JSON",
  ".txt": "teks",
  ".xml": "XML",
  ".html": "HTML",
  ".htm": "HTML",
  ".md": "Markdown",
};
const ZIP_KINDS: Record<string, string> = {
  ".xlsx": "Excel (xlsx)",
  ".docx": "Word (docx)",
  ".pptx": "PowerPoint (pptx)",
  ".ods": "spreadsheet ODS",
  ".odt": "dokumen ODT",
};

/** Jenis berkas dari isinya (bukan dari nama saja) — ekspor "xlsx" yang ternyata halaman error ketahuan. */
function sniff(head: Buffer, name: string): { label: string; text: boolean } {
  const ext = extname(name).toLowerCase();
  const starts = (bytes: number[]) => bytes.every((byte, i) => head[i] === byte);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return { label: "PDF", text: false };
  if (starts([0x50, 0x4b, 0x03, 0x04])) return { label: ZIP_KINDS[ext] ?? "ZIP", text: false };
  if (starts([0xd0, 0xcf, 0x11, 0xe0])) return { label: "dokumen Office lama (xls/doc)", text: false };
  if (starts([0x89, 0x50, 0x4e, 0x47])) return { label: "gambar PNG", text: false };
  if (starts([0xff, 0xd8, 0xff])) return { label: "gambar JPEG", text: false };
  if (head.subarray(0, 8192).includes(0)) return { label: "biner", text: false };
  const kind = TEXT_KINDS[ext] ?? "teks";
  const looksHtml = /^\s*<(!doctype html|html)/i.test(head.subarray(0, 512).toString("utf8"));
  if (looksHtml && kind !== "HTML") return { label: `HTML (padahal namanya ${ext || "tanpa ekstensi"} — mungkin halaman error)`, text: true };
  return { label: kind, text: true };
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "? byte";
  if (bytes < 1024) return `${bytes} byte`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1).replace(".", ",")} KB`;
  return `${(kb / 1024).toFixed(1).replace(".", ",")} MB`;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return clip(`${parsed.host}${parsed.pathname}${parsed.search}`, 100);
  } catch {
    return clip(url, 100);
  }
}

/** Laporan satu unduhan untuk agen: nama, ukuran, jenis, dan cuplikan isi untuk berkas teks. */
export function describeDownload(record: DownloadRecord): string {
  if (record.error) return `Unduhan gagal: ${record.suggested} — ${record.error}`;
  if (!record.finished || !record.file || !record.path) {
    return `Unduhan ${record.suggested} masih berjalan setelah ${DOWNLOAD_WAIT_MS / 1000} s — berkasnya muncul di tab Lampiran (./downloads/) begitu selesai.`;
  }
  const head = readHead(record.path);
  const kind = sniff(head, record.file);
  const lines = [`Unduhan tersimpan: ./downloads/${record.file} (${formatSize(record.size)}, ${kind.label}) — dari ${shortUrl(record.url)}`];
  if (record.size === 0) {
    lines.push("Berkasnya KOSONG (0 byte).");
  } else if (kind.text) {
    const content = head.toString("utf8").replace(/^﻿/, "");
    const rows = content.split(/\r?\n/);
    if (rows.at(-1) === "") rows.pop();
    const partial = (record.size ?? 0) > head.length;
    const preview: string[] = [];
    let chars = 0;
    for (const row of rows.slice(0, 5)) {
      const line = clip(row, 200);
      if (chars + line.length > 500) break;
      preview.push(`  │ ${line}`);
      chars += line.length;
    }
    lines.push(`${partial ? "≥ " : ""}${rows.length} baris. Awal isinya:`, ...preview);
  }
  return lines.join("\n");
}
