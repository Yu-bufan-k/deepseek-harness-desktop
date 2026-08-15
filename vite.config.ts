import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/ui",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/renderer/workbench",
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome142"
  }
});
