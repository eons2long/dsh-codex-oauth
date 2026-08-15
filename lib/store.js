import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const PI_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

async function ownerOnly(filename) {
  if (process.platform === "win32") return;
  try {
    if ((await stat(filename)).mode & 0o077) throw new Error(`${filename} must be owner-only (chmod 600)`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export class PiCodexCredentialStore {
  constructor(filename = PI_AUTH_FILE) { this.filename = filename; }

  async readAll() {
    await ownerOnly(this.filename);
    try { return JSON.parse(await readFile(this.filename, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
  }

  async read(providerId) {
    if (providerId !== OPENAI_CODEX_PROVIDER) return undefined;
    const value = (await this.readAll())[providerId];
    return value?.type === "oauth" ? clone(value) : undefined;
  }

  async list() {
    return (await this.read(OPENAI_CODEX_PROVIDER) === undefined)
      ? [] : [{ providerId: OPENAI_CODEX_PROVIDER, type: "oauth" }];
  }

  async modify(providerId, fn) {
    if (providerId !== OPENAI_CODEX_PROVIDER) throw new Error(`credential store does not own ${providerId}`);
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
    return withFileLock(this.filename, async () => {
      const auth = await this.readAll();
      const current = auth[providerId];
      const next = await fn(clone(current));
      if (next === undefined) return clone(current);
      auth[providerId] = next;
      await writeFileAtomic(this.filename, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
      return clone(next);
    });
  }

  async delete(providerId) {
    if (providerId !== OPENAI_CODEX_PROVIDER) return;
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
    await withFileLock(this.filename, async () => {
      const auth = await this.readAll();
      delete auth[providerId];
      await writeFileAtomic(this.filename, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
    });
  }
}
