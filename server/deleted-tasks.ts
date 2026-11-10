/**
 * Tombstone tugas yang sudah dihapus: data/deleted-tasks.json.
 *
 * Folder tugas hilang sepenuhnya, tapi report project masih merujuknya (register temuan,
 * cakupan, rekap per tugas). Tombstone menjaga tiga hal:
 *  - rujukan itu bisa ditandai "dihapus", bukan tautan mati atau baris yang lenyap diam-diam;
 *  - baris rekap tetap punya verdict dan ringkasan terakhirnya (snapshot saat dihapus);
 *  - ID tugas tidak pernah dipakai ulang, walau counter.json rusak.
 *
 * Sengaja hanya bergantung pada config.ts supaya store.ts, tasks.ts, dan findings.ts bisa
 * memakainya tanpa impor melingkar.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG } from "./config.ts";
import type { RecapEntry } from "./recap.ts";
import type { TaskStatus } from "./tasks.ts";
import type { RoleId } from "./types.ts";

export type DeletedTask = {
  id: string;
  title: string;
  role: RoleId;
  /** Project pemegang tugas saat dihapus. */
  projectId: string;
  /** Status terakhir sebelum dihapus. */
  status: TaskStatus;
  createdAt: string;
  deletedAt: string;
  costUsd: number;
  /** Baris rekap terakhir sebelum dihapus; kosong kalau tugas belum punya laporan maupun ringkasan. */
  recap?: RecapEntry;
};

/** Ringkasan untuk UI: cukup untuk memberi label "dihapus" pada sebuah rujukan. */
export type DeletedRef = { title: string; deletedAt: string };

const path = (): string => join(CONFIG.dataDir, "deleted-tasks.json");

let cache: Map<string, DeletedTask> | undefined;
/** Diisi kalau berkasnya ada tapi tidak terbaca. */
let broken: string | undefined;

/**
 * Berkas rusak tidak boleh menjatuhkan server (isDeleted dipanggil di setiap event transcript),
 * jadi bacaan memakai peta kosong. Tapi penulisan ditolak: menyimpan peta kosong itu berarti
 * menimpa semua tombstone.
 */
function load(): Map<string, DeletedTask> {
  if (cache) return cache;
  const map = new Map<string, DeletedTask>();
  if (existsSync(path())) {
    try {
      const list = JSON.parse(readFileSync(path(), "utf8")) as DeletedTask[];
      for (const entry of list) map.set(entry.id, entry);
    } catch (error) {
      broken = `${path()} rusak: ${(error as Error).message}`;
      console.error(broken);
    }
  }
  cache = map;
  return map;
}

function save(map: Map<string, DeletedTask>): void {
  const target = path();
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify([...map.values()], null, 2));
  renameSync(tmp, target);
}

export function recordDeleted(entry: DeletedTask): void {
  const map = load();
  if (broken) throw new Error(`${broken} — perbaiki berkasnya sebelum menghapus tugas lagi`);
  const next = new Map(map);
  next.set(entry.id, entry);
  save(next);
  cache = next;
}

export function isDeleted(id: string): boolean {
  return load().has(id);
}

export function getDeleted(id: string): DeletedTask | undefined {
  return load().get(id);
}

/** Tugas yang dihapus dari project ini, terbaru dulu. */
export function deletedInProject(projectId: string): DeletedTask[] {
  return [...load().values()]
    .filter((entry) => entry.projectId === projectId)
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/** Label "dihapus" untuk ID yang dirujuk; ID yang tidak dihapus dilewati. */
export function deletedRefs(ids: Iterable<string>): Record<string, DeletedRef> {
  const map = load();
  const result: Record<string, DeletedRef> = {};
  for (const id of ids) {
    const entry = map.get(id);
    if (entry) result[id] = { title: entry.title, deletedAt: entry.deletedAt };
  }
  return result;
}
