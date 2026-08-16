// 生图服务：OpenAI 兼容 images/generations 接口（智谱 CogView / 百炼 wanx /
// SiliconFlow Qwen-Image 等），生成的图片存盘到 images 目录（可配置）。
// 多方案：一次生成 N 张（variants，发散阶段 3 选 1），选择器小窗让用户挑选；
// 迭代阶段 variants=1 直接返回（收敛，不再弹选择器）。
// 渲染预览：离屏 BrowserWindow 渲染 HTML → capturePage 截图（design_review 用）。
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BrowserWindow } from "electron";
import type { CredentialStore } from "./credential-store.js";
import type { SettingsStore } from "./settings-store.js";
import type {
  GeneratedImage,
  ImageBackendConfig,
  ImageSettings,
} from "../shared/contracts.js";

export const imageBackendSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  model: z.string().min(1).max(120),
  baseUrl: z.string().url().max(500),
  credentialName: z.string().min(1).max(80),
});

export const imageSettingsSchema = z.object({
  defaultBackendId: z.string().nullable(),
  /** 图片存盘目录；null = 默认 userData/images */
  imageDirectory: z.string().max(2000).optional().nullable(),
  backends: z.array(imageBackendSchema).max(16),
});

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  defaultBackendId: null,
  imageDirectory: null,
  backends: [],
};

export const imageExtension = (mimeType: string): string => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
};

function endpoint(baseUrl: string, suffix: string): string {
  return baseUrl.endsWith(suffix)
    ? baseUrl
    : `${baseUrl.replace(/\/$/, "")}${suffix}`;
}

export class ImageGenerationService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialStore,
    private readonly defaultImagesDirectory: string,
  ) {}

  private imagesDirectory(): string {
    const custom = this.getSettings().imageDirectory?.trim();
    return custom
      ? path.resolve(custom)
      : this.defaultImagesDirectory;
  }

  getSettings(): ImageSettings {
    return this.settings.get()?.image ?? DEFAULT_IMAGE_SETTINGS;
  }

  async setSettings(value: ImageSettings): Promise<ImageSettings> {
    const parsed = imageSettingsSchema.parse(value) as ImageSettings;
    const ids = new Set<string>();
    for (const backend of parsed.backends) {
      if (ids.has(backend.id)) throw new Error("生图服务 ID 不能重复");
      ids.add(backend.id);
    }
    if (parsed.defaultBackendId && !ids.has(parsed.defaultBackendId))
      throw new Error("默认生图服务不存在");
    await this.settings.patch({ image: parsed });
    return this.getSettings();
  }

  /** 当前可用的默认后端；未配置时返回 null。 */
  selected(): ImageBackendConfig | null {
    const settings = this.getSettings();
    const backend = settings.backends.find(
      (entry) => entry.id === settings.defaultBackendId,
    );
    return backend && backend.enabled ? backend : null;
  }

  /** 生成单个方案（一次 API 调用）。 */
  private async generateOne(
    backend: ImageBackendConfig,
    credential: string,
    prompt: string,
    size: string,
  ): Promise<GeneratedImage> {
    const response = await fetch(
      endpoint(backend.baseUrl, "/images/generations"),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: backend.model,
          prompt,
          size,
          n: 1,
          // 智谱免费模型默认加水印，这里显式关闭
          watermark: false,
        }),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `生图请求失败（HTTP ${response.status}）${detail ? "：" + detail.slice(0, 300) : ""}`,
      );
    }
    const body = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    const item = body.data?.[0];
    const b64 = item?.b64_json;
    if (typeof b64 !== "string" || !b64) {
      const url = item?.url;
      if (typeof url === "string" && url) {
        const fetched = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        const buffer = Buffer.from(await fetched.arrayBuffer());
        return this.saveBuffer(
          buffer,
          fetched.headers.get("content-type") ?? "image/png",
        );
      }
      throw new Error("生图服务没有返回图片数据");
    }
    const buffer = Buffer.from(b64, "base64");
    if (!buffer.length || buffer.length > 20 * 1024 * 1024)
      throw new Error("生成的图片无效或超过 20 MB");
    return this.saveBuffer(buffer, "image/png");
  }

  /**
   * 生成 variants 个方案（串行，避免同 prompt 并发触发服务端限流；单张失败
   * 不影响其它）。全部失败才抛错。返回成功图片与失败原因（供日志）。
   */
  async generate(
    prompt: string,
    size: string,
    variants: number,
    backendId?: string,
  ): Promise<{ images: GeneratedImage[]; failures: string[] }> {
    const backend =
      this.getSettings().backends.find((entry) => entry.id === backendId) ??
      this.selected();
    if (!backend)
      throw new Error("尚未配置生图服务，请在 Harness 设置-生图 中添加");
    const credential = await this.credentials.get(backend.credentialName);
    if (!credential)
      throw new Error(
        `缺少生图凭据 ${backend.credentialName}，请在设置中保存 API Key`,
      );
    const count = Math.min(6, Math.max(1, Math.floor(variants) || 1));
    const images: GeneratedImage[] = [];
    const failures: string[] = [];
    for (let i = 0; i < count; i += 1) {
      try {
        images.push(await this.generateOne(backend, credential, prompt, size));
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : String(cause));
      }
    }
    if (images.length === 0)
      throw new Error(failures[0] ?? "生图失败");
    return { images, failures };
  }

  /** 当前图片存盘目录（供日志与跨目录解析使用）。 */
  imagesDirectoryPath(): string {
    return this.imagesDirectory();
  }

  private async saveBuffer(
    buffer: Buffer,
    mimeType: string,
  ): Promise<GeneratedImage> {
    const imageId = createHash("sha256").update(buffer).digest("hex");
    const directory = this.imagesDirectory();
    await mkdir(directory, { recursive: true });
    const filePath = path.join(
      directory,
      `${imageId}.${imageExtension(mimeType)}`,
    );
    await writeFile(filePath, buffer, { flag: "wx" });
    return { imageId, mimeType, filePath };
  }
}

