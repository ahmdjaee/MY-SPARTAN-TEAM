/**
 * Migrasi satu kali: memberi induk (project) kepada tugas yang sudah ada, dan
 * memecah `data/memory.md` yang selama ini mencampur beberapa proyek.
 *
 * Aman dijalankan berulang: kalau `data/projects/` sudah ada, ia tidak mengubah apa pun.
 * Berkas lama tidak pernah dihapus — `data/memory.md` disalin ke `data/memory.md.bak`.
 *
 * Pembagiannya ikut berkas `data/migrate-projects.json` kalau ada — isinya khusus
 * mesin Anda, jadi ia tinggal di `data/` yang tidak ikut git. Contoh isinya:
 *
 *   [
 *     { "id": "toko-online", "name": "Toko Online", "tasks": ["T-003", "T-007"],
 *       "targetUrl": "http://localhost:3000", "workspaceDir": "/var/www/toko-online" }
 *   ]
 *
 * Tanpa berkas itu, semua tugas lama masuk ke satu project "Umum" dan memori lama
 * dibiarkan utuh sebagai memori global — tidak ada yang ditebak.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, ensureDirs } from "../server/config.ts";
import { MEMORY_TEMPLATE, writeMemory } from "../server/memory.ts";
import { createProject, listProjects, loadProjects, projectsDir, writeProjectMemory } from "../server/projects.ts";
import { getTask, listTasks, loadTasks, updateTask } from "../server/tasks.ts";

const listTaskIds = (): string[] => listTasks().map((task) => task.id);

type Seed = {
  id: string;
  name: string;
  tasks: string[];
  targetUrl?: string;
  workspaceDir?: string;
};

/** Tanpa berkas pembagian, semua tugas lama cukup diberi satu induk. */
const FALLBACK: Seed[] = [{ id: "umum", name: "Umum", tasks: [], workspaceDir: CONFIG.workspaceDir }];

function loadSeeds(): { seeds: Seed[]; custom: boolean } {
  const path = join(CONFIG.dataDir, "migrate-projects.json");
  if (!existsSync(path)) return { seeds: FALLBACK, custom: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Seed[];
    if (Array.isArray(parsed) && parsed.every((seed) => seed?.id && seed?.name)) {
      return { seeds: parsed, custom: true };
    }
  } catch {
    // berkas rusak: jangan menebak, pakai pembagian bawaan
  }
  return { seeds: FALLBACK, custom: false };
}

/** Baris tanpa penanda tugas yang jelas-jelas milik aplikasi demo. */
const DEMO_HINTS = [/127\.0\.0\.1:4320/, /owner@contoh\.com/];

const SECTIONS = ["## Lingkungan", "## Kredensial uji", "## Keputusan & pantangan", "## Catatan tim"] as const;
type Section = (typeof SECTIONS)[number];

type Bucket = Map<Section, string[]>;

const emptyBucket = (): Bucket => new Map(SECTIONS.map((section) => [section, []]));

function compose(title: string, bucket: Bucket): string {
  const lines = [`# ${title}`, ""];
  for (const section of SECTIONS) {
    const items = bucket.get(section) ?? [];
    if (items.length === 0) continue;
    lines.push(section, ...items, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function migrateProjects(): string[] {
  const log: string[] = [];
  if (existsSync(projectsDir())) return log;

  loadProjects();
  loadTasks();

  const { seeds: SEEDS, custom } = loadSeeds();
  const ownerOf = new Map<string, string>();
  for (const seed of SEEDS) for (const taskId of seed.tasks) ownerOf.set(taskId, seed.id);

  // ---------- pecah memori ----------
  const buckets = new Map<string, Bucket>(SEEDS.map((seed) => [seed.id, emptyBucket()]));
  const global = emptyBucket();
  const raw = existsSync(CONFIG.memoryPath) ? readFileSync(CONFIG.memoryPath, "utf8") : "";
  let section: Section = "## Catatan tim";
  let moved = 0;
  let kept = 0;

  for (const line of raw.split("\n")) {
    const heading = SECTIONS.find((name) => line.trim().toLowerCase() === name.toLowerCase());
    if (heading) {
      section = heading;
      continue;
    }
    if (!line.trim().startsWith("- ")) continue;
    if (line.includes("(URL staging") || line.includes("(akun uji") || line.includes("(keputusan arsitektur")) continue;

    const marker = custom ? line.match(/\((T-\d+)\)/) : null;
    const target = marker
      ? ownerOf.get(marker[1] as string)
      : custom
        ? SEEDS.find((seed) => DEMO_HINTS.some((re) => re.test(line)) && seed.tasks.length > 1)?.id
        : undefined;

    if (target) {
      buckets.get(target)?.get(marker ? "## Catatan tim" : section)?.push(line);
      moved += 1;
    } else {
      global.get(section)?.push(line);
      kept += 1;
    }
  }

  // ---------- buat project ----------
  for (const seed of SEEDS) {
    const project = createProject({
      id: seed.id,
      name: seed.name,
      targetUrl: seed.targetUrl,
      workspaceDir: seed.workspaceDir && existsSync(seed.workspaceDir) ? seed.workspaceDir : undefined,
    });
    const bucket = buckets.get(seed.id) ?? emptyBucket();
    const bullets = [...bucket.values()].flat().length;
    writeProjectMemory(project.id, bullets > 0 ? compose(`Memori project — ${seed.name}`, bucket) : MEMORY_TEMPLATE);

    let assigned = 0;
    const members = custom ? seed.tasks : listTaskIds();
    for (const taskId of members) {
      if (!getTask(taskId)) continue;
      updateTask(taskId, { projectId: seed.id });
      assigned += 1;
    }
    log.push(`  project ${project.id.padEnd(13)} ${assigned} tugas · ${bullets} baris memori`);
  }

  // ---------- memori global ----------
  if (raw) {
    if (!existsSync(`${CONFIG.memoryPath}.bak`)) copyFileSync(CONFIG.memoryPath, `${CONFIG.memoryPath}.bak`);
    writeMemory(
      `${compose("Memori global", global)}\nCatatan yang khusus satu project ada di halaman Project masing-masing.\n`,
    );
  }
  log.push(`  memori: ${moved} baris pindah ke project, ${kept} baris tetap global (salinan: data/memory.md.bak)`);
  log.push(`  total project: ${listProjects().length}`);
  return log;
}

// Dijalankan langsung: tsx scripts/migrate-projects.ts
if (process.argv[1]?.endsWith("migrate-projects.ts")) {
  ensureDirs();
  const log = migrateProjects();
  console.log(log.length > 0 ? `Migrasi project:\n${log.join("\n")}` : "Sudah ada data/projects — tidak ada yang diubah.");
}
