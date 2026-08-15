import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/main/credential-store.js";
import { SettingsStore } from "../src/main/settings-store.js";
import { composeVisionPrompt, VisionService } from "../src/main/vision-service.js";
import type { DirectVisionBackendConfig, VisionSettings } from "../src/shared/contracts.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); return Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-vision-")); directories.push(directory);
  const settings = new SettingsStore(directory); await settings.load();
  const credentials = { get: vi.fn(async () => "secret") } as unknown as CredentialStore;
  return { service: new VisionService(settings, credentials, directory) };
}

const backend: DirectVisionBackendConfig = { id: "direct", kind: "direct", name: "兼容视觉", enabled: true, model: "vision-model", timeoutMs: 10_000, baseUrl: "https://vision.example/v1", credentialName: "VISION_API_KEY", headers: {}, headerCredentialNames: {} };
const configured: VisionSettings = { policy: "auto", defaultBackendId: backend.id, remoteDisclosureAccepted: true, backends: [backend] };
const pixel = "data:image/png;base64,iVBORw0KGgo=";

describe("VisionService", () => {
  it("calls an OpenAI-compatible vision endpoint and caches text output", async () => {
    const { service } = await fixture(); await service.setSettings(configured);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "一张测试图片" } }], usage: { prompt_tokens: 12, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const request = { requestId: "one", question: "描述图片", imageDataUrl: pixel, mimeType: "image/png" };
    const first = await service.analyze(request); const second = await service.analyze({ ...request, requestId: "two" });
    expect(first.text).toBe("一张测试图片"); expect(first.usage.outputTokens).toBe(5);
    expect(second.cached).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await service.listAttachments()).toMatchObject([{ id: "two", status: "ready", visionText: "一张测试图片" }, { id: "one", status: "ready" }]);
    expect(composeVisionPrompt("用户问题", first)).toContain("desktop_vision_context");
  });

  it("requires disclosure before sending an image to a remote backend", async () => {
    const { service } = await fixture(); await service.setSettings({ ...configured, remoteDisclosureAccepted: false });
    await expect(service.analyze({ requestId: "one", question: "描述", imageDataUrl: pixel, mimeType: "image/png" })).rejects.toThrow("数据外发");
  });

  it("rejects file-path mapping for a remote MCP backend", async () => {
    const { service } = await fixture();
    await expect(service.setSettings({ policy: "auto", defaultBackendId: "remote", remoteDisclosureAccepted: true, backends: [{ id: "remote", kind: "mcp", transport: "streamable-http", name: "远程 MCP", enabled: true, model: "vision", timeoutMs: 10_000, url: "https://mcp.example/api", headers: {}, headerCredentialNames: {}, toolName: "describe", mapping: { imageArgument: "image", imageEncoding: "path", questionArgument: "prompt", mimeTypeArgument: null, resultTextPath: null } }] })).rejects.toThrow("远程 MCP");
  });
});
