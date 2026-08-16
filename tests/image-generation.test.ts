import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/main/credential-store.js";
import { SettingsStore } from "../src/main/settings-store.js";
import {
  ImageGenerationService,
  DEFAULT_IMAGE_SETTINGS,
} from "../src/main/image-generation.js";
import type { ImageSettings } from "../src/shared/contracts.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  return Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-image-"));
  directories.push(directory);
  const settings = new SettingsStore(directory);
  await settings.load();
  const credentials = {
    get: vi.fn(async () => "secret"),
  } as unknown as CredentialStore;
  return {
    service: new ImageGenerationService(
      settings,
      credentials,
      path.join(directory, "images"),
    ),
    directory,
  };
}

const configured: ImageSettings = {
  defaultBackendId: "cogview",
  imageDirectory: null,
  backends: [
    {
      id: "cogview",
      name: "智谱 CogView",
      enabled: true,
      model: "cogview-3-flash",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      credentialName: "ZHIPU_API_KEY",
    },
  ],
};

describe("ImageGenerationService", () => {
  it("rejects generation when no backend is configured", async () => {
    const { service } = await fixture();
    await service.setSettings(DEFAULT_IMAGE_SETTINGS);
    await expect(service.generate("一只猫", "1024x1024", 1)).rejects.toThrow(
      "尚未配置生图服务",
    );
  });

  it("calls the images endpoint and saves the returned image", async () => {
    const { service } = await fixture();
    await service.setSettings(configured);
    const pixel = Buffer.from("iVBORw0KGgo=", "base64");
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: [{ b64_json: pixel.toString("base64") }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { images, failures } = await service.generate("一只猫", "1024x1024", 1);
    expect(failures).toHaveLength(0);
    expect(images).toHaveLength(1);
    const result = images[0]!;
    expect(result.mimeType).toBe("image/png");
    expect(result.filePath).toContain("images");
    expect(result.imageId).toHaveLength(64);
    const saved = await readFile(result.filePath);
    expect(saved.equals(pixel)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://open.bigmodel.cn/api/paas/v4/images/generations",
    );
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe("cogview-3-flash");
    expect(body.prompt).toBe("一只猫");
    expect(body.watermark).toBe(false);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
  });

  it("generates multiple variants and keeps successful ones on partial failure", async () => {
    const { service } = await fixture();
    await service.setSettings(configured);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => {
          call += 1;
          if (call === 2)
            return new Response(JSON.stringify({ error: "boom" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          // 每次成功的图片内容不同（不同 sha256 → 不同文件路径）
          const pixel = Buffer.from([
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, call,
          ]);
          return new Response(
            JSON.stringify({
              data: [{ b64_json: pixel.toString("base64") }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      ),
    );
    const { images, failures } = await service.generate("猫", "1024x1024", 3);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("HTTP 500");
    expect(images).toHaveLength(2);
  });

  it("throws a readable error when the provider rejects all variants", async () => {
    const { service } = await fixture();
    await service.setSettings(configured);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "模型不存在" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(service.generate("猫", "1024x1024", 3)).rejects.toThrow(
      "生图请求失败（HTTP 404）",
    );
  });
});
