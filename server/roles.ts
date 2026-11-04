import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.ts";
import type { AutonomyMode, RoleId } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const persona = (name: string): string => readFileSync(join(here, "prompts", `${name}.md`), "utf8");

/** Bentuk `//abs/path`: rule izin yang menunjuk path absolut di disk, bukan relatif ke cwd. */
const abs = (path: string): string => `//${path.replace(/^\/+/, "")}`;

export type RoleDef = {
  id: RoleId;
  title: string;
  blurb: string;
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  allowedTools: string[];
  disallowedTools: string[];
  persona: string;
  usesBrowser: boolean;
  producesReport: boolean;
};

export const DENY_ALWAYS = [
  // Konektor claude.ai milik akun (Figma, Mobbin, dll.) ikut menempel ke sesi CLI.
  // Tim ini hanya boleh memakai tool buatan aplikasi ini, bukan konektor pribadi Anda.
  "mcp__claude_ai_*",
  "Bash(sudo:*)",
  "Bash(mkfs:*)",
  "Bash(dd:*)",
  "Bash(shutdown:*)",
  "Bash(reboot:*)",
  `Edit(${abs("etc/**")})`,
  `Edit(${abs(`${homedir()}/.claude/**`)})`,
  `Read(${abs(`${homedir()}/.claude/.credentials.json`)})`,
  // Catatan pribadi pemilik produk: ada di folder tugas yang boleh dibaca agen,
  // jadi larangannya harus eksplisit.
  `Read(${abs(`${CONFIG.tasksDir}/**/notes.md`)})`,
  `Write(${abs(`${CONFIG.tasksDir}/**/notes.md`)})`,
  `Edit(${abs(`${CONFIG.tasksDir}/**/notes.md`)})`,
];

