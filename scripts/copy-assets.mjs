import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

await mkdir("dist/renderer", { recursive: true });
await cp("src/renderer", "dist/renderer", { recursive: true });
await mkdir("dist/plugins", { recursive: true });
await cp("plugins/billing", "dist/plugins/billing", { recursive: true });
const require = createRequire(import.meta.url);
const themePackage =
  require.resolve("@deepseek-ai/dsh-client-ui-theme/package.json");
const themeStyles = path.join(path.dirname(themePackage), "lib", "styles");
await mkdir("dist/renderer/harness-theme", { recursive: true });
for (const file of ["base.css", "design-platform.css", "scrollbar.css"]) {
  await cp(
    path.join(themeStyles, file),
    path.join("dist/renderer/harness-theme", file),
  );
}
