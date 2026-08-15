import { readFile, writeFile } from "node:fs/promises";

const source = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const supportingSources = [
  "https://api-docs.deepseek.com/quick_start/pricing/",
  "https://api-docs.deepseek.com/updates/",
];
const catalog = JSON.parse(
  await readFile(new URL("../pricing/prices.json", import.meta.url), "utf8"),
);
async function readOfficialPage(url) {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "deepseek-harness-desktop-pricing-check" },
      signal: AbortSignal.timeout(20_000),
    });
    return {
      url,
      ok: response.ok,
      status: response.status,
      body: response.ok ? await response.text() : "",
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
const checks = await Promise.all(
  [source, ...supportingSources].map(readOfficialPage),
);
const primary = checks[0];
const text = primary.body
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#xA0;/gi, " ")
  .replace(/\s+/g, " ");

const expected = [
  "0.02元",
  "1元",
  "2元",
  "0.025元",
  "3元",
  "6元",
  "0.05元",
  "1.5元",
  "4.5元",
  "0.10元",
  "3.0元",
  "9.0元",
  "0.15元",
  "13.5元",
  "0.30元",
  "27.0元",
  "2026 年 8 月 17 日",
];
const missing = expected.filter((part) => !text.includes(part));
const unavailable = checks
  .filter((check) => !check.ok)
  .map((check) => ({
    url: check.url,
    status: check.status,
    error: check.error,
  }));
const result = {
  changed: missing.length > 0 || unavailable.length > 0,
  checkedAt: new Date().toISOString(),
  source,
  catalogPublishedAt: catalog.publishedAt,
  missing,
  checks: checks.map(({ url, ok, status }) => ({ url, ok, status })),
  unavailable,
  note:
    missing.length || unavailable.length
      ? "官方页面内容或可用性发生变化，请人工复核；程序不会自动改价。"
      : "中英文价格页与更新日志可访问，中文价格页关键值与当前清单一致。",
};
await writeFile(
  "pricing-check.json",
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(result));
