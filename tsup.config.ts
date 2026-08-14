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
  }
]);
