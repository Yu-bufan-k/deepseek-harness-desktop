import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface DirectoryPickerBridgeInfo {
  port: number;
  token: string;
}

export type PickDirectory = () => Promise<string | null>;

function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class DirectoryPickerBridge {
  private server: Server | null = null;
  private info: DirectoryPickerBridgeInfo | null = null;

  constructor(private readonly pickDirectory: PickDirectory) {}

  async start(): Promise<DirectoryPickerBridgeInfo> {
    if (this.info) return { ...this.info };
    const token = randomBytes(32).toString("hex");
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      if (request.method !== "POST" || request.url !== "/pick-directory") {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (!authorized(request.headers.authorization, token)) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      try {
        const selectedPath = await this.pickDirectory();
        response.statusCode = 200;
        response.end(JSON.stringify({ path: selectedPath }));
      } catch (error) {
        response.statusCode = 500;
        response.end(
          JSON.stringify({
            error:
              error instanceof Error
                ? error.message
                : "directory picker failed",
          }),
        );
      }
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

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.info = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
