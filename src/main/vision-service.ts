import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { CredentialStore } from "./credential-store.js";
import type { SettingsStore } from "./settings-store.js";
import type { DesktopAttachmentRecord, VisionBackendConfig, VisionRequest, VisionResult, VisionSettings, VisionToolDescriptor } from "../shared/contracts.js";

const credentialName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
const baseBackend = { id: z.string().min(1).max(80), name: z.string().min(1).max(120), enabled: z.boolean(), model: z.string().max(200), timeoutMs: z.number().int().min(1_000).max(300_000) };
const mappingSchema = z.object({
  imageArgument: z.string().min(1).max(120), imageEncoding: z.enum(["data-url", "base64", "path"]),
  questionArgument: z.string().max(120).nullable(), mimeTypeArgument: z.string().max(120).nullable(), resultTextPath: z.string().max(240).nullable()
});
const directSchema = z.object({ ...baseBackend, kind: z.literal("direct"), baseUrl: z.string().url(), credentialName, headers: z.record(z.string(), z.string()), headerCredentialNames: z.record(z.string(), credentialName) });
const mcpStdioSchema = z.object({ ...baseBackend, kind: z.literal("mcp"), transport: z.literal("stdio"), command: z.string().min(1).max(500), args: z.array(z.string().max(1_000)).max(100), cwd: z.string().max(1_000), env: z.record(z.string(), z.string()), envCredentialNames: z.record(z.string(), credentialName), allowLocalPath: z.boolean(), toolName: z.string().max(240), mapping: mappingSchema });
const mcpHttpSchema = z.object({ ...baseBackend, kind: z.literal("mcp"), transport: z.literal("streamable-http"), url: z.string().url(), headers: z.record(z.string(), z.string()), headerCredentialNames: z.record(z.string(), credentialName), toolName: z.string().max(240), mapping: mappingSchema });
export const visionBackendSchema = z.discriminatedUnion("kind", [directSchema, z.discriminatedUnion("transport", [mcpStdioSchema, mcpHttpSchema])]);
export const visionSettingsSchema = z.object({ policy: z.enum(["auto", "always", "off"]), defaultBackendId: z.string().nullable(), remoteDisclosureAccepted: z.boolean(), backends: z.array(visionBackendSchema).max(32) });
const requestSchema = z.object({ requestId: z.string().min(1).max(120), sessionId: z.string().max(240).optional(), backendId: z.string().max(80).optional(), question: z.string().max(20_000), imageDataUrl: z.string().max(30_000_000).optional(), imagePath: z.string().max(2_000).optional(), mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i), force: z.boolean().optional() }).refine((value) => Boolean(value.imageDataUrl) !== Boolean(value.imagePath), "必须且只能提供一种图片来源");

export const DEFAULT_VISION_SETTINGS: VisionSettings = { policy: "auto", defaultBackendId: null, remoteDisclosureAccepted: false, backends: [] };
interface CacheFile { entries: Record<string, VisionResult>; }