/** 应用内图片选择器：小窗展示 N 张缩略图，用户点选；关闭窗口 / 超时 /
 * 点「都不满意」= 放弃本次生成（返回 null），agent 应停下询问用户。 */
export async function pickGeneratedImage(
  images: GeneratedImage[],
  prompt: string,
  timeoutMs = 120_000,
): Promise<number | null> {
  const items = await Promise.all(
    images.map(async (image) => {
      const buffer = await readFile(image.filePath);
      const dataUrl =
        "data:" +
        image.mimeType +
        ";base64," +
        buffer.toString("base64");
      return { ...image, dataUrl };
    }),
  );
  return new Promise((resolve) => {
    const window = new BrowserWindow({
      width: Math.min(1180, items.length * 380 + 40),
      height: 520,
      title: "选择生成的图片",
      show: false,
      parent: BrowserWindow.getFocusedWindow() ?? undefined,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    let settled = false;
    const finish = (index: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!window.isDestroyed()) window.destroy();
      resolve(index);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    window.on("page-title-updated", (_event, title) => {
      if (title.startsWith("PICK:")) {
        const index = Number(title.slice(5));
        finish(
          Number.isInteger(index) && index >= 1 && index <= items.length
            ? index - 1
            : null,
        );
      } else if (title === "CANCEL") {
        finish(null);
      }
    });
    window.on("closed", () => finish(null));
    const confirmLabel = items.length === 1 ? "确认这张" : "选择方案 ";
    const cards = items
      .map(
        (item, index) =>
          '<figure><img src="' +
          item.dataUrl +
          '" alt="方案 ' +
          (index + 1) +
          '"><figcaption><button onclick="pick(' +
          (index + 1) +
          ')">' +
          (items.length === 1 ? confirmLabel : confirmLabel + (index + 1)) +
          "</button></figcaption></figure>",
      )
      .join("");
    const html =
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>" +
      "body{font-family:system-ui,'PingFang SC','Microsoft YaHei',sans-serif;margin:0;padding:18px 20px;background:#f6f7f9;color:#111827}" +
      "h1{font-size:15px;margin:0 0 4px}.desc{font-size:12px;color:#6b7280;margin:0 0 14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".grid{display:flex;gap:14px;align-items:stretch}.grid figure{margin:0;flex:1;min-width:0;display:flex;flex-direction:column;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.05)}" +
      ".grid img{width:100%;height:300px;object-fit:contain;display:block;background:#f3f4f6}" +
      ".grid figcaption{padding:10px}.grid button{width:100%;height:34px;border:0;border-radius:8px;background:#111827;color:#fff;font-size:12px;font-weight:600;cursor:pointer}.grid button:hover{background:#1f2937}" +
      ".hint{font-size:11px;color:#9ca3af;margin:0}.foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}.foot .cancel{height:30px;padding:0 14px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;color:#6b7280;font-size:11px;cursor:pointer}.foot .cancel:hover{background:#f3f4f6;color:#111827}</style></head><body>" +
      "<h1>选择生成的图片</h1><p class=\"desc\">" +
      prompt.replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch] ?? ch) +
      "</p><div class=\"grid\">" +
      cards +
      '</div><div class="foot"><p class="hint">关闭窗口或 120 秒内未选择，视为放弃本次生成</p>' +
      '<button class="cancel" onclick="document.title=\'CANCEL\'">都不满意，取消</button></div>' +
      '<script>function pick(i){document.title="PICK:"+i;}</script></body></html>';
    void window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    window.once("ready-to-show", () => window.show());
  });
}

/** 离屏渲染 HTML → PNG data URL（design_review 的本地预览能力，零网络依赖）。 */
export async function renderHtmlToDataUrl(
  html: string,
  width = 1280,
  height = 800,
): Promise<string> {
  if (typeof html !== "string" || !html.trim())
    throw new Error("HTML 内容为空");
  if (html.length > 300_000) throw new Error("HTML 内容超过 300 KB 限制");
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await window.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(html),
    );
    // 等首帧与脚本微任务稳定（固定延迟 + 双 rAF 兜底）
    await new Promise((resolve) => setTimeout(resolve, 500));
    await new Promise((resolve) =>
      window.webContents.executeJavaScript(
        "requestAnimationFrame(() => requestAnimationFrame(() => true))",
      ).then(resolve, resolve),
    );
    const image = await window.webContents.capturePage();
    return image.toDataURL();
  } finally {
    window.destroy();
  }
}
