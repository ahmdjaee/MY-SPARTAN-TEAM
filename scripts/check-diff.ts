/** Uji pemecah diff per file (web/lib/splitDiff.ts). Deterministik, tanpa biaya model: bun run check:diff */
import { splitDiff, summarize } from "../web/lib/splitDiff.ts";

const modified = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
-two
+TWO
+three
 four
@@ -10,2 +11,2 @@
 x
-y
+z
`;

const added = `diff --git a/n.ts b/n.ts
new file mode 100644
index 0..1
--- /dev/null
+++ b/n.ts
@@ -0,0 +1,2 @@
+a
+b
`;

const deleted = `diff --git a/d.ts b/d.ts
deleted file mode 100644
index 1..0
--- a/d.ts
+++ /dev/null
@@ -1 +0,0 @@
-a
`;

const renamePure = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;

const renameChanged = `diff --git a/old.ts b/new.ts
similarity index 80%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
`;

const binary = `diff --git a/logo.png b/logo.png
index 1..2 100644
Binary files a/logo.png and b/logo.png differ
`;

const tricky = `diff --git a/x.md b/x.md
index 1..2 100644
--- a/x.md
+++ b/x.md
@@ -1,2 +1,2 @@
----
+---
-end
\\ No newline at end of file
+end!
`;

const second = `diff --git a/b.ts b/b.ts
index 1..2 100644
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-a
+b
`;

const modifiedStaged = splitDiff(modified, "staged");
const files = [...modifiedStaged, ...splitDiff(modified, "unstaged")];

type Case = [name: string, ok: boolean];
const CASES: Case[] = [
  ["path, status, tambah/hapus", (() => {
    const f = splitDiff(modified, "unstaged")[0];
    return f?.path === "src/a.ts" && f.status === "M" && f.additions === 3 && f.deletions === 2;
  })()],
  ["patch disimpan mulai dari baris ---", splitDiff(modified, "unstaged")[0]?.hunks[0]?.startsWith("--- a/src/a.ts\n+++ b/src/a.ts\n@@") === true],
  ["dua file jadi dua entri", splitDiff(`${modified}${second}`, "staged").map((f) => f.path).join() === "src/a.ts,b.ts"],
  ["file baru = A", splitDiff(added, "staged")[0]?.status === "A" && splitDiff(added, "staged")[0]?.additions === 2],
  ["file belum dilacak = U", splitDiff(added, "untracked")[0]?.status === "U"],
  ["file terhapus = D, path dari sisi lama", (() => {
    const f = splitDiff(deleted, "unstaged")[0];
    return f?.status === "D" && f.path === "d.ts" && f.deletions === 1;
  })()],
  ["rename murni tanpa hunk", (() => {
    const f = splitDiff(renamePure, "staged")[0];
    return f?.status === "R" && f.oldPath === "old.ts" && f.path === "new.ts" && f.hunks.length === 0;
  })()],
  ["rename dengan perubahan", (() => {
    const f = splitDiff(renameChanged, "staged")[0];
    return f?.status === "R" && f.additions === 1 && f.deletions === 1;
  })()],
  ["file biner tanpa hunk", (() => {
    const f = splitDiff(binary, "unstaged")[0];
    return f?.binary === true && f.hunks.length === 0 && f.path === "logo.png";
  })()],
  ["isi berawalan ---/+++ dihitung, 'No newline' diabaikan", (() => {
    const f = splitDiff(tricky, "unstaged")[0];
    return f?.additions === 2 && f.deletions === 2;
  })()],
  ["keluaran kosong tanpa entri", splitDiff("  \n", "staged").length === 0],
  ["summarize menggabung path yang sama", (() => {
    const s = summarize(files);
    return s.files === 1 && s.additions === 6 && s.deletions === 4;
  })()],
];

let gagal = 0;
for (const [name, ok] of CASES) {
  if (!ok) gagal += 1;
  console.log(`${ok ? "  ok  " : "GAGAL "} ${name}`);
}
console.log(`\n${CASES.length - gagal}/${CASES.length} kasus sesuai harapan`);
if (gagal > 0) process.exitCode = 1;
