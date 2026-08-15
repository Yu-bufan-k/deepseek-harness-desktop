import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryPickerBridge } from "../src/main/directory-picker-bridge.js";

const bridges: DirectoryPickerBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

describe("DirectoryPickerBridge", () => {
  it("只允许携带随机令牌的回环请求调用系统选择器", async () => {
    const picker = vi.fn(async () => "C:\\workspace");
    const bridge = new DirectoryPickerBridge(picker);
    bridges.push(bridge);
    const info = await bridge.start();
    const url = `http://127.0.0.1:${info.port}/pick-directory`;

    const denied = await fetch(url, { method: "POST" });
    expect(denied.status).toBe(401);
    expect(picker).not.toHaveBeenCalled();

    const accepted = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ path: "C:\\workspace" });
    expect(picker).toHaveBeenCalledOnce();
  });

  it("把用户取消操作作为 null 返回", async () => {
    const bridge = new DirectoryPickerBridge(async () => null);
    bridges.push(bridge);
    const info = await bridge.start();
    const response = await fetch(
      `http://127.0.0.1:${info.port}/pick-directory`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${info.token}` },
      },
    );
    expect(await response.json()).toEqual({ path: null });
  });
});
