import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG } from "./config.ts";

const MAX_BULLETS = 200;
const MAX_CHARS = 20_000;

export const MEMORY_TEMPLATE = `# Memori project

Catatan yang berlaku untuk semua tugas di project ini. Tim membacanya di setiap tugas baru.

## Lingkungan
- (URL staging, port, cara menjalankan aplikasi)

## Kredensial uji
- (akun uji yang boleh dipakai QA)

## Keputusan & pantangan
- (keputusan arsitektur, hal yang tidak boleh disentuh)

## Catatan tim
`;

export function trimMemory(text: string, max = MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…(dipotong)\n` : text;
}

/**
 * Tambah satu butir di bagian "Catatan tim" sebuah berkas memori.
 * Fungsi murni supaya memori global dan memori per project memakai aturan yang sama.
 */
export function appendBullet(current: string, note: string, taskId: string): string {
  const date = new Date().toISOString().slice(0, 10);
  // Agen kadang ikut menulis prefiks tanggal/id sendiri — buang supaya tidak ganda.
  const body = note
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^-\s*/, "")
    .replace(/^(\[\d{4}-\d{2}-\d{2}\]\s*)?(\([A-Za-z]+-\d+\)\s*)?/, "")
    .trim();
  const line = `- [${date}] (${taskId}) ${body}`;
  const next = current.includes("## Catatan tim")
    ? `${current.replace(/\s*$/, "")}\n${line}\n`
    : `${current.replace(/\s*$/, "")}\n\n## Catatan tim\n${line}\n`;

  const lines = next.split("\n");
  const bulletIndexes = lines.map((value, i) => (value.startsWith("- [") ? i : -1)).filter((i) => i >= 0);
  if (bulletIndexes.length > MAX_BULLETS) {
    const drop = new Set(bulletIndexes.slice(0, bulletIndexes.length - MAX_BULLETS));
    return lines.filter((_value, i) => !drop.has(i)).join("\n");
  }
  return next;
}

const GLOBAL_TEMPLATE = `# Memori global

Catatan yang berlaku untuk SEMUA project di mesin ini. Hal yang khusus satu project
ditulis di konteks/memori project itu, bukan di sini.

## Keputusan & pantangan
- (aturan yang berlaku di mana saja)
`;

export function readMemory(): string {
  if (!existsSync(CONFIG.memoryPath)) return GLOBAL_TEMPLATE;
  return readFileSync(CONFIG.memoryPath, "utf8");
}

export function writeMemory(text: string): string {
  const trimmed = trimMemory(text);
  writeFileSync(CONFIG.memoryPath, trimmed);
  return trimmed;
}
