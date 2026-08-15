import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { findAvailablePort, waitForHttp } from "../src/main/port.js";

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
afterEach(() => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  return Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("loopback port helpers", () => {
  it("allocates an available TCP port", async () => {
    const port = await findAvailablePort();
    expect(port).toBeGreaterThan(0);
  });

  it("waits until an HTTP server responds", async () => {
    const port = await findAvailablePort();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.end(
        "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    await expect(
      waitForHttp(`http://127.0.0.1:${port}`, 1_000, 10),
    ).resolves.toBeUndefined();
  });
});
