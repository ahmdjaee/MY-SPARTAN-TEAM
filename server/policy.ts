/**
 * Pagar keras untuk perintah shell.
 *
 * Aturan allow/deny Claude Code cocok di AWAL string, jadi `ssh host 'sudo rm -rf /var'`
 * lolos dari `Bash(sudo:*)`. Kebijakan di sini membaca string perintah secara utuh —
 * termasuk isi kutipan `ssh`, heredoc, dan rantai `&&` — lalu memutuskan sendiri.
 *
 * Semua pola ada di tabel di bawah supaya mudah disunting tanpa menyentuh logika.
 */

export type PolicyCategory = "service" | "data" | "access" | "files" | "unreadable";

export type PolicyDecision = {
  decision: "deny" | "ask" | "pass";
  reason: string;
  category?: PolicyCategory;
};

export type PolicyContext = { workspaceDir: string; taskDir?: string };

type Rule = { test: RegExp; reason: string; category?: PolicyCategory };

/** Tidak pernah dijalankan, mode apa pun. */
const DENY: Rule[] = [
  { test: /\brm\s+(?:-[\w-]+\s+)*\/\s*(?:$|[;&|])/, reason: "menghapus seluruh isi root (/)" },
  {
    test: /\brm\s+(?:-[\w-]+\s+)*\/(etc|bin|sbin|boot|lib|lib64|usr|root|home|var\/lib)(\/|\s|$)/,
    reason: "menghapus direktori sistem",
  },
  { test: /\bmkfs(\.\w+)?\b/, reason: "memformat filesystem" },
  { test: /\bdd\b[^|;]*\bof=\/dev\//, reason: "menulis langsung ke perangkat blok" },
  {
    // Harus di posisi perintah: menyebut kata "shutdown" di dalam teks laporan tidak diblokir.
    test: /(^|[;&|]\s*|\bsudo\s+|\bssh\s+\S+\s+['"])\s*(shutdown|reboot|halt|poweroff)\b/,
    reason: "mematikan atau menghidupkan ulang mesin",
  },
  { test: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&\s*\}\s*;/, reason: "fork bomb" },
  { test: /\bchmod\s+(?:-[\w-]+\s+)*777\s+\/(\s|$)/, reason: "membuka izin seluruh root" },
  { test: /\bDROP\s+DATABASE\b/i, reason: "menghapus database" },
  { test: />\s*\/dev\/(sd|nvme|hd|vd)\w/, reason: "menimpa perangkat disk" },
];

/** Tetap memunculkan kartu persetujuan, walau mode auto. */
const ASK: Rule[] = [
  // 0. Isi perintah tidak bisa dinilai dari luar — diperiksa lebih dulu supaya
  //    alasan yang muncul di kartu menyebut akar persoalannya.
  { test: /\bssh\b[^|;]*\bsudo\b/, reason: "menjalankan sudo di server lain", category: "unreadable" },
  { test: /\|\s*(sudo\s+)?(ba|z|k)?sh\b/, reason: "mengalirkan unduhan langsung ke shell", category: "unreadable" },
  { test: /\bbase64\s+(-d|--decode)\b[^|]*\|/, reason: "menjalankan perintah yang disandikan", category: "unreadable" },

  // 1. Service & container
  {
    test: /\bsystemctl\s+(?:--\S+\s+)*(restart|stop|disable|mask|kill|daemon-reload)\b/,
    reason: "mengubah status service systemd",
    category: "service",
  },
  { test: /\bservice\s+\S+\s+(stop|restart|reload)\b/, reason: "mengubah status service", category: "service" },
  { test: /\bdocker\s+(stop|kill|rm|restart|pause)\b/, reason: "mengubah status container", category: "service" },
  {
    test: /\bdocker[\s-]+compose\b[^;&|]*\b(up|down|restart|stop|rm)\b/,
    reason: "mengubah stack docker compose",
    category: "service",
  },
  { test: /\bpm2\s+(restart|stop|delete|reload)\b/, reason: "mengubah proses pm2", category: "service" },
  { test: /\bnginx\s+-s\b|\bapachectl\s+(stop|restart|graceful)\b/, reason: "me-reload web server", category: "service" },
  { test: /\b(pkill|killall)\b|\bkill\s+-9\b/, reason: "mematikan proses secara paksa", category: "service" },

  // 2. Data & database
  {
    test: /\b(psql|mysql|mariadb|mongosh?|sqlite3)\b[^|]*\b(drop|delete|truncate|alter)\b/i,
    reason: "perintah SQL yang mengubah atau menghapus data",
    category: "data",
  },
  { test: /\b(migrate|migration)s?\b/i, reason: "menjalankan migrasi skema", category: "data" },
  { test: /\bprisma\s+(migrate|db\s+push)\b/i, reason: "migrasi skema Prisma", category: "data" },
  { test: /\brails\s+db:/i, reason: "perintah database Rails", category: "data" },
  { test: /\bpg_restore\b|\bmysql\b[^|]*<\s*\S+\.sql/, reason: "memulihkan dump database", category: "data" },
  { test: /\bredis-cli\b[^|]*\bflush\w*/i, reason: "mengosongkan Redis", category: "data" },
  { test: /\bdocker\s+volume\s+rm\b/, reason: "menghapus volume docker", category: "data" },

  // 3. Kredensial, firewall & akses
  { test: /\b(ufw|iptables|ip6tables|nft|firewall-cmd)\b/, reason: "mengubah firewall", category: "access" },
  { test: /\bssh-(keygen|copy-id)\b/, reason: "membuat atau menyalin kunci SSH", category: "access" },
  { test: /authorized_keys/, reason: "mengubah kunci yang diizinkan masuk", category: "access" },
  {
    test: /\b(usermod|useradd|userdel|adduser|chpasswd|passwd|visudo)\b/,
    reason: "mengubah user atau izin sistem",
    category: "access",
  },
  { test: /\bcertbot\b|\bopenssl\s+(genrsa|req)\b/, reason: "mengurus sertifikat atau kunci", category: "access" },
  { test: /(^|[\s;&|])(>|>>|tee)\s*\S*\.env\b/, reason: "menulis ke berkas .env", category: "access" },

  // 4. Hapus berkas & instalasi paket
  {
    test: /\b(apt|apt-get|yum|dnf|apk|pacman|brew)\s+(?:-\S+\s+)*(install|remove|purge|upgrade|autoremove)\b/,
    reason: "mengubah paket sistem",
    category: "files",
  },
  { test: /\bnpm\s+(i|install)\s+(-g|--global)\b/, reason: "memasang paket npm global", category: "files" },
  { test: /\bpip3?\s+install\b/, reason: "memasang paket Python", category: "files" },
  { test: /\bchown\b/, reason: "mengubah kepemilikan berkas", category: "files" },

];

/** `rm` di dalam workspace atau folder tugas itu wajar; di luar itu perlu persetujuan. */
function removesOutsideWorkArea(command: string, ctx: PolicyContext): boolean {
  const safePrefixes = [ctx.workspaceDir, ctx.taskDir, "/tmp/"].filter(Boolean) as string[];
  for (const match of command.matchAll(/\brm\s+((?:-[\w-]+\s+)*)([^;&|\n]+)/g)) {
    const targets = (match[2] ?? "").split(/\s+/).filter((part) => part && !part.startsWith("-"));
    for (const target of targets) {
      const clean = target.replace(/^['"]|['"]$/g, "");
      // Path relatif dijalankan dari cwd (workspace), jadi dianggap aman.
      if (!clean.startsWith("/")) continue;
      if (safePrefixes.some((prefix) => clean.startsWith(prefix))) continue;
      return true;
    }
  }
  return false;
}

export function classifyCommand(command: string, ctx: PolicyContext): PolicyDecision {
  const text = command.replace(/\s+/g, " ");

  for (const rule of DENY) {
    if (rule.test.test(text)) return { decision: "deny", reason: rule.reason };
  }
  for (const rule of ASK) {
    if (rule.test.test(text)) return { decision: "ask", reason: rule.reason, category: rule.category };
  }
  if (removesOutsideWorkArea(text, ctx)) {
    return { decision: "ask", reason: "menghapus berkas di luar workspace dan folder tugas", category: "files" };
  }
  return { decision: "pass", reason: "" };
}

export const CATEGORY_LABEL: Record<PolicyCategory, string> = {
  service: "service & container",
  data: "data & database",
  access: "kredensial, firewall & akses",
  files: "hapus berkas & paket",
  unreadable: "isi perintah tidak bisa dinilai",
};
