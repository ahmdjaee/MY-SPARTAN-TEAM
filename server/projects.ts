import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG } from "./config.ts";
import { MEMORY_TEMPLATE, fitMemory, trimMemory } from "./memory.ts";

/**
 * Project = induk tugas. Ia memegang konteks yang dipakai bersama semua tugas di
 * dalamnya: catatan yang Anda tulis sendiri (`context.md`), memori yang ditulis bot
 * dan dirapikan kurator dari catatan `remember` (`memory.md`), URL target bawaan, dan folder workspace-nya.
 */
export type Project = {
  id: string;
  name: string;
  targetUrl?: string;
  /** Kosong = pakai CONFIG.workspaceDir. */
  workspaceDir?: string;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
};

const CONTEXT_TEMPLATE = `# Konteks project

Catatan yang Anda tulis sendiri; semua bot di project ini membacanya di setiap tugas.

## Lingkungan
- (URL staging/lokal, port, cara menjalankan)

## Kredensial uji
- (akun uji yang boleh dipakai)

## Keputusan & pantangan
- (hal yang tidak boleh disentuh, keputusan arsitektur)
`;

const index = new Map<string, Project>();

export function projectsDir(): string {
  return join(CONFIG.dataDir, "projects");
}

export function projectDir(id: string): string {
  return join(projectsDir(), id);
}

function metaPath(id: string): string {
  return join(projectDir(id), "project.json");
}

function contextPath(id: string): string {
  return join(projectDir(id), "context.md");
}

function memoryPath(id: string): string {
  return join(projectDir(id), "memory.md");
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function persist(project: Project): Project {
  mkdirSync(projectDir(project.id), { recursive: true });
  writeAtomic(metaPath(project.id), JSON.stringify(project, null, 2));
  index.set(project.id, project);
  return project;
}

export function loadProjects(): void {
  index.clear();
  const root = projectsDir();
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "project.json");
    if (!existsSync(path)) continue;
    try {
      const project = JSON.parse(readFileSync(path, "utf8")) as Project;
      index.set(project.id, project);
    } catch {
      // project rusak dilewati
    }
  }
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "project";
}

function freeId(name: string): string {
  const base = slugify(name);
  if (!index.has(base)) return base;
  let n = 2;
  while (index.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Urutan tampil: yang aktif dulu (abjad), lalu yang diarsipkan. */
export function listProjects(): Project[] {
  return [...index.values()].sort(
    (a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)) || a.name.localeCompare(b.name),
  );
}

export function getProject(id: string | undefined): Project | undefined {
  return id ? index.get(id) : undefined;
}

export function createProject(input: {
  id?: string;
  name: string;
  targetUrl?: string;
  workspaceDir?: string;
  context?: string;
  memory?: string;
  createdAt?: string;
}): Project {
  const name = input.name.trim().slice(0, 80) || "Project baru";
  const now = new Date().toISOString();
  const project: Project = {
    id: input.id && !index.has(input.id) ? input.id : freeId(name),
    name,
    targetUrl: input.targetUrl?.trim() || undefined,
    workspaceDir: input.workspaceDir?.trim() || undefined,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
  persist(project);
  if (!existsSync(contextPath(project.id))) writeAtomic(contextPath(project.id), input.context ?? CONTEXT_TEMPLATE);
  if (!existsSync(memoryPath(project.id))) writeAtomic(memoryPath(project.id), input.memory ?? MEMORY_TEMPLATE);
  return project;
}

export function updateProject(id: string, patch: Partial<Project>): Project | undefined {
  const current = index.get(id);
  if (!current) return undefined;
  return persist({ ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() });
}

/** Folder project ikut dihapus; kalau hanya indeks yang dibersihkan, ia kembali saat server dimuat ulang. */
export function deleteProject(id: string): boolean {
  if (!index.has(id)) return false;
  rmSync(projectDir(id), { recursive: true, force: true });
  return index.delete(id);
}

// ---------- konteks & memori ----------

export function readContext(id: string): string {
  const path = contextPath(id);
  return existsSync(path) ? readFileSync(path, "utf8") : CONTEXT_TEMPLATE;
}

export function writeContext(id: string, text: string): string {
  const trimmed = trimMemory(text);
  writeAtomic(contextPath(id), trimmed);
  return trimmed;
}

export function readProjectMemory(id: string): string {
  const path = memoryPath(id);
  return existsSync(path) ? readFileSync(path, "utf8") : MEMORY_TEMPLATE;
}

export function writeProjectMemory(id: string, text: string): string {
  const trimmed = fitMemory(text);
  writeAtomic(memoryPath(id), trimmed);
  return trimmed;
}

// ---------- workspace ----------

export function workspaceForProject(id: string | undefined): string {
  return getProject(id)?.workspaceDir || CONFIG.workspaceDir;
}

/** Folder sistem yang tidak boleh dijadikan workspace bot, apa pun alasannya. */
const FORBIDDEN = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/proc", "/sys", "/dev", "/root", "/var/lib"];

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`);

/**
 * Workspace project menentukan folder yang boleh ditulis Engineer/DevOps, jadi ia
 * diperiksa di satu tempat: harus folder yang benar-benar ada, bukan folder sistem,
 * dan tidak boleh menyentuh data aplikasi ini maupun sesi login Claude.
 */
export function validateWorkspaceDir(raw: unknown): { dir?: string; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return {};
  if (typeof raw !== "string") return { error: "folder workspace harus berupa teks" };
  const value = raw.trim();
  if (!value.startsWith("/")) return { error: "pakai path absolut, mis. /var/www/proyek-anda" };

  const dir = resolve(value);
  if (dir === "/") return { error: "root (/) tidak boleh dijadikan workspace" };
  for (const root of FORBIDDEN) {
    if (within(dir, root)) return { error: `${root} adalah folder sistem — tidak boleh dijadikan workspace` };
  }
  const claude = join(homedir(), ".claude");
  if (within(dir, claude) || within(claude, dir)) {
    return { error: "folder itu memuat sesi login Claude — pilih folder lain" };
  }
  if (within(dir, CONFIG.dataDir) || within(CONFIG.dataDir, dir)) {
    return { error: "folder itu memuat data aplikasi ini (tugas, laporan) — pilih folder lain" };
  }
  if (!existsSync(dir)) return { error: `folder ${dir} tidak ada` };
  try {
    if (!statSync(dir).isDirectory()) return { error: `${dir} bukan folder` };
  } catch {
    return { error: `folder ${dir} tidak bisa dibaca` };
  }
  return { dir };
}

// ---------- bawaan ----------

export function defaultProjectId(): string {
  const active = listProjects().find((project) => !project.archived) ?? listProjects()[0];
  return active ? active.id : ensureDefaultProject().id;
}

/** Dipakai saat data masih kosong: selalu ada satu project supaya tugas tidak pernah yatim. */
export function ensureDefaultProject(): Project {
  const existing = listProjects()[0];
  if (existing) return existing;
  return createProject({ id: "umum", name: "Umum", targetUrl: CONFIG.targetUrl || undefined });
}
