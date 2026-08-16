// 视觉解析服务端插件：给 Harness 助手注册 vision_understand 工具。
// 图片经侧边栏拦截存盘后在消息里留下「[已保存图片: <id>]」占位，本工具按 imageId
// 回调桌面主进程（DirectoryPickerBridge HTTP，经 DSH_DESKTOP_BRIDGE_PORT/TOKEN
// 认证），让 VisionService 用配置的视觉后端解析，返回纯文本给主模型。
// policy 门控：off 直接抛错；auto 只在主模型不支持原生图片输入时解析（照
// dsh-tool-fs 的 assertImageCapableRoute 模式查 inputModalities）；always 一律解析。

const CONFIG_ENDPOINT = "/vision/config";
const ANALYZE_ENDPOINT = "/vision/analyze";
const IMAGE_GENERATE_ENDPOINT = "/image/generate";
const DESIGN_REVIEW_ENDPOINT = "/design/review";

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
    ctx.tools.register({
      name: "generate_image",
      description:
        "根据文字描述直接生成图片（调用配置的生图服务，如智谱 CogView）。调用策略：同一主题需要多个变体供用户选择时，一次调用用 variants=3 生成三个方案并让用户挑选；用户已选定方案、只做局部修改时用 variants=1 直接生成一张。注意：同一主题的多个变体（如某对象的几个不同状态/角度/风格）应该用一次 variants 调用，不要拆成多次调用；只有内容完全不同、彼此无关的多张图才需要多次调用。",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "图片内容描述，尽量具体（主体、风格、配色、构图、文字要求）；迭代修改时把原图描述与修改点合并",
          },
          variants: {
            type: "integer",
            description: "可选；方案数量 1-6，缺省 3（首次探索用 3 选 1，局部修改用 1 直出）。用户明确指定要生成多少张时，以用户指定为准",
            minimum: 1,
            maximum: 6,
          },
          size: {
            type: "string",
            description: "可选；尺寸，推荐 1024x1024 / 768x1344 / 864x1152 / 1344x768 / 1152x864 / 1440x720 / 720x1440，缺省 1024x1024",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const prompt = String(args?.prompt ?? "").trim();
        if (!prompt) throw new Error("generate_image 需要非空的 prompt");
        const size = String(args?.size ?? "").trim();
        const variants = Number(args?.variants ?? 3);
        const result = await bridgeFetch(bridge, IMAGE_GENERATE_ENDPOINT, {
          method: "POST",
          body: JSON.stringify({
            prompt,
            ...(Number.isInteger(variants) && variants >= 1 && variants <= 6
              ? { variants }
              : {}),
            ...(size ? { size } : {}),
          }),
        });
        const total = Array.isArray(result.images) ? result.images.length : 1;
        const selected = result.selected;
        if (!selected || typeof selected.filePath !== "string" || !selected.filePath) {
          return {
            text:
              "用户明确放弃/拒绝了本次生成的所有方案（关闭了选择窗口或点了取消）。你必须立即停下，不要继续调用任何生图工具、不要声称任何图片已被用户确认；直接向用户确认下一步：重新描述、调整方向后重试，还是停止。等待用户新的指示。",
          };
        }
        const imageId =
          typeof selected.imageId === "string" ? selected.imageId : "";
        return {
          text:
            "图片已生成并保存到：" +
            selected.filePath +
            (total > 1 ? "（共生成 " + total + " 个方案，用户选择了其中之一）" : "") +
            (imageId
              ? "。如需查看图片内容，请调用 vision_understand 解析（imageId: " +
                imageId +
                "），不要用 read_image（当前模型可能不支持图片输入）"
              : ""),
        };
      },
    }),
    ctx.tools.register({
      name: "design_review",
      description:
        "把一段 HTML 渲染成页面并截图，用视觉模型评审其视觉设计（布局、对齐、配色、间距、信息层级、可读性），返回评审意见。适合先写出 HTML 再评审迭代出高质量的界面。请使用内联 CSS 与内联图片（外部资源无法加载），页面按桌面尺寸 1280x800 渲染。",
      parameters: {
        type: "object",
        properties: {
          html: {
            type: "string",
            description: "要评审的完整 HTML 片段（可含内联 CSS 与样式）",
          },
          question: {
            type: "string",
            description: "可选；指定评审关注点（如“重点看配色与对比度”）",
          },
        },
        required: ["html"],
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const html = String(args?.html ?? "");
        if (!html.trim()) throw new Error("design_review 需要非空的 html");
        const question = String(args?.question ?? "").trim();
        const result = await bridgeFetch(bridge, DESIGN_REVIEW_ENDPOINT, {
          method: "POST",
          body: JSON.stringify({
            html,
            ...(question ? { question } : {}),
          }),
        });
        if (typeof result?.text !== "string" || !result.text)
          throw new Error("设计评审没有返回结果");
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
