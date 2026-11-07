import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  root: "web",
  publicDir: "public",
  plugins: [react(), tailwind()],
  server: {
    host: "127.0.0.1",
    port: 4321,
    proxy: {
      // ws: true → WebSocket /api/ws ikut diteruskan (satu sambungan per tab untuk semua event live).
      "/api": { target: "http://127.0.0.1:4320", changeOrigin: true, ws: true },
      "/demo": { target: "http://127.0.0.1:4320", changeOrigin: true },
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
