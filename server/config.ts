import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

try {
  process.loadEnvFile(join(process.cwd(), ".env"));
} catch {
  // .env opsional
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

function effort(name: string, fallback: Effort): Effort {
  const value = process.env[name];
  return EFFORTS.includes(value as Effort) ? (value as Effort) : fallback;
}

const dataDir = resolve(str("DATA_DIR", "./data"));
const workspaceDir = resolve(str("WORKSPACE_DIR", join(process.cwd(), "workspace")));

export const CONFIG = {
  host: str("HOST", "127.0.0.1"),
  port: num("PORT", 4320),
  workspaceDir,
  dataDir,
  tasksDir: join(dataDir, "tasks"),
  counterPath: join(dataDir, "counter.json"),
  memoryPath: join(dataDir, "memory.md"),
  /** Folder laporan v1 — hanya dipakai skrip migrasi. */
  legacyReportsDir: join(dataDir, "reports"),
  models: {
    qa: str("MODEL_QA", "claude-sonnet-5-5"),
    engineer: str("MODEL_ENGINEER", "claude-opus-5"),
    devops: str("MODEL_DEVOPS", "claude-opus-5"),
    uiux: str("MODEL_UIUX", "claude-opus-5-5"),
    curator: str("MODEL_CURATOR", "claude-sonnet-5-5"),
  },
  effort: {
    qa: effort("EFFORT_QA", "high"),
    engineer: effort("EFFORT_ENGINEER", "high"),
    devops: effort("EFFORT_DEVOPS", "medium"),
    uiux: effort("EFFORT_UIUX", "high"),
    curator: effort("EFFORT_CURATOR", "medium"),
  },
  /** Kurator register temuan: jalan otomatis setelah tugas selesai. CURATOR=0 mematikannya (Sync manual tetap bisa). */
  curatorAuto: str("CURATOR", "1") !== "0",
  /** Jeda setelah tugas selesai sebelum kurator jalan; tugas yang selesai berdekatan digabung satu kurasi. */
  curatorDebounceMs: num("CURATOR_DEBOUNCE_MS", 60_000),
  maxConcurrentAgents: num("MAX_CONCURRENT_AGENTS", 2),
  /** Tutup subprocess Claude Code setelah sekian lama tugas menganggur; sesi tetap bisa dilanjutkan. */
  idleShutdownMs: num("IDLE_SHUTDOWN_MS", 10 * 60_000),
  /** Batas tunggu result turn yang dihentikan dengan Stop; lewat dari ini proses Claude ditutup paksa. */
  stopGraceMs: num("STOP_GRACE_MS", 20_000),
  /** Batas waktu satu jawaban panel Tanya. */
  askTimeoutMs: num("ASK_TIMEOUT_MS", 5 * 60_000),
  includeUserSettings: str("INCLUDE_USER_SETTINGS", "0") === "1",
  /** Nama host tambahan yang boleh membuka UI/API (dipisah koma); bawaan: 127.0.0.1, localhost, ::1, ai-team.local. */
  allowedHosts: str("ALLOWED_HOSTS", ""),
  /** Origin tambahan yang boleh memanggil API dan WebSocket (dipisah koma), mis. https://ai-team.example. */
  allowedOrigins: str("ALLOWED_ORIGINS", ""),
  targetUrl: str("TARGET_URL", ""),
} as const;

/**
 * Environment untuk subprocess Claude Code.
 * ANTHROPIC_API_KEY sengaja dihapus supaya SDK memakai sesi login OAuth
 * yang sudah ada di ~/.claude, bukan jalur API key.
 */
export function agentEnv(): Record<string, string | undefined> {
  return { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined };
}

export function ensureDirs(): void {
  for (const dir of [CONFIG.dataDir, CONFIG.tasksDir, CONFIG.workspaceDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
