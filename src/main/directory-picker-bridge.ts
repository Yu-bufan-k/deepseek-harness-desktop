import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  GeneratedImageSelection,
  VisionAnalyzeRequest,
  VisionAnalyzeResult,
} from "../shared/contracts.js";

export interface DirectoryPickerBridgeInfo {
  port: number;
  token: string;
}

export type PickDirectory = () => Promise<string | null>;

export interface VisionBridgeConfig {
  policy: "auto" | "always" | "off";
  hasBackends: boolean;
  defaultBackendId: string | null;
}

export interface VisionBridgeHandlers {
  getConfig(): Promise<VisionBridgeConfig>;
  analyze(request: VisionAnalyzeRequest): Promise<VisionAnalyzeResult>;
}

export interface DesignBridgeHandlers {
  /** 生图：生成 variants 个方案并弹选择器，返回全部方案与选中的一张。 */
  generateImage(request: {
    prompt: string;
    size?: string;
    variants?: number;
    backendId?: string;
  }): Promise<GeneratedImageSelection>;
  /** 设计评审：离屏渲染 HTML → 截图 → 视觉模型解析。 */
  reviewDesign(request: { html: string; question?: string }): Promise<{
    text: string;
  }>;
}

function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error("请求体过大"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

export class DirectoryPickerBridge {
  private server: Server | null = null;
  private info: DirectoryPickerBridgeInfo | null = null;

  constructor(
    private readonly pickDirectory: PickDirectory,
    private readonly vision: VisionBridgeHandlers | null = null,
    private readonly design: DesignBridgeHandlers | null = null,
  ) {}

  async start(): Promise<DirectoryPickerBridgeInfo> {
    if (this.info) return { ...this.info };
    const token = randomBytes(32).toString("hex");
    const server = createServer((request, response) => {
      void this.route(request, response, token);
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    this.server = server;
    this.info = { port: address.port, token };
    return { ...this.info };
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
  ): Promise<void> {
    response.setHeader("content-type", "application/json; charset=utf-8");
    const url = request.url ?? "";
    const granted = authorized(request.headers.authorization, token);
    try {
      if (url === "/pick-directory" && request.method === "POST") {
        if (!granted) return send(response, 401, { error: "unauthorized" });
        return send(response, 200, { path: await this.pickDirectory() });
      }
      if (url === "/vision/config" && request.method === "GET") {
        if (!granted) return send(response, 401, { error: "unauthorized" });
        if (!this.vision) return send(response, 404, { error: "not found" });
        return send(response, 200, await this.vision.getConfig());
      }
      if (url === "/vision/analyze" && request.method === "POST") {
        if (!granted) return send(response, 401, { error: "unauthorized" });
        if (!this.vision) return send(response, 404, { error: "not found" });
        const parsed = (await readJsonBody(request)) as Record<string, unknown>;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          typeof parsed.imageId !== "string" ||
          typeof parsed.question !== "string" ||
          parsed.imageId.length === 0 ||
          parsed.imageId.length > 128
        )
          return send(response, 400, { error: "invalid vision analyze request" });
        const analyzeRequest: VisionAnalyzeRequest = {
          imageId: parsed.imageId,
          question: parsed.question,
          ...(typeof parsed.backendId === "string" &&
          parsed.backendId.length > 0
            ? { backendId: parsed.backendId }
            : {}),
        };
        return send(response, 200, await this.vision.analyze(analyzeRequest));
      }
      if (url === "/image/generate" && request.method === "POST") {
        if (!granted) return send(response, 401, { error: "unauthorized" });
        if (!this.design) return send(response, 404, { error: "not found" });
        const parsed = (await readJsonBody(request)) as Record<string, unknown>;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          typeof parsed.prompt !== "string" ||
          parsed.prompt.length === 0 ||
          parsed.prompt.length > 4_000
        )
          return send(response, 400, { error: "invalid image generate request" });
        return send(response, 200, await this.design.generateImage({
          prompt: parsed.prompt,
          ...(typeof parsed.size === "string" && /^\d{3,4}x\d{3,4}$/.test(parsed.size)
            ? { size: parsed.size }
            : {}),
          ...(typeof parsed.variants === "number" &&
          parsed.variants >= 1 &&
          parsed.variants <= 6
            ? { variants: parsed.variants }
            : {}),
          ...(typeof parsed.backendId === "string" && parsed.backendId.length > 0
            ? { backendId: parsed.backendId }
            : {}),
        }));
      }
      if (url === "/design/review" && request.method === "POST") {
        if (!granted) return send(response, 401, { error: "unauthorized" });
        if (!this.design) return send(response, 404, { error: "not found" });
        const parsed = (await readJsonBody(request)) as Record<string, unknown>;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          typeof parsed.html !== "string" ||
          parsed.html.length === 0 ||
          parsed.html.length > 300_000
        )
          return send(response, 400, { error: "invalid design review request" });
        return send(response, 200, await this.design.reviewDesign({
          html: parsed.html,
          ...(typeof parsed.question === "string" && parsed.question.length > 0
            ? { question: parsed.question }
            : {}),
        }));
      }
      return send(response, 404, { error: "not found" });
    } catch (error) {
      return send(response, 500, {
        error: error instanceof Error ? error.message : "desktop bridge failed",
      });
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.info = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
