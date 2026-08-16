import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/main/credential-store.js";
import { SettingsStore } from "../src/main/settings-store.js";
import { VisionService } from "../src/main/vision-service.js";
import type {
  DirectVisionBackendConfig,
  VisionSettings,
} from "../src/shared/contracts.js";

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-vision-"));
  directories.push(directory);
  const settings = new SettingsStore(directory);
  await settings.load();
  const credentials = {
    get: vi.fn(async () => "secret"),
  } as unknown as CredentialStore;
  return { service: new VisionService(settings, credentials, directory) };
}

const backend: DirectVisionBackendConfig = {
  id: "direct",
  kind: "direct",
  name: "兼容视觉",
  enabled: true,
  model: "vision-model",
  timeoutMs: 10_000,
  baseUrl: "https://vision.example/v1",
  credentialName: "VISION_API_KEY",
};
const configured: VisionSettings = {
  policy: "auto",
  defaultBackendId: backend.id,
  remoteDisclosureAccepted: true,
  imageDirectory: null,
  backends: [backend],
};
const pixel = "data:image/png;base64,iVBORw0KGgo=";

describe("VisionService", () => {
  it("calls an OpenAI-compatible vision endpoint and caches text output", async () => {
    const { service } = await fixture();
    await service.setSettings(configured);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "一张测试图片" } }],
            usage: { prompt_tokens: 12, completion_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      requestId: "one",
      question: "描述图片",
      imageDataUrl: pixel,
      mimeType: "image/png",
    };
    const first = await service.analyze(request);
    const second = await service.analyze({ ...request, requestId: "two" });
    expect(first.text).toBe("一张测试图片");
    expect(first.usage.outputTokens).toBe(5);
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires disclosure before sending an image to a remote backend", async () => {
    const { service } = await fixture();
    await service.setSettings({
      ...configured,
      remoteDisclosureAccepted: false,
    });
    await expect(
      service.analyze({
        requestId: "one",
        question: "描述",
        imageDataUrl: pixel,
        mimeType: "image/png",
      }),
    ).rejects.toThrow("数据外发");
  });

  it("reads a trusted imagePath and sends its data URL to a direct backend", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-vision-file-"));
    directories.push(directory);
    const file = path.join(directory, "pixel.png");
    await writeFile(file, Buffer.from("iVBORw0KGgo=", "base64"));
    const { service } = await fixture();
    await service.setSettings(configured);
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "读盘成功" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await service.analyze({
      requestId: "one",
      question: "描述",
      imagePath: file,
      mimeType: "image/png",
    });
    expect(result.text).toBe("读盘成功");
    const requestBody = JSON.parse(
      fetchMock.mock.calls[0]![1]!.body as string,
    );
    expect(requestBody.messages[0].content[1].image_url.url).toContain(
      "base64,iVBORw0KGgo=",
    );
  });

  it("rejects backend configs that reference a nonexistent default", async () => {
    const { service } = await fixture();
    await expect(
      service.setSettings({
        policy: "auto",
        defaultBackendId: "missing",
        remoteDisclosureAccepted: false,
        imageDirectory: null,
        backends: [backend],
      }),
    ).rejects.toThrow("默认视觉服务不存在");
  });
});
