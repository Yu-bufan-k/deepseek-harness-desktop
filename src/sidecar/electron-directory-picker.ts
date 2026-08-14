import { DirectoryPicker } from "@deepseek-ai/dsh-host-directory-picker";

interface BridgeResponse {
  path?: unknown;
  error?: unknown;
}

function bridgeConfiguration(): { port: number; token: string } {
  const port = Number(process.env.DSH_DESKTOP_BRIDGE_PORT);
  const token = process.env.DSH_DESKTOP_BRIDGE_TOKEN ?? "";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || token.length < 32) {
    throw new Error("desktop directory picker bridge is not configured");
  }
  return { port, token };
}

export async function pickDirectoryThroughElectron(signal: AbortSignal): Promise<string | null> {
  const { port, token } = bridgeConfiguration();
  const response = await fetch(`http://127.0.0.1:${port}/pick-directory`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal
  });
  const body = await response.json() as BridgeResponse;
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `desktop directory picker failed (${response.status})`);
  }
  if (body.path === null) return null;
  if (typeof body.path !== "string" || body.path.length === 0) {
    throw new Error("desktop directory picker returned an invalid path");
  }
  return body.path;
}

export default class ElectronDirectoryPicker extends DirectoryPicker {
  private readonly nativeCapability = {
    kind: "native" as const,
    pick: (signal: AbortSignal) => pickDirectoryThroughElectron(signal)
  };

  capability(): typeof this.nativeCapability {
    return this.nativeCapability;
  }
}