export const ROLES: Record<RoleId, RoleDef> = {
  qa: {
    id: "qa",
    title: "QA Engineer",
    blurb: "Menguji lewat browser, mengumpulkan bukti, menulis laporan Markdown.",
    model: CONFIG.models.qa,
    effort: CONFIG.effort.qa,
    permissionMode: "acceptEdits",
    permissions: {
      allow: ["mcp__browser__*", "mcp__team__*", "Read", "Glob", "Grep", "TodoWrite"],
      // Catatan: rule `ask` dievaluasi SEBELUM rule `allow`, jadi menaruh "Bash" di sini
      // akan menelan seluruh allow-list. Perintah yang tidak ada di allow tetap minta
      // persetujuan lewat canUseTool karena tidak di-auto-approve oleh permissionMode.
      ask: [],
      deny: [
        // Larangan menyunting workspace ditambahkan per project oleh permissionsFor().
        "Bash(rm:*)",
        "Bash(git push:*)",
        "Bash(git commit:*)",
        ...DENY_ALWAYS,
      ],
    },
    allowedTools: [],
    disallowedTools: [],
    persona: persona("qa"),
    usesBrowser: true,
    producesReport: true,
  },
  engineer: {
    id: "engineer",
    title: "Software Engineer",
    blurb: "Mengerjakan perubahan kode di workspace, menjalankan test, melaporkan diff.",
    model: CONFIG.models.engineer,
    effort: CONFIG.effort.engineer,
    permissionMode: "acceptEdits",
    permissions: {
      allow: [
        "mcp__team__*",
        "Read",
        "Glob",
        "Grep",
        "TodoWrite",
        "Bash(npm test:*)",
        "Bash(npm run test:*)",
        "Bash(npm run typecheck:*)",
        "Bash(npm run lint:*)",
        "Bash(npm run build:*)",
        "Bash(npx tsc:*)",
        "Bash(npx vitest:*)",
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git log:*)",
        "Bash(ls:*)",
        "Bash(cat:*)",
        "Bash(head:*)",
        "Bash(tail:*)",
        "Bash(wc:*)",
      ],
      ask: [],
      deny: [
        "Bash(git push:*)",
        "Bash(git commit:*)",
        "Bash(git reset --hard:*)",
        "Bash(git checkout:*)",
        "Bash(rm -rf:*)",
        "Bash(docker:*)",
        "Bash(systemctl:*)",
        ...DENY_ALWAYS,
      ],
    },
    allowedTools: [],
    disallowedTools: [],
    persona: persona("engineer"),
    usesBrowser: false,
    producesReport: true,
  },
  devops: {
    id: "devops",
    title: "DevOps Engineer",
    blurb: "Inspeksi server, rencana + rollback, eksekusi setelah Anda setujui.",
    model: CONFIG.models.devops,
    effort: CONFIG.effort.devops,
    permissionMode: "default",
    permissions: {
      allow: [
        "mcp__team__*",
        "Read",
        "Glob",
        "Grep",
        "TodoWrite",
        "Bash(cat:*)",
        "Bash(head:*)",
        "Bash(tail:*)",
        "Bash(ls:*)",
        "Bash(find:*)",
        "Bash(grep:*)",
        "Bash(rg:*)",
        "Bash(wc:*)",
        "Bash(stat:*)",
        "Bash(du:*)",
        "Bash(uname:*)",
        "Bash(ip:*)",
        "Bash(lsof:*)",
        "Bash(netstat:*)",
        "Bash(curl -s:*)",
        "Bash(curl -I:*)",
        "Bash(docker inspect:*)",
        "Bash(docker compose config:*)",
        "Bash(systemctl show:*)",
        "Bash(systemctl list-units:*)",
        "Bash(systemctl is-active:*)",
        "Bash(systemctl cat:*)",
        "Bash(nginx -T:*)",
        "Bash(docker ps:*)",
        "Bash(docker logs:*)",
        "Bash(docker compose ps:*)",
        "Bash(docker compose logs:*)",
        "Bash(systemctl status:*)",
        "Bash(journalctl:*)",
        "Bash(df:*)",
        "Bash(free:*)",
        "Bash(uptime:*)",
        "Bash(ss:*)",
        "Bash(ps:*)",
        "Bash(nginx -t:*)",
        "Bash(git status:*)",
        "Bash(git log:*)",
        // Laporan tugas: tanpa ini setiap penulisan report.md memunculkan kartu persetujuan.
        // Sengaja hanya folder tugas — kode dan konfigurasi server tetap butuh persetujuan.
        `Write(${abs(`${CONFIG.tasksDir}/**`)})`,
        `Edit(${abs(`${CONFIG.tasksDir}/**`)})`,
      ],
      ask: [],
      deny: ["Bash(rm -rf /:*)", "Bash(chmod -R 777:*)", ...DENY_ALWAYS],
    },
    allowedTools: [],
    disallowedTools: [],
    persona: persona("devops"),
    usesBrowser: false,
    producesReport: true,
  },
};

/**
 * Aturan izin yang memuat path folder, dihitung per project.
 * Workspace tiap project berbeda, jadi rule ini tidak bisa dibekukan saat modul dimuat.
 */
export function permissionsFor(roleId: RoleId, workspaceDir: string): RoleDef["permissions"] {
  const base = ROLES[roleId].permissions;
  if (roleId !== "qa") return base;
  // QA tidak boleh mengubah kode aplikasi — perbaikan adalah tugas Engineer.
  return { ...base, deny: [`Edit(${abs(`${workspaceDir}/**`)})`, ...base.deny] };
}

/**
 * Mode otonomi tugas → permissionMode SDK.
 * "ask" sengaja memakai mode bawaan tiap role, supaya perilakunya persis seperti sebelum
 * fitur ini ada: QA & Engineer auto-approve edit berkas, DevOps menanyakan semuanya.
 */
export function resolvePermissionMode(role: RoleDef, mode: AutonomyMode): PermissionMode {
  if (mode === "auto") return "auto";
  if (mode === "readonly") return "plan";
  return role.permissionMode;
}

export const ROLE_IDS = Object.keys(ROLES) as RoleId[];

export function isRoleId(value: string): value is RoleId {
  return value in ROLES;
}
