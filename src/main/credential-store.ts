import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";

type CredentialFile = Record<string, string>;

export class CredentialStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "credentials.enc.json");
  }

  private validateName(name: string): void {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) {
      throw new Error("Credential name must be an uppercase environment variable name");
    }
  }

  private async read(): Promise<CredentialFile> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as CredentialFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async write(value: CredentialFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  async set(name: string, value: string): Promise<void> {
    this.validateName(name);
    if (!safeStorage.isEncryptionAvailable()) throw new Error("System credential encryption is unavailable");
    const credentials = await this.read();
    credentials[name] = safeStorage.encryptString(value).toString("base64");
    await this.write(credentials);
  }

  async has(name: string): Promise<boolean> {
    this.validateName(name);
    return Boolean((await this.read())[name]);
  }

  async remove(name: string): Promise<void> {
    this.validateName(name);
    const credentials = await this.read();
    delete credentials[name];
    await this.write(credentials);
  }

  async environment(): Promise<Record<string, string>> {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const result: Record<string, string> = {};
    for (const [name, encoded] of Object.entries(await this.read())) {
      try {
        result[name] = safeStorage.decryptString(Buffer.from(encoded, "base64"));
      } catch {
        // Ignore entries that cannot be decrypted for the current OS user.
      }
    }
    return result;
  }
}
