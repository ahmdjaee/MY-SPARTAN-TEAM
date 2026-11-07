/** Jalankan API dan Vite bersamaan tanpa dependency tambahan. */
import { spawn } from "node:child_process";

const children = [
  spawn("bun", ["server/main.ts"], { stdio: "inherit" }),
  spawn("bun", ["--bun", "vite"], { stdio: "inherit" }),
];

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", (code) => { if (code) stop(); });
