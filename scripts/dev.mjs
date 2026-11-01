/** Jalankan API (tsx) dan Vite bersamaan tanpa dependency tambahan. */
import { spawn } from "node:child_process";

const children = [
  spawn("npx", ["tsx", "server/main.ts"], { stdio: "inherit" }),
  spawn("npx", ["vite"], { stdio: "inherit" }),
];

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", (code) => { if (code) stop(); });
