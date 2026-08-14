import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { "main/index": "src/main/index.ts" },
    format: ["cjs"],
    platform: "node",
    target: "node22",
    bundle: true,
    sourcemap: true,
    external: ["electron", "@deepseek-ai/dsh"],
    clean: false
  },
  {
    entry: { "preload/index": "src/preload/index.ts" },
    format: ["cjs"],
    platform: "node",
    target: "node22",
    bundle: true,
    sourcemap: true,
    external: ["electron"],
    clean: false
  },
  {
    entry: { "sidecar/electron-directory-picker": "src/sidecar/electron-directory-picker.ts" },
    format: ["esm"],
    platform: "node",
    target: "node24",
    bundle: true,
    sourcemap: true,
    external: ["@deepseek-ai/dsh-host-directory-picker"],
    clean: false
  }
]);
