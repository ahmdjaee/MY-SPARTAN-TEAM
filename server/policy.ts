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

export type PolicyContext = {
  workspaceDir: string;
  taskDir?: string;
  /** `false` menolak `git commit` karena pemilik belum memintanya; `undefined` melewati gerbang ini. */
  commitRequested?: boolean;
};

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

/** Harus di posisi perintah: menyebut "git commit" di dalam teks laporan tidak dihitung. */
const GIT_COMMIT =
  /(?:^|[;&|(\n]\s*|\bssh\s+\S+\s+['"])\s*(?:\w+=\S+\s+)*git(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+commit\b/;

const AI_ATTRIBUTION = /co-authored-by[:=][^\n]*(?:claude|anthropic)|noreply@anthropic\.com|generated (?:with|by) \[?claude/i;

const CONVENTIONAL_COMMIT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: \S/;

const MESSAGE_FLAG = String.raw`(?:^|\s)(?:-\w*m\s*|--message[=\s]\s*)`;
const HEREDOC_MESSAGE = new RegExp(`${MESSAGE_FLAG}"?\\$\\(cat\\s+<<-?\\s*['"]?\\w+['"]?\\s*\\n\\s*([^\\n]*)`);
const HEREDOC_STDIN = /(?:^|\s)(?:-\w*F\s*-|--file[=\s]\s*-)(?=\s)[^\n]*<<-?\s*['"]?\w+['"]?\s*\n\s*([^\n]*)/;
const PLAIN_MESSAGE = new RegExp(`${MESSAGE_FLAG}(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|(\\S+))`);

/** Baris pertama pesan commit; `undefined` kalau perintahnya tidak membawa pesan baru (mis. `--amend --no-edit`). */
function commitSubject(args: string): string | undefined {
  const heredoc = HEREDOC_MESSAGE.exec(args) ?? HEREDOC_STDIN.exec(args);
  if (heredoc) return heredoc[1];
  const plain = PLAIN_MESSAGE.exec(args);
  if (!plain) return undefined;
  return (plain[1] ?? plain[2] ?? plain[3] ?? "").split("\n")[0];
}

/** Argumen commit tanpa isi heredoc, isi kutipan, dan perintah sesudahnya, supaya teks pesan tidak terbaca sebagai flag. */
function commitFlags(args: string): string {
  return args
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "")
    .split(/[;&|\n]/)[0] ?? "";
}

const MESSAGE_FROM_FILE = /(?:^|\s)(?:-\w*F\s*(?!-(?:\s|$))\S|--file[=\s]\s*(?!-(?:\s|$))\S|-\w*t\s*\S|--template\b)/;

/** Aturan khusus `git commit`; `undefined` kalau perintahnya bukan commit atau commit-nya lolos. */
function checkCommit(command: string, ctx: PolicyContext): PolicyDecision | undefined {
  const match = GIT_COMMIT.exec(command);
  if (!match) return undefined;
  const deny = (reason: string): PolicyDecision => ({ decision: "deny", reason });

  if (ctx.commitRequested === false) {
    return deny("pemilik produk belum meminta commit. Tinggalkan perubahan di working tree, atau tanyakan dulu");
  }
  if (AI_ATTRIBUTION.test(command)) return deny("pesan commit tidak boleh memuat label atribusi AI");

  const args = command.slice(match.index + match[0].length);
  if (MESSAGE_FROM_FILE.test(commitFlags(args))) {
    return deny("pesan commit dari berkas tidak bisa diperiksa. Pakai -m");
  }
  const subject = commitSubject(args);
  if (subject !== undefined && !CONVENTIONAL_COMMIT.test(subject)) {
    return deny(
      "pesan commit harus berformat Conventional Commits: <type>(<scope opsional>): <description>, dengan type feat, fix, docs, style, refactor, perf, test, build, ci, chore, atau revert",
    );
  }
  return undefined;
}

const MENTIONS_COMMIT = /\b(?:di-?)?commit/i;
const NEGATED_COMMIT = /\b(?:jangan|tidak|tak|belum|tanpa|gak|nggak|ngga|ga|no|not|don'?t)\s+(?:usah\s+|perlu\s+)?(?:di-?)?commit/i;

/**
 * Apakah pemilik meminta commit, dari pesan-pesannya (urut lama ke baru).
 * Pesan terbaru yang menyebut commit yang menentukan. Ini pencocokan kata, bukan pemahaman
 * kalimat: persona Engineer tetap menjadi penjaga untuk kalimat seperti "cek commit terakhir".
 */
export function commitRequestedIn(messages: string[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const decision = commitDecision(messages[index] ?? "");
    if (decision !== undefined) return decision;
  }
  return false;
}

/** Keputusan satu pesan: true = minta commit, false = melarang, undefined = tidak menyebut commit. */
export function commitDecision(message: string): boolean | undefined {
  if (!MENTIONS_COMMIT.test(message)) return undefined;
  return !NEGATED_COMMIT.test(message);
}

export function classifyCommand(command: string, ctx: PolicyContext): PolicyDecision {
  const text = command.replace(/\s+/g, " ");

  for (const rule of DENY) {
    if (rule.test.test(text)) return { decision: "deny", reason: rule.reason };
  }
  const commitVerdict = checkCommit(command, ctx);
  if (commitVerdict) return commitVerdict;
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
