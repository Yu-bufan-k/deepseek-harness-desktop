// 视觉解析服务端插件：给 Harness 助手注册 vision_understand 工具。
// 图片经侧边栏拦截存盘后在消息里留下「[已保存图片: <id>]」占位，本工具按 imageId
// 回调桌面主进程（DirectoryPickerBridge HTTP，经 DSH_DESKTOP_BRIDGE_PORT/TOKEN
// 认证），让 VisionService 用配置的视觉后端解析，返回纯文本给主模型。
// policy 门控：off 直接抛错；auto 只在主模型不支持原生图片输入时解析（照
// dsh-tool-fs 的 assertImageCapableRoute 模式查 inputModalities）；always 一律解析。

const CONFIG_ENDPOINT = "/vision/config";
const ANALYZE_ENDPOINT = "/vision/analyze";

const DEFAULT_QUESTION = "请详细描述这张图片并提取其中的文字与结构。";

function bridgeBase() {
  const port = process.env.DSH_DESKTOP_BRIDGE_PORT;
  const token = process.env.DSH_DESKTOP_BRIDGE_TOKEN;
  if (!port || !token) return null;
  return { port, token };
}

async function bridgeFetch(base, endpoint, init) {
  const response = await fetch(`http://127.0.0.1:${base.port}${endpoint}`, {
    ...init,
    headers: {
      authorization: `Bearer ${base.token}`,
      ...(init?.headers ?? {}),
    },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = null; // 非 JSON 响应，按无 body 处理
  }
  if (!response.ok) {
    throw new Error(
      body && typeof body.error === "string"
        ? body.error
        : `桌面视觉桥调用失败（HTTP ${response.status}）`,
    );
  }
  return body;
}

// 照 dsh-tool-fs 的 assertImageCapableRoute：解析当前模型路由并查 inputModalities。
// 任一环缺失（拿不到 provider/model/llm）返回 false，调用方据此不拦截、继续解析。
async function modelSupportsImage(ctx, exec) {
  const routed = exec?.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  const llm = ctx.get?.("llm");
  if (!provider || !model || !llm) return false;
  try {
    const active = await llm.resolveModelInfo(provider, model, exec.signal);
    return Array.isArray(active?.inputModalities)
      ? active.inputModalities.includes("image")
      : false;
  } catch {
    return false;
  }
}

const parameters = {
  type: "object",
  properties: {
    imageId: {
      type: "string",
      description: "消息中「[已保存图片: <id>]」占位符里的 id",
    },
    question: {
      type: "string",
      description: "可选；针对图片提出的问题，缺省为详细描述并提取文字",
    },
  },
  required: ["imageId"],
  additionalProperties: false,
};

const output = {
  schema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  render(_args, value) {
    return [{ type: "text", text: value.text }];
  },
};

export const name = "desktop-vision";
export const inject = ["tools"];

export function apply(ctx) {
  const bridge = bridgeBase();
  if (!bridge) {
    ctx.logger?.warn?.(
      "desktop-vision: 缺少 DSH_DESKTOP_BRIDGE_PORT/TOKEN，跳过工具注册",
    );
    return;
  }
  const disposers = [
    ctx.tools.register({
      name: "vision_understand",
      description:
        "解析对话消息中以「[已保存图片: <id>]」占位出现的图片，把视觉服务返回的文字结果交给模型。当模型无法直接读取图片、且视觉解析已启用时调用。",
      parameters,
      output,
      async execute(args, exec) {
        const imageId = String(args?.imageId ?? "").trim();
        if (!imageId) throw new Error("vision_understand 需要非空的 imageId");
        const question =
          String(args?.question ?? "").trim() || DEFAULT_QUESTION;

        const config = await bridgeFetch(bridge, CONFIG_ENDPOINT, {});
        if (config.policy === "off")
          throw new Error("视觉解析已关闭，请在 Harness 设置-视觉 中开启");
        if (config.policy === "auto" && (await modelSupportsImage(ctx, exec)))
          throw new Error(
            "当前模型支持原生图片输入，无需视觉解析；请直接用 read_image 读取该图片路径",
          );
        if (!config.hasBackends)
          throw new Error("尚未配置视觉服务，请在 Harness 设置-视觉 中添加");

        const result = await bridgeFetch(bridge, ANALYZE_ENDPOINT, {
          method: "POST",
          body: JSON.stringify({
            imageId,
            question,
            ...(config.defaultBackendId
              ? { backendId: config.defaultBackendId }
              : {}),
          }),
        });
        if (typeof result?.text !== "string" || !result.text)
          throw new Error("视觉服务没有返回可用的文字结果");
        return { text: result.text };
      },
    }),
  ];
  ctx.effect(
    () => () => {
      for (const dispose of disposers) dispose();
    },
    "desktop-vision.tools",
  );
}
