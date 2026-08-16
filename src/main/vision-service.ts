import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { CredentialStore } from "./credential-store.js";
import type { SettingsStore } from "./settings-store.js";
import type {
  VisionBackendConfig,
  VisionRequest,
  VisionResult,
  VisionSettings,
  VisionToolDescriptor,
} from "../shared/contracts.js";

const credentialName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
const baseBackend = {
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  model: z.string().max(200),
  timeoutMs: z.number().int().min(1_000).max(300_000),
};
const directSchema = z.object({
  ...baseBackend,
  kind: z.literal("direct"),
  baseUrl: z.string().url(),
  credentialName,
});
const mcpSchema = z.object({
  ...baseBackend,
  kind: z.literal("mcp"),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(1_000)).max(100),
  cwd: z.string().max(1_000),
  toolName: z.string().max(240),
  imageArgument: z.string().min(1).max(120),
  questionArgument: z.string().max(120),
});
export const visionBackendSchema = z.discriminatedUnion("kind", [
  directSchema,
  mcpSchema,
]);
export const visionSettingsSchema = z.object({
  policy: z.enum(["auto", "always", "off"]),
  defaultBackendId: z.string().nullable(),
  remoteDisclosureAccepted: z.boolean(),
  imageDirectory: z.string().max(2000).optional().nullable(),
  backends: z.array(visionBackendSchema).max(32),
});
const requestSchema = z
  .object({
    requestId: z.string().min(1).max(120),
    sessionId: z.string().max(240).optional(),
    backendId: z.string().max(80).optional(),
    question: z.string().max(20_000),
    imageDataUrl: z.string().max(30_000_000).optional(),
    imagePath: z.string().max(2_000).optional(),
    mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i),
    force: z.boolean().optional(),
  })
  .refine(
    (value) => Boolean(value.imageDataUrl) !== Boolean(value.imagePath),
    "必须且只能提供一种图片来源",
  );

export const DEFAULT_VISION_SETTINGS: VisionSettings = {
  policy: "auto",
  defaultBackendId: null,
  remoteDisclosureAccepted: false,
  imageDirectory: null,
  backends: [],
};
interface CacheFile {
  entries: Record<string, VisionResult>;
}

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
// baseUrl 是完整 API 根（如 dashscope .../compatible-mode/v1、智谱 .../paas/v4、
// Ollama http://127.0.0.1:11434/v1），只做去尾斜杠后拼接路径，不再自动补 /v1
// （那会让智谱 v4 等路径变成 .../v4/v1/... 导致 404）。
function endpoint(baseUrl: string, suffix: string): string {
  return baseUrl.endsWith(suffix)
    ? baseUrl
    : `${baseUrl.replace(/\/$/, "")}${suffix}`;
}

export class VisionService {
  private readonly cachePath: string;

  constructor(
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialStore,
    userDataPath: string,
  ) {
    this.cachePath = path.join(userDataPath, "vision-cache.json");
  }

  getSettings(): VisionSettings {
    return structuredClone(
      this.settings.get().vision ?? DEFAULT_VISION_SETTINGS,
    );
  }

  async setSettings(value: VisionSettings): Promise<VisionSettings> {
    const parsed = visionSettingsSchema.parse(value) as VisionSettings;
    const ids = new Set<string>();
    for (const backend of parsed.backends) {
      if (ids.has(backend.id)) throw new Error("视觉服务 ID 不能重复");
      ids.add(backend.id);
    }
    if (parsed.defaultBackendId && !ids.has(parsed.defaultBackendId))
      throw new Error("默认视觉服务不存在");
    await this.settings.patch({ vision: parsed });
    return this.getSettings();
  }

