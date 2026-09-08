import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Development only: point /api at a running `aiongside view web` server.
const apiTarget = process.env.AIONGSIDE_WEB_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: {
      "/api": { target: apiTarget, changeOrigin: false },
    },
  },
});