function sha(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function endpoint(baseUrl: string, suffix: string): string { return baseUrl.endsWith(suffix) ? baseUrl : `${baseUrl.replace(/\/$/, "")}${baseUrl.endsWith("/v1") ? "" : "/v1"}${suffix}`; }
function getPath(value: unknown, dottedPath: string | null): unknown {
  if (!dottedPath) return value;
  return dottedPath.split(".").filter(Boolean).reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}

export class VisionService {
  private readonly cachePath: string;
  private readonly attachmentsPath: string;
  private readonly attachmentImagesDirectory: string;
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly settings: SettingsStore, private readonly credentials: CredentialStore, userDataPath: string) {
    this.cachePath = path.join(userDataPath, "vision-cache.json");
    this.attachmentsPath = path.join(userDataPath, "vision-attachments.json");
    this.attachmentImagesDirectory = path.join(userDataPath, "vision-attachments", "images");
  }

  getSettings(): VisionSettings { return structuredClone(this.settings.get().vision ?? DEFAULT_VISION_SETTINGS); }

  async setSettings(value: VisionSettings): Promise<VisionSettings> {
    const parsed = visionSettingsSchema.parse(value) as VisionSettings;
    const ids = new Set<string>();
    for (const backend of parsed.backends) {
      if (ids.has(backend.id)) throw new Error("视觉服务 ID 不能重复");
      ids.add(backend.id);
      if (backend.kind === "mcp" && backend.transport === "streamable-http" && backend.mapping.imageEncoding === "path") throw new Error("远程 MCP 不能接收本机文件路径");
      if (backend.kind === "mcp" && backend.transport === "stdio" && backend.mapping.imageEncoding === "path" && !backend.allowLocalPath) throw new Error("本地路径传输尚未授权");
    }
    if (parsed.defaultBackendId && !ids.has(parsed.defaultBackendId)) throw new Error("默认视觉服务不存在");
    await this.settings.patch({ vision: parsed });
    return this.getSettings();
  }

  private async credentialMap(names: Record<string, string>): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [target, name] of Object.entries(names)) {
      const value = await this.credentials.get(name);
      if (!value) throw new Error(`凭据 ${name} 尚未配置`);
      result[target] = value;
    }
    return result;
  }

  private async headers(backend: Extract<VisionBackendConfig, { kind: "direct" }> | Extract<VisionBackendConfig, { transport: "streamable-http" }>): Promise<Record<string, string>> {
    return { ...backend.headers, ...await this.credentialMap(backend.headerCredentialNames) };
  }

  private async directHeaders(backend: Extract<VisionBackendConfig, { kind: "direct" }>): Promise<Record<string, string>> {
    const token = await this.credentials.get(backend.credentialName);
    if (!token) throw new Error(`凭据 ${backend.credentialName} 尚未配置`);
    return { "content-type": "application/json", authorization: `Bearer ${token}`, ...await this.headers(backend) };
  }

  private async createMcp(backend: Extract<VisionBackendConfig, { kind: "mcp" }>) {
    const client = new Client({ name: "deepseek-harness-desktop-vision", version: "0.1.0" });
    if (backend.transport === "stdio") {
      const inheritedNames = process.platform === "win32"
        ? ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ComSpec"]
        : ["PATH", "HOME", "SHELL", "TMPDIR", "LANG"];
      const inherited = Object.fromEntries(inheritedNames.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []));
      const env = { ...inherited, ...backend.env, ...await this.credentialMap(backend.envCredentialNames) };
      const transport = new StdioClientTransport({ command: backend.command, args: backend.args, cwd: backend.cwd || undefined, env });
      await client.connect(transport);
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(backend.url), { requestInit: { headers: await this.headers(backend) } });
      await client.connect(transport);
    }
    return client;
  }

  async discoverTools(value: VisionBackendConfig): Promise<VisionToolDescriptor[]> {
    const backend = visionBackendSchema.parse(value) as VisionBackendConfig;
    if (backend.kind !== "mcp") throw new Error("Direct API 不提供 MCP 工具列表");
    const client = await this.createMcp(backend);
    try {
      const result = await client.listTools();
      return result.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema as Record<string, unknown> }));
    } finally { await client.close(); }
  }

  async testBackend(value: VisionBackendConfig): Promise<{ ok: true; tools?: VisionToolDescriptor[] }> {
    const backend = visionBackendSchema.parse(value) as VisionBackendConfig;
    if (backend.kind === "mcp") return { ok: true, tools: await this.discoverTools(backend) };
    const response = await fetch(endpoint(backend.baseUrl, "/models"), { headers: await this.directHeaders(backend), signal: AbortSignal.timeout(backend.timeoutMs) });
    if (!response.ok) throw new Error(`视觉 API 连接失败（HTTP ${response.status}）`);
    return { ok: true };
  }

  private async image(request: VisionRequest, backend: VisionBackendConfig): Promise<{ buffer: Buffer; dataUrl: string; localPath?: string }> {
    if (request.imageDataUrl) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(request.imageDataUrl);
      if (!match || match[1] !== request.mimeType) throw new Error("图片 Data URL 或 MIME 类型无效");
      const buffer = Buffer.from(match[2]!, "base64");
      if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error("图片大小必须在 20 MB 以内");
      return { buffer, dataUrl: request.imageDataUrl };
    }
    if (!request.imagePath || backend.kind !== "mcp" || backend.transport !== "stdio" || !backend.allowLocalPath) throw new Error("当前视觉服务不允许读取本机路径");
    const buffer = await readFile(path.resolve(request.imagePath));
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error("图片大小必须在 20 MB 以内");
    return { buffer, dataUrl: `data:${request.mimeType};base64,${buffer.toString("base64")}`, localPath: path.resolve(request.imagePath) };
  }

  private key(backend: VisionBackendConfig, imageHash: string, question: string): string { return sha(JSON.stringify([imageHash, backend.id, backend.model, "vision-prompt-v1", sha(question.trim())])); }
  private async cache(): Promise<CacheFile> { try { return JSON.parse(await readFile(this.cachePath, "utf8")) as CacheFile; } catch { return { entries: {} }; } }
  private async writeCache(value: CacheFile): Promise<void> {
    const ordered = Object.entries(value.entries).sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt)).slice(0, 200);
    await mkdir(path.dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, `${JSON.stringify({ entries: Object.fromEntries(ordered) }, null, 2)}\n`, { mode: 0o600 });
  }

  async listAttachments(sessionId?: string): Promise<DesktopAttachmentRecord[]> {
    let records: DesktopAttachmentRecord[];
    try { records = JSON.parse(await readFile(this.attachmentsPath, "utf8")) as DesktopAttachmentRecord[]; } catch { return []; }
    return records.filter((entry) => !sessionId || entry.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async recordAttachment(record: DesktopAttachmentRecord): Promise<void> {
    const records = await this.listAttachments();
    const next = [record, ...records.filter((entry) => entry.id !== record.id)].slice(0, 500);
    await mkdir(path.dirname(this.attachmentsPath), { recursive: true });
    await writeFile(this.attachmentsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }

  private attachment(request: VisionRequest, imageHash: string, backendId: string | null, status: DesktopAttachmentRecord["status"], visionText: string | null, errorSummary: string | null): DesktopAttachmentRecord {
    return { id: request.requestId, sessionId: request.sessionId ?? null, requestId: request.requestId, mimeType: request.mimeType, imageHash, backendId, status, visionText, errorSummary, createdAt: new Date().toISOString() };
  }

  private selected(request: VisionRequest): VisionBackendConfig {
    const settings = this.getSettings();
    const id = request.backendId ?? settings.defaultBackendId;
    const backend = settings.backends.find((entry) => entry.id === id && entry.enabled);
    if (!backend) throw new Error("请选择一个已启用的视觉服务");
    if ((backend.kind === "direct" || backend.transport === "streamable-http") && !settings.remoteDisclosureAccepted) throw new Error("首次向远程视觉服务发送图片前，请在设置中确认数据外发提示");
    return backend;
  }

  async cached(requestValue: VisionRequest): Promise<VisionResult | null> {
    const request = requestSchema.parse(requestValue) as VisionRequest; const backend = this.selected(request); const image = await this.image(request, backend);
    const value = (await this.cache()).entries[this.key(backend, sha(image.buffer), request.question)];
    return value ? { ...value, cached: true, requestId: request.requestId } : null;
  }

  async analyze(requestValue: VisionRequest): Promise<VisionResult> {
    const request = requestSchema.parse(requestValue) as VisionRequest;
    const backend = this.selected(request); const image = await this.image(request, backend); const imageHash = sha(image.buffer); const cacheKey = this.key(backend, imageHash, request.question);
    await mkdir(this.attachmentImagesDirectory, { recursive: true });
    await writeFile(path.join(this.attachmentImagesDirectory, imageHash), image.buffer, { mode: 0o600 });
    if (!request.force) {
      const hit = (await this.cache()).entries[cacheKey];
      if (hit) { const cached = { ...hit, requestId: request.requestId, cached: true }; await this.recordAttachment(this.attachment(request, imageHash, backend.id, "ready", cached.text, null)); return cached; }
    }
    await this.recordAttachment(this.attachment(request, imageHash, backend.id, "analyzing", null, null));
    const controller = new AbortController(); this.active.set(request.requestId, controller); const startedAt = Date.now();
    try {
      const output = backend.kind === "direct" ? await this.analyzeDirect(backend, request, image.dataUrl, controller.signal) : await this.analyzeMcp(backend, request, image, controller.signal);
      if (!output.text.trim()) throw new Error("视觉服务没有返回可供纯文本模型使用的文字");
      const result: VisionResult = { requestId: request.requestId, backendId: backend.id, backendName: backend.name, model: backend.model, text: output.text.trim(), imageHash, cached: false, durationMs: Date.now() - startedAt, createdAt: new Date().toISOString(), usage: output.usage };
      const cache = await this.cache(); cache.entries[cacheKey] = result; await this.writeCache(cache);
      await this.recordAttachment(this.attachment(request, imageHash, backend.id, "ready", result.text, null)); return result;
    } catch (error) {
      await this.recordAttachment(this.attachment(request, imageHash, backend.id, "failed", null, error instanceof Error ? error.message : String(error)));
      throw error;
    } finally { this.active.delete(request.requestId); }
  }

  cancel(requestId: string): void { this.active.get(requestId)?.abort(); }

  private async analyzeDirect(backend: Extract<VisionBackendConfig, { kind: "direct" }>, request: VisionRequest, dataUrl: string, signal: AbortSignal): Promise<{ text: string; usage: VisionResult["usage"] }> {
    const timeout = AbortSignal.timeout(backend.timeoutMs); const combined = AbortSignal.any([signal, timeout]);
    const response = await fetch(endpoint(backend.baseUrl, "/chat/completions"), {
      method: "POST", headers: await this.directHeaders(backend), signal: combined,
      body: JSON.stringify({ model: backend.model, messages: [{ role: "user", content: [{ type: "text", text: request.question || "请详细描述这张图片，并提取其中的文字与结构。" }, { type: "image_url", image_url: { url: dataUrl } }] }] })
    });
    if (!response.ok) throw new Error(`视觉 API 请求失败（HTTP ${response.status}）`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = body.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((entry) => entry && typeof entry === "object" && "text" in entry ? String((entry as { text: unknown }).text) : "").filter(Boolean).join("\n") : "";
    return { text, usage: { inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null } };
  }

  private async analyzeMcp(backend: Extract<VisionBackendConfig, { kind: "mcp" }>, request: VisionRequest, image: { buffer: Buffer; dataUrl: string; localPath?: string }, signal: AbortSignal): Promise<{ text: string; usage: VisionResult["usage"] }> {
    if (!backend.toolName) throw new Error("尚未选择 MCP 视觉工具");
    const args: Record<string, unknown> = {};
    const mapping = backend.mapping;
    args[mapping.imageArgument] = mapping.imageEncoding === "data-url" ? image.dataUrl : mapping.imageEncoding === "base64" ? image.buffer.toString("base64") : image.localPath;
    if (mapping.imageEncoding === "path" && !image.localPath) throw new Error("此请求没有可授权给本地 MCP 的文件路径");
    if (mapping.questionArgument) args[mapping.questionArgument] = request.question || "请详细描述图片";
    if (mapping.mimeTypeArgument) args[mapping.mimeTypeArgument] = request.mimeType;
    const client = await this.createMcp(backend);
    try {
      const result = await client.callTool({ name: backend.toolName, arguments: args }, undefined, { signal, timeout: backend.timeoutMs });
      if (result.isError) throw new Error("MCP 视觉工具返回了错误结果");
      const extracted = getPath(result, mapping.resultTextPath);
      if (typeof extracted === "string") return { text: extracted, usage: { inputTokens: null, outputTokens: null } };
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.filter((entry): entry is { type: "text"; text: string } => entry?.type === "text" && typeof entry.text === "string").map((entry) => entry.text).join("\n");
      if (!text && content.some((entry) => entry?.type === "image")) throw new Error("MCP 工具只返回了图片；纯文本主模型需要文字描述结果");
      return { text, usage: { inputTokens: null, outputTokens: null } };
    } finally { await client.close(); }
  }
}

export function composeVisionPrompt(question: string, result: VisionResult): string {
  return `${question.trim()}\n\n<desktop_vision_context backend="${result.backendName}" model="${result.model}" image_sha256="${result.imageHash}">\n${result.text}\n</desktop_vision_context>`;
}
