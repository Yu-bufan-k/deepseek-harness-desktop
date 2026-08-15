import { createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const catalogPath = new URL("pricing/prices.json", root);
const envelopePath = new URL("pricing/prices.signed.json", root);
const publicKeyPath = new URL("pricing/catalog-public-key.pem", root);
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const payload = Buffer.from(canonicalJson(catalog));
const publicKey = await readFile(publicKeyPath, "utf8");
if (process.argv.includes("--verify")) {
  const envelope = JSON.parse(await readFile(envelopePath, "utf8"));
  if (canonicalJson(envelope.catalog) !== canonicalJson(catalog))
    throw new Error("签名清单与 prices.json 不一致");
  if (
    envelope.algorithm !== "Ed25519" ||
    envelope.keyId !== "pricing-ed25519-v1" ||
    !verify(null, payload, publicKey, Buffer.from(envelope.signature, "base64"))
  )
    throw new Error("价格清单签名无效");
  console.log("Pricing catalog signature is valid.");
} else {
  const privateKeyFileIndex = process.argv.indexOf("--private-key-file");
  const privateKey =
    process.env.PRICING_SIGNING_PRIVATE_KEY ||
    (privateKeyFileIndex >= 0
      ? await readFile(process.argv[privateKeyFileIndex + 1], "utf8")
      : "");
  if (!privateKey) throw new Error("缺少 PRICING_SIGNING_PRIVATE_KEY");
  const derivedPublic = createPublicKey(privateKey).export({
    type: "spki",
    format: "pem",
  });
  if (derivedPublic.trim() !== publicKey.trim())
    throw new Error("签名私钥与仓库公钥不匹配");
  const envelope = {
    algorithm: "Ed25519",
    keyId: "pricing-ed25519-v1",
    catalog,
    signature: sign(null, payload, privateKey).toString("base64"),
  };
  await writeFile(
    envelopePath,
    `${JSON.stringify(envelope, null, 2)}\n`,
    "utf8",
  );
  console.log("Signed pricing catalog.");
}
