import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // Task 1 (assistant-ui-migration): tailwindcss() added ahead of the
  // existing react() plugin, per TASKS.md's Task 1 technical design.
  plugins: [tailwindcss(), react()],

  // Task 7 (assistant-ui-migration): "@/*" -> "./src/*" resolver, matching
  // the tsconfig.json alias above — required by shadcn's Vite installation
  // flow (`npx shadcn add`) so its generated files' own "@/..." imports
  // resolve. No hand-written file in this project uses "@/" itself.
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
