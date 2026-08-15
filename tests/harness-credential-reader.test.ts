import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHarnessCredential } from "../src/main/harness-credential-reader.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("readHarnessCredential", () => {
  it("reads Harness plain and quoted credential scalars", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-credentials-"));
    roots.push(root);
    await writeFile(
      path.join(root, ".credentials.yaml"),
      "DEEPSEEK_API_KEY: sk-secret\nOTHER_TOKEN: 'quoted-value'\n",
    );
    expect(await readHarnessCredential(root, "DEEPSEEK_API_KEY")).toBe(
      "sk-secret",
    );
    expect(await readHarnessCredential(root, "OTHER_TOKEN")).toBe(
      "quoted-value",
    );
  });

  it("rejects complex YAML values instead of guessing around secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-credentials-"));
    roots.push(root);
    await writeFile(
      path.join(root, ".credentials.yaml"),
      "DEEPSEEK_API_KEY: value # comment\n",
    );
    expect(await readHarnessCredential(root, "DEEPSEEK_API_KEY")).toBeNull();
  });
});
