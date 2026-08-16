import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

/** Electron 桌面端：主进程/预加载/sidecar 打包为 Node 产物，UI 层运行在浏览器页面内。 */
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "release/**",
      ".pack-app/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      // 只启用经典稳定的两条规则。v7 的 flat.recommended 还会开启一批面向
      // React Compiler 的规则（refs / set-state-in-effect / purity / immutability
      // 等），它们对手写 React 18 的常规写法（latest-ref、挂载即拉取）误报，
      // 本项目不接入 Compiler，故不启用。
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: [
      "src/main/**/*.ts",
      "src/preload/**/*.ts",
      "src/shared/**/*.ts",
      "scripts/**/*.{ts,mjs}",
      "*.config.{ts,mjs}",
      "*.mjs",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Cordis 服务端插件运行在 Harness Node 子进程（如 plugins/billing、plugins/memory）。
    files: ["plugins/**/*.{js,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // `_` 前缀约定：解构里故意丢弃的字段（`label: _label` 等）不算未使用。
    files: ["**/*.{ts,tsx,mjs}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: [
      "src/ui/**/*.{ts,tsx}",
      "src/renderer/**/*.ts",
      "src/sidecar/**/*.ts",
      "tests/**/*.ts",
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  prettier,
);
