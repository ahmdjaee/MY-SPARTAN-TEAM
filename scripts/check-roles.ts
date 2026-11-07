/** Uji kontrak role UI/UX. Deterministik, tanpa model: bun run check:roles */
import { readFileSync } from "node:fs";
import { findingHeads, reportRounds, verdictOf } from "../server/recap.ts";
import { ROLES, permissionsFor, resolvePermissionMode } from "../server/roles.ts";
import { findingStatusTools } from "../server/team/mcp.ts";
import type { RoleId } from "../server/types.ts";

let failed = 0;
function expect(name: string, actual: unknown, wanted: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "GAGAL"} ${name}${ok ? "" : ` — dapat ${JSON.stringify(actual)}, harusnya ${JSON.stringify(wanted)}`}`);
}

const WORKSPACE = "/srv/contoh";
const blocksWorkspace = (role: RoleId) => permissionsFor(role, WORKSPACE).deny.includes(`Edit(//srv/contoh/**)`);

expect("QA dilarang menyunting workspace", blocksWorkspace("qa"), true);
expect("UI/UX dilarang menyunting workspace", blocksWorkspace("uiux"), true);
expect("Engineer tetap boleh menyunting workspace", blocksWorkspace("engineer"), false);
expect("DevOps tetap boleh menyunting workspace", blocksWorkspace("devops"), false);

const uiux = ROLES.uiux;
expect("UI/UX memakai browser", uiux.usesBrowser, true);
expect("UI/UX menulis laporan", uiux.producesReport, true);
expect("UI/UX boleh memakai tool browser", uiux.permissions.allow.includes("mcp__browser__*"), true);
expect("UI/UX tidak boleh commit", uiux.permissions.deny.includes("Bash(git commit:*)"), true);
expect("konektor pribadi tetap diblokir", uiux.permissions.deny.includes("mcp__claude_ai_*"), true);
expect("mode ask memakai acceptEdits untuk report.md", resolvePermissionMode(uiux, "ask"), "acceptEdits");
expect("mode readonly memakai plan", resolvePermissionMode(uiux, "readonly"), "plan");

const toolNames = (role: RoleId) => findingStatusTools("T-TIDAK-ADA", role).map((item) => item.name);
expect("UI/UX tidak bisa mengubah status temuan", toolNames("uiux"), []);
expect("QA tetap punya finding_retest", toolNames("qa"), ["finding_retest"]);
expect("Engineer tetap punya finding_report_fixed", toolNames("engineer"), ["finding_report_fixed"]);

expect("persona termuat", uiux.persona.startsWith("# Peran Anda: Senior UI/UX Designer"), true);

// Daftar role di web tidak ditangkap typecheck, jadi diperiksa dari sumbernya.
const webSource = (path: string) => readFileSync(new URL(`../web/${path}`, import.meta.url), "utf8");
expect("ROLE_IDS web memuat uiux", /ROLE_IDS: RoleId\[\] = \[[^\]]*"uiux"/.test(webSource("routes.tsx")), true);
expect("filter daftar tugas memuat uiux", webSource("components/TaskList.tsx").includes('value="uiux"'), true);
expect("label thread memuat uiux", /uiux: "UI\/UX"/.test(webSource("components/TaskThread.tsx")), true);

// Laporan mengikuti template persona, jadi mesin rekap harus membacanya tanpa perubahan.
const REPORT = `# Laporan UI/UX — Audit checkout

- **Tanggal:** 2026-11-07 10:00
- **Target:** /checkout
- **Lingkungan:** 390×844, 1440×900
- **Hasil:** LULUS DENGAN CATATAN

## Ringkasan
Alur selesai, tetapi tombol utama tidak terbaca di ponsel.

## Layar yang diaudit
| Layar / state | Viewport | Hasil | Bukti |
|---------------|----------|-------|-------|
| Checkout | 390×844 | ada temuan | \`./assets/checkout-390.png\` |

## Temuan
### T-1 · Kontras tombol bayar rendah · major · ref F-012
- **Lokasi:** checkout, 390×844
- **Masalah:** teks sulit dibaca
- **Dasar:** WCAG 1.4.3
- **Bukti:** kontras 3,2:1 dari inspect

### T-2 · Label kupon tidak konsisten · minor
- **Lokasi:** checkout

## Spesifikasi untuk Engineer
### S-1 · Ganti warna tombol · menangani T-1
- **File:** \`web/Pay.tsx:12\`

## Tidak teraudit / terblokir
tidak ada

## Rekomendasi
Perbaiki T-1 lebih dulu.
`;

expect("verdict terbaca", verdictOf(REPORT), { text: "LULUS DENGAN CATATAN", tone: "warn" });
const heads = findingHeads(REPORT);
expect(
  "temuan terbaca, spesifikasi tidak ikut",
  heads.map((head) => [head.id, head.severity, head.ref]),
  [
    ["T-1", "major", "F-012"],
    ["T-2", "minor", undefined],
  ],
);

const appended = `${REPORT}\n## Audit UI/UX — UI/UX Designer · 2026-11-08\n\n- **Hasil:** LULUS\n\n### Temuan\ntidak ada\n`;
const rounds = reportRounds(appended);
expect("bagian tambahan jadi putaran baru", rounds.length, 2);
expect("verdict memakai bagian terakhir", verdictOf(appended)?.text, "LULUS");

console.log(failed === 0 ? "\nSemua kasus sesuai harapan" : `\n${failed} kasus GAGAL`);
if (failed > 0) process.exitCode = 1;
