import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import type { AutonomyMode, RoleId } from "./types.ts";

export type NotificationSettings = {
  approval: boolean;
  question: boolean;
  needsReview: boolean;
  failed: boolean;
  /** true = notifikasi hanya muncul saat tab aplikasi tidak aktif. */
  onlyWhenHidden: boolean;
};

export type Settings = {
  modes: Record<RoleId, AutonomyMode>;
  notifications: NotificationSettings;
};

const PATH = join(CONFIG.dataDir, "settings.json");
const MODES: AutonomyMode[] = ["auto", "ask", "readonly"];

/** `.env` hanya dipakai sebagai nilai awal; setelah itu Pengaturan di aplikasi yang berlaku. */
function envMode(name: string): AutonomyMode {
  const value = process.env[name];
  return MODES.includes(value as AutonomyMode) ? (value as AutonomyMode) : "ask";
}

function defaults(): Settings {
  return {
    modes: {
      qa: envMode("AUTONOMY_QA"),
      engineer: envMode("AUTONOMY_ENGINEER"),
      devops: envMode("AUTONOMY_DEVOPS"),
    },
    notifications: { approval: true, question: true, needsReview: true, failed: true, onlyWhenHidden: true },
  };
}

let cache: Settings | undefined;

export function getSettings(): Settings {
  if (cache) return cache;
  const base = defaults();
  if (existsSync(PATH)) {
    try {
      const stored = JSON.parse(readFileSync(PATH, "utf8")) as Partial<Settings>;
      cache = {
        modes: { ...base.modes, ...(stored.modes ?? {}) },
        notifications: { ...base.notifications, ...(stored.notifications ?? {}) },
      };
      return cache;
    } catch {
      // berkas rusak: pakai bawaan
    }
  }
  cache = base;
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const next: Settings = {
    modes: { ...current.modes, ...(patch.modes ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
  };
  for (const [role, mode] of Object.entries(next.modes)) {
    if (!MODES.includes(mode)) next.modes[role as RoleId] = "ask";
  }
  const tmp = `${PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, PATH);
  cache = next;
  return next;
}

export function defaultModeFor(role: RoleId): AutonomyMode {
  return getSettings().modes[role];
}
