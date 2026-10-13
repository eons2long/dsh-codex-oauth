import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENAI_CODEX_AUTH_FILE = ".openai-codex-auth.v2.json";
const CREDENTIAL_LOCK_WAIT_MS = 60_000;
export function authPath(home = process.env.DSH_HOME || join(homedir(), ".dsh")) {
  return resolve(join(home, OPENAI_CODEX_AUTH_FILE));
}

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
function nonempty(value) { return typeof value === "string" && value.length > 0; }
function validate(value, filename) {
  const invalid = () => { throw new Error(`${filename} has an invalid auth format`); };
  if (value?.version !== 2 || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.hostId) || !Array.isArray(value.registrations)
    || (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || value.generation < 0))) invalid();
  const ids = new Set();
  for (const registration of value.registrations) {
    if (!nonempty(registration.clientId) || registration.clientId === "dynamic_agent_client" || ids.has(registration.clientId)
      || !nonempty(registration.subject) || registration.issuer !== "https://auth.openai.com") invalid();
    ids.add(registration.clientId);
    if (registration.access !== undefined && (!nonempty(registration.access) || !nonempty(registration.idToken)
      || !Number.isFinite(registration.expires) || registration.expires <= 0 || !Array.isArray(registration.scopes)
      || registration.scopes.some((scope) => !nonempty(scope)))) invalid();
    if (registration.refresh !== undefined && !nonempty(registration.refresh)) invalid();
  }
  if (value.activeClientId !== undefined && !ids.has(value.activeClientId)) invalid();
  return value;
}

export function activeRegistration(document) {
  return document?.registrations.find((registration) => registration.clientId === document.activeClientId);
}
export function clearTokens(registration) {
  for (const key of ["access", "refresh", "idToken", "expires", "scopes", "earliestRefreshAt"]) delete registration[key];
}

export class CodexCredentialStore {
  #listeners = new Set();
  constructor(filename = authPath()) { this.filename = filename; }
  async readDocument() {
    await privateDirectory(this.filename);
    await ownerOnly(this.filename);
    try {
      const text = await readFile(this.filename, "utf8");
      let document;
      try { document = JSON.parse(text); } catch { throw new Error(`${this.filename} is not valid JSON`); }
      return validate(document, this.filename);
    } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  }
  async initialize() { return this.transaction((document) => structuredClone(document)); }
  async read(providerId) {
    if (providerId !== OPENAI_CODEX_PROVIDER) return undefined;
    const registration = activeRegistration(await this.readDocument());
    return registration?.access ? registration : undefined;
  }
  async list() { return await this.read(OPENAI_CODEX_PROVIDER) ? [{ providerId: OPENAI_CODEX_PROVIDER, type: "oauth" }] : []; }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async transaction(fn) {
    await privateDirectory(this.filename);
    return withFileLock(this.filename, async () => {
      const saved = await this.readDocument();
      const document = saved ?? { version: 2, hostId: `urn:uuid:${randomUUID()}`, registrations: [] };
      const before = JSON.stringify(document);
      const result = await fn(document);
      validate(document, this.filename);
      if (!saved || before !== JSON.stringify(document)) {
        await writeFileAtomic(this.filename, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
        const registration = activeRegistration(document);
        for (const listener of this.#listeners) {
          try { listener({ clientId: document.activeClientId, authenticated: !!registration?.access }); } catch { /* Observers cannot undo a saved credential. */ }
        }
      }
      return structuredClone(result);
    }, { waitMs: CREDENTIAL_LOCK_WAIT_MS });
  }
  async modify(providerId, fn) {
    if (providerId !== OPENAI_CODEX_PROVIDER) throw new Error(`credential store does not own ${providerId}`);
    return this.transaction(async (document) => {
      const current = activeRegistration(document);
      const next = await fn(current ? structuredClone(current) : undefined);
      if (next === undefined) return current;
      const existing = document.registrations.find((registration) => registration.clientId === next.clientId);
      if (existing && existing.subject !== next.subject) throw new Error("OAuth registration identity changed");
      if (existing) Object.assign(existing, next);
      else document.registrations.push(next);
      if (document.activeClientId !== next.clientId) document.generation = (document.generation ?? 0) + 1;
      document.activeClientId = next.clientId;
      return next;
    });
  }
  async select(clientId) {
    return this.transaction((document) => {
      if (!document.registrations.some((registration) => registration.clientId === clientId)) throw new Error("Unknown ChatGPT account registration");
      document.activeClientId = clientId;
      document.generation = (document.generation ?? 0) + 1;
    });
  }
  async delete(providerId) {
    if (providerId !== OPENAI_CODEX_PROVIDER) return;
    await this.transaction((document) => {
      const registration = activeRegistration(document);
      if (registration) clearTokens(registration);
      document.generation = (document.generation ?? 0) + 1;
    });
  }
}
