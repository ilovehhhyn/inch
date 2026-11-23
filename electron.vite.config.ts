// Configures the electron-vite build of the main process, the preload script and the renderer.
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { rollupOptions: { input: { main: "src/main/main.ts" } } } },
  preload: { build: { rollupOptions: { input: { preload: "src/main/preload.ts" } } } },
  renderer: { root: "src/renderer", plugins: [react()], build: { rollupOptions: { input: { index: "src/renderer/index.html" } } } },
});
