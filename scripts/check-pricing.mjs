import { readFile, writeFile } from "node:fs/promises";

const source = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const catalog = JSON.parse(await readFile(new URL("../pricing/prices.json", import.meta.url), "utf8"));
const response = await fetch(source, { headers: { "user-agent": "deepseek-harness-desktop-pricing-check" } });
if (!response.ok) throw new Error(`DeepSeek pricing page returned HTTP ${response.status}`);
const text = (await response.text())
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#xA0;/gi, " ")
  .replace(/\s+/g, " ");

const expected = [
  "0.02元", "1元", "2元", "0.025元", "3元", "6元",
  "0.05元", "1.5元", "4.5元", "0.10元", "3.0元", "9.0元",
  "0.15元", "13.5元", "0.30元", "27.0元", "2026 年 8 月 17 日"
];
const missing = expected.filter((part) => !text.includes(part));
const result = {
  changed: missing.length > 0,
  checkedAt: new Date().toISOString(),
  source,
  catalogPublishedAt: catalog.publishedAt,
  missing,
  note: missing.length ? "官方页面不再包含当前价格清单的一个或多个关键值，请人工复核并更新 prices.json。" : "官方页面与当前价格关键值一致。"
};
await writeFile("pricing-check.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result));
