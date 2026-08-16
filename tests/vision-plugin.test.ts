import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error No declaration file is emitted for this local plugin.
import { apply } from "../plugins/vision/index.js";

const PORT = "19321";
const TOKEN = "vision-test-token";

afterEach(() => {
  delete process.env.DSH_DESKTOP_BRIDGE_PORT;
  delete process.env.DSH_DESKTOP_BRIDGE_TOKEN;
  vi.unstubAllGlobals();
});

type ToolDef = {
  name: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>;
  };
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
};

type LazyValue<T> = { value: T };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function install(options: {
  config?: LazyValue<Record<string, unknown>>;
  analyzeResult?: LazyValue<Record<string, unknown>>;
  llm?: { resolveModelInfo: ReturnType<typeof vi.fn> };
}): { definitions: Map<string, ToolDef>; warn: ReturnType<typeof vi.fn> } {
  process.env.DSH_DESKTOP_BRIDGE_PORT = PORT;
  process.env.DSH_DESKTOP_BRIDGE_TOKEN = TOKEN;
  const definitions = new Map<string, ToolDef>();
  const disposers: Array<() => void> = [];
  const warn = vi.fn();
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/vision/config"))
      return jsonResponse(options.config?.value ?? {});
    if (url.endsWith("/vision/analyze"))
      return jsonResponse(options.analyzeResult?.value ?? {});
    return jsonResponse({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const ctx = {
    tools: {
      register: (definition: ToolDef): (() => void) => {
        definitions.set(definition.name, definition);
        const disposer = (): void => {};
        disposers.push(disposer);
        return disposer;
      },
    },
    logger: { warn },
    effect: (fn: () => unknown) => fn(),
    get: (key: string): unknown => (key === "llm" ? options.llm : undefined),
  };
  apply(ctx);
  return { definitions, warn };
}

function execFor(provider = "deepseek", model = "deepseek-chat"): unknown {
  return {
    agent: {
      session: { requestHeader: () => ({ config: { provider, model } }) },
      options: { provider, model },
    },
    signal: new AbortController().signal,
  };
}

const autoConfig = (overrides: Record<string, unknown> = {}) =>
  ({ policy: "auto", hasBackends: true, defaultBackendId: null, ...overrides });

describe("desktop-vision 插件", () => {
  it("缺少 DSH_DESKTOP_BRIDGE_PORT/TOKEN 时只告警不注册工具", () => {
    const warn = vi.fn();
    apply({
      tools: { register: () => () => {} },
      logger: { warn },
      effect: () => {},
      get: () => undefined,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("DSH_DESKTOP_BRIDGE_PORT"),
    );
  });

  it("环境变量就绪时注册 vision_understand", () => {
    const { definitions, warn } = install({});
    expect([...definitions.keys()]).toEqual(["vision_understand"]);
    expect(warn).not.toHaveBeenCalled();
    const parameters = definitions.get("vision_understand")!.parameters as {
      required: string[];
    };
    expect(parameters.required).toEqual(["imageId"]);
  });

  it("policy=off 时抛「视觉解析已关闭」", async () => {
    const { definitions } = install({ config: { value: autoConfig({ policy: "off" }) } });
    const tool = definitions.get("vision_understand")!;
    await expect(tool.execute({ imageId: "abc" }, execFor())).rejects.toThrow(
      "视觉解析已关闭",
    );
  });

  it("auto + 模型支持图片时抛「请用 read_image」", async () => {
    const llm = {
      resolveModelInfo: vi.fn(async () => ({ inputModalities: ["text", "image"] })),
    };
    const { definitions } = install({ config: { value: autoConfig() }, llm });
    const tool = definitions.get("vision_understand")!;
    await expect(tool.execute({ imageId: "abc" }, execFor())).rejects.toThrow(
      "read_image",
    );
    expect(llm.resolveModelInfo).toHaveBeenCalledWith(
      "deepseek",
      "deepseek-chat",
      expect.any(AbortSignal),
    );
  });

  it("auto + 纯文本模型走 analyze 并返回 { text }", async () => {
    const llm = {
      resolveModelInfo: vi.fn(async () => ({ inputModalities: ["text"] })),
    };
    const analyzeResult = { value: { text: "画面里有一张桌子" } };
    const { definitions } = install({
      config: { value: autoConfig() },
      analyzeResult,
      llm,
    });
    const tool = definitions.get("vision_understand")!;
    const result = (await tool.execute(
      { imageId: "abc", question: "描述一下" },
      execFor(),
    )) as { text: string };
    expect(result.text).toBe("画面里有一张桌子");
    const analyzeCall = vi.mocked(fetch).mock.calls.find(
      ([input]) => String(input).endsWith("/vision/analyze"),
    )!;
    const init = analyzeCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      imageId: "abc",
      question: "描述一下",
    });
  });

  it("auto + 缺省 backendId 时 analyze 请求带上默认服务", async () => {
    const llm = {
      resolveModelInfo: vi.fn(async () => ({ inputModalities: ["text"] })),
    };
    const analyzeResult = { value: { text: "ok" } };
    const { definitions } = install({
      config: { value: autoConfig({ defaultBackendId: "qwen" }) },
      analyzeResult,
      llm,
    });
    const tool = definitions.get("vision_understand")!;
    await tool.execute({ imageId: "abc" }, execFor());
    const analyzeCall = vi.mocked(fetch).mock.calls.find(
      ([input]) => String(input).endsWith("/vision/analyze"),
    )!;
    const init = analyzeCall[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      imageId: "abc",
      question: "请详细描述这张图片并提取其中的文字与结构。",
      backendId: "qwen",
    });
  });

  it("无后端时抛「尚未配置视觉服务」", async () => {
    const llm = {
      resolveModelInfo: vi.fn(async () => ({ inputModalities: ["text"] })),
    };
    const { definitions } = install({
      config: {
        value: autoConfig({ hasBackends: false, defaultBackendId: null }),
      },
      llm,
    });
    const tool = definitions.get("vision_understand")!;
    await expect(tool.execute({ imageId: "abc" }, execFor())).rejects.toThrow(
      "尚未配置视觉服务",
    );
  });

  it("auto + llm 不可用时不拦截，直接解析（保守默认）", async () => {
    const analyzeResult = { value: { text: "仍然返回" } };
    const { definitions } = install({
      config: { value: autoConfig() },
      analyzeResult,
      llm: undefined,
    });
    const tool = definitions.get("vision_understand")!;
    const result = (await tool.execute({ imageId: "abc" }, {})) as {
      text: string;
    };
    expect(result.text).toBe("仍然返回");
  });

  it("analyze 非 200 时抛后端返回的错误", async () => {
    const llm = {
      resolveModelInfo: vi.fn(async () => ({ inputModalities: ["text"] })),
    };
    const analyzeResult = { value: { error: "凭据未配置" } };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/vision/config"))
        return jsonResponse(autoConfig());
      return jsonResponse(analyzeResult.value, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.DSH_DESKTOP_BRIDGE_PORT = PORT;
    process.env.DSH_DESKTOP_BRIDGE_TOKEN = TOKEN;
    const definitions = new Map<string, ToolDef>();
    const ctx = {
      tools: { register: (d: ToolDef) => (definitions.set(d.name, d), () => {}) },
      logger: { warn: vi.fn() },
      effect: (fn: () => unknown) => fn(),
      get: () => llm,
    };
    apply(ctx);
    const tool = definitions.get("vision_understand")!;
    await expect(tool.execute({ imageId: "abc" }, execFor())).rejects.toThrow(
      "凭据未配置",
    );
  });

  it("render 输出可读文本", () => {
    const { definitions } = install({});
    const blocks = definitions.get("vision_understand")!.output.render(
      { imageId: "abc" },
      { text: "画面里有一张桌子" },
    );
    expect(blocks[0]!.text).toBe("画面里有一张桌子");
  });

  it("空 imageId 抛错", async () => {
    const { definitions } = install({});
    const tool = definitions.get("vision_understand")!;
    await expect(tool.execute({ imageId: "  " }, execFor())).rejects.toThrow(
      "非空的 imageId",
    );
  });
});