  private async directHeaders(
    backend: Extract<VisionBackendConfig, { kind: "direct" }>,
  ): Promise<Record<string, string>> {
    const token = await this.credentials.get(backend.credentialName);
    if (!token) throw new Error(`凭据 ${backend.credentialName} 尚未配置`);
    return {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
  }

  private async createMcp(
    backend: Extract<VisionBackendConfig, { kind: "mcp" }>,
  ) {
    const client = new Client({
      name: "deepseek-harness-desktop-vision",
      version: "0.1.0",
    });
    const inheritedNames =
      process.platform === "win32"
        ? [
            "PATH",
            "Path",
            "PATHEXT",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "ComSpec",
          ]
        : ["PATH", "HOME", "SHELL", "TMPDIR", "LANG"];
    const env = Object.fromEntries(
      inheritedNames.flatMap((name) =>
        process.env[name] ? [[name, process.env[name]!]] : [],
      ),
    );
    const transport = new StdioClientTransport({
      command: backend.command,
      args: backend.args,
      cwd: backend.cwd || undefined,
      env,
    });
    await client.connect(transport);
    return client;
  }

  private async discoverTools(
    backend: Extract<VisionBackendConfig, { kind: "mcp" }>,
  ): Promise<VisionToolDescriptor[]> {
    const client = await this.createMcp(backend);
    try {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
    } finally {
      await client.close();
    }
  }

  async testBackend(
    value: VisionBackendConfig,
  ): Promise<{ ok: true; tools?: VisionToolDescriptor[] }> {
    const backend = visionBackendSchema.parse(value) as VisionBackendConfig;
    if (backend.kind === "mcp")
      return { ok: true, tools: await this.discoverTools(backend) };
    const response = await fetch(endpoint(backend.baseUrl, "/models"), {
      headers: await this.directHeaders(backend),
      signal: AbortSignal.timeout(backend.timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `视觉 API 连接失败（HTTP ${response.status}）${detail ? "：" + detail.slice(0, 300) : ""}`,
      );
    }
    return { ok: true };
  }

  private async image(
    request: VisionRequest,
  ): Promise<{ buffer: Buffer; dataUrl: string; localPath?: string }> {
    if (request.imageDataUrl) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(
        request.imageDataUrl,
      );
      if (!match || match[1] !== request.mimeType)
        throw new Error("图片 Data URL 或 MIME 类型无效");
      const buffer = Buffer.from(match[2]!, "base64");
      if (!buffer.length || buffer.length > 20 * 1024 * 1024)
        throw new Error("图片大小必须在 20 MB 以内");
      return { buffer, dataUrl: request.imageDataUrl };
    }
    if (request.imagePath) {
      const resolved = path.resolve(request.imagePath);
      const buffer = await readFile(resolved);
      if (!buffer.length || buffer.length > 20 * 1024 * 1024)
        throw new Error("图片大小必须在 20 MB 以内");
      return {
        buffer,
        dataUrl: `data:${request.mimeType};base64,${buffer.toString("base64")}`,
        localPath: resolved,
      };
    }
    throw new Error("必须提供图片");
  }

  private key(
    backend: VisionBackendConfig,
    imageHash: string,
    question: string,
  ): string {
    return sha(
      JSON.stringify([
        imageHash,
        backend.id,
        backend.model,
        "vision-prompt-v1",
        sha(question.trim()),
      ]),
    );
  }
  private async cache(): Promise<CacheFile> {
    try {
      return JSON.parse(await readFile(this.cachePath, "utf8")) as CacheFile;
    } catch {
      return { entries: {} };
    }
  }
  private async writeCache(value: CacheFile): Promise<void> {
    const ordered = Object.entries(value.entries)
      .sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt))
      .slice(0, 200);
    await mkdir(path.dirname(this.cachePath), { recursive: true });
    await writeFile(
      this.cachePath,
      `${JSON.stringify({ entries: Object.fromEntries(ordered) }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private selected(request: VisionRequest): VisionBackendConfig {
    const settings = this.getSettings();
    const id = request.backendId ?? settings.defaultBackendId;
    const backend = settings.backends.find(
      (entry) => entry.id === id && entry.enabled,
    );
    if (!backend) throw new Error("请选择一个已启用的视觉服务");
    if (backend.kind === "direct" && !settings.remoteDisclosureAccepted)
      throw new Error(
        "首次向远程视觉服务发送图片前，请在设置中确认数据外发提示",
      );
    return backend;
  }

  async analyze(requestValue: VisionRequest): Promise<VisionResult> {
    const request = requestSchema.parse(requestValue) as VisionRequest;
    const backend = this.selected(request);
    const image = await this.image(request);
    const imageHash = sha(image.buffer);
    const cacheKey = this.key(backend, imageHash, request.question);
    if (!request.force) {
      const hit = (await this.cache()).entries[cacheKey];
      if (hit) return { ...hit, requestId: request.requestId, cached: true };
    }
    const controller = new AbortController();
    const startedAt = Date.now();
    const output =
      backend.kind === "direct"
        ? await this.analyzeDirect(
            backend,
            request,
            image.dataUrl,
            controller.signal,
          )
        : await this.analyzeMcp(backend, request, image, controller.signal);
    if (!output.text.trim())
      throw new Error("视觉服务没有返回可供纯文本模型使用的文字");
    const result: VisionResult = {
      requestId: request.requestId,
      backendId: backend.id,
      backendName: backend.name,
      model: backend.model,
      text: output.text.trim(),
      imageHash,
      cached: false,
      durationMs: Date.now() - startedAt,
      createdAt: new Date().toISOString(),
      usage: output.usage,
    };
    const cache = await this.cache();
    cache.entries[cacheKey] = result;
    await this.writeCache(cache);
    return result;
  }

  private async analyzeDirect(
    backend: Extract<VisionBackendConfig, { kind: "direct" }>,
    request: VisionRequest,
    dataUrl: string,
    signal: AbortSignal,
  ): Promise<{ text: string; usage: VisionResult["usage"] }> {
    const timeout = AbortSignal.timeout(backend.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const response = await fetch(
      endpoint(backend.baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: await this.directHeaders(backend),
        signal: combined,
        body: JSON.stringify({
          model: backend.model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    request.question ||
                    "请详细描述这张图片，并提取其中的文字与结构。",
                },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `视觉 API 请求失败（HTTP ${response.status}）${detail ? "：" + detail.slice(0, 300) : ""}`,
      );
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((entry) =>
                entry && typeof entry === "object" && "text" in entry
                  ? String((entry as { text: unknown }).text)
                  : "",
              )
              .filter(Boolean)
              .join("\n")
          : "";
    return {
      text,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? null,
        outputTokens: body.usage?.completion_tokens ?? null,
      },
    };
  }

  private async analyzeMcp(
    backend: Extract<VisionBackendConfig, { kind: "mcp" }>,
    request: VisionRequest,
    image: { buffer: Buffer; dataUrl: string; localPath?: string },
    signal: AbortSignal,
  ): Promise<{ text: string; usage: VisionResult["usage"] }> {
    if (!backend.toolName) throw new Error("尚未选择 MCP 视觉工具");
    if (!image.localPath)
      throw new Error("本地 MCP 视觉服务需要本机图片文件路径");
    const args: Record<string, unknown> = {
      [backend.imageArgument]: image.localPath,
    };
    if (backend.questionArgument)
      args[backend.questionArgument] =
        request.question || "请详细描述图片";
    const client = await this.createMcp(backend);
    try {
      const result = await client.callTool(
        { name: backend.toolName, arguments: args },
        undefined,
        { signal, timeout: backend.timeoutMs },
      );
      if (result.isError) throw new Error("MCP 视觉工具返回了错误结果");
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter(
          (entry): entry is { type: "text"; text: string } =>
            entry?.type === "text" && typeof entry.text === "string",
        )
        .map((entry) => entry.text)
        .join("\n");
      if (!text && content.some((entry) => entry?.type === "image"))
        throw new Error("MCP 工具只返回了图片；纯文本主模型需要文字描述结果");
      return { text, usage: { inputTokens: null, outputTokens: null } };
    } finally {
      await client.close();
    }
  }
}
