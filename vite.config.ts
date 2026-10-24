import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri drives this dev server; fixed port + strictPort keep devUrl honest.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 6420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "esnext",
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
