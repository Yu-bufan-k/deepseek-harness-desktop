import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DirectoryPickerBridge,
  type VisionBridgeHandlers,
} from "../src/main/directory-picker-bridge.js";

const bridges: DirectoryPickerBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

const vision = (): { handlers: VisionBridgeHandlers; analyze: ReturnType<typeof vi.fn>; getConfig: ReturnType<typeof vi.fn> } => {
  const analyze = vi.fn(async () => ({
    text: "画面里有一张桌子",
    backendName: "千问视觉",
    model: "qwen-vl-max",
    cached: false,
    durationMs: 12,
  }));
  const getConfig = vi.fn(async () => ({
    policy: "auto" as const,
    hasBackends: true,
    defaultBackendId: "qwen",
  }));
  return { handlers: { analyze, getConfig }, analyze, getConfig };
};

function start(bridge: DirectoryPickerBridge) {
  bridges.push(bridge);
  return bridge.start();
}

describe("DirectoryPickerBridge 视觉路由", () => {
  it("GET /vision/config 返回插件需要的门控信息", async () => {
    const { handlers, getConfig } = vision();
    const info = await start(new DirectoryPickerBridge(async () => null, handlers));
    const denied = await fetch(`http://127.0.0.1:${info.port}/vision/config`);
    expect(denied.status).toBe(401);
    expect(getConfig).not.toHaveBeenCalled();

    const accepted = await fetch(
      `http://127.0.0.1:${info.port}/vision/config`,
      { headers: { authorization: `Bearer ${info.token}` } },
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      policy: "auto",
      hasBackends: true,
      defaultBackendId: "qwen",
    });
    expect(getConfig).toHaveBeenCalledOnce();
  });

  it("POST /vision/analyze 校验 body 并回传 handlers 结果", async () => {
    const { handlers, analyze } = vision();
    const info = await start(new DirectoryPickerBridge(async () => null, handlers));
    const url = `http://127.0.0.1:${info.port}/vision/analyze`;

    const invalid = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ question: "缺 imageId" }),
    });
    expect(invalid.status).toBe(400);

    const accepted = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ imageId: "abc123", question: "描述一下" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      text: "画面里有一张桌子",
      backendName: "千问视觉",
      model: "qwen-vl-max",
      cached: false,
      durationMs: 12,
    });
    expect(analyze).toHaveBeenCalledWith({
      imageId: "abc123",
      question: "描述一下",
    });

    const withBackend = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ imageId: "abc123", question: "再描述", backendId: "other" }),
    });
    expect(withBackend.status).toBe(200);
    expect(analyze).toHaveBeenLastCalledWith({
      imageId: "abc123",
      question: "再描述",
      backendId: "other",
    });
  });

  it("未注入 vision handlers 时视觉路由返回 404", async () => {
    const info = await start(new DirectoryPickerBridge(async () => null));
    const response = await fetch(
      `http://127.0.0.1:${info.port}/vision/config`,
      { headers: { authorization: `Bearer ${info.token}` } },
    );
    expect(response.status).toBe(404);
  });

  it("handlers 抛错时统一回 500 + error", async () => {
    const analyze = vi.fn(async () => {
      throw new Error("视觉服务未配置凭据");
    });
    const info = await start(
      new DirectoryPickerBridge(async () => null, { analyze, getConfig: async () => ({ policy: "auto" as const, hasBackends: false, defaultBackendId: null }) }),
    );
    const response = await fetch(
      `http://127.0.0.1:${info.port}/vision/analyze`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${info.token}` },
        body: JSON.stringify({ imageId: "abc", question: "q" }),
      },
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("未配置凭据");
  });
});
