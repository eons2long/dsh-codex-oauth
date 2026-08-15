import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENAI_CODEX_AUTH_FILE = ".openai-codex-auth.json";
export function authPath(home = process.env.DSH_HOME || join(homedir(), ".dsh")) {
  return resolve(join(home, OPENAI_CODEX_AUTH_FILE));
}

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
async function privateDirectory(filename) {
  const directory = dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error(`${directory} must not be a symbolic link`);
  if (info.mode & 0o077) await chmod(directory, 0o700);
}
async function ownerOnly(filename) {
  if (process.platform === "win32") return;
  for (const [path, label] of [[dirname(filename), "directory"], [filename, "file"]]) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || info.mode & 0o077) throw new Error(`${path} must be an owner-only ${label}`);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}
function parse(text, filename) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${filename} is not valid JSON`); }
  const credential = value?.credential;
  if (value?.version !== 1 || !credential || credential.type !== "oauth") throw new Error(`${filename} has an invalid auth format`);
  for (const key of ["access", "refresh", "accountId"])
    if (typeof credential[key] !== "string" || credential[key].length === 0) throw new Error(`${filename} credential is invalid`);
  if (!Number.isFinite(credential.expires) || credential.expires <= 0) throw new Error(`${filename} expiry is invalid`);
  return clone(credential);
}

export class CodexCredentialStore {
  constructor(filename = authPath()) { this.filename = filename; }
  async readCurrent() {
    await privateDirectory(this.filename);
    await ownerOnly(this.filename);
    try { return parse(await readFile(this.filename, "utf8"), this.filename); }
    catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  }
  async read(providerId) { return providerId === OPENAI_CODEX_PROVIDER ? this.readCurrent() : undefined; }
  async list() { return (await this.readCurrent()) ? [{ providerId: OPENAI_CODEX_PROVIDER, type: "oauth" }] : []; }
  async modify(providerId, fn) {
    if (providerId !== OPENAI_CODEX_PROVIDER) throw new Error(`credential store does not own ${providerId}`);
    await privateDirectory(this.filename);
    return withFileLock(this.filename, async () => {
      const current = await this.readCurrent();
      const next = await fn(clone(current));
      if (next === undefined) return current;
      const document = { version: 1, credential: next };
      parse(JSON.stringify(document), this.filename);
      await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
      return clone(next);
    });
  }
  async delete(providerId) {
    if (providerId !== OPENAI_CODEX_PROVIDER) return;
    await privateDirectory(this.filename);
    await withFileLock(this.filename, async () => {
      await ownerOnly(this.filename);
      const { rm } = await import("node:fs/promises");
      await rm(this.filename, { force: true });
    });
  }
}
