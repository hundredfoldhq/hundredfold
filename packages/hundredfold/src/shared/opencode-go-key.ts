import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { HundredfoldConfig } from "./config-types.js";
import { opencodeAccountKeyEnvironment } from "./child-env.js";
import { declaredOpencodeAccounts, opencodeAccountByProvider } from "./opencode-accounts-config.js";
import { opencodeDatabasePath } from "./opencode-subscription.js";
import { OPENCODE_GO_PROVIDER } from "./opencode-go-usage.js";

/**
 * Which providers the OpenCode Go usage endpoint can speak for, and the key that asks it.
 *
 * An alias account (`base: opencode-go`) signs in with the key its variable holds, which the gateway took
 * from its environment (child-env.ts). The built-in provider signs in with what opencode stored: its
 * database's `credential` table on 2.x, `auth.json` on 1.x. The secret is returned to the one caller that
 * puts it in a request header, and goes nowhere else.
 */

/** Whether `provider` is OpenCode Go itself or an account cloning it. */
export function isGoProvider(config: Pick<HundredfoldConfig, "engines">, provider: string): boolean {
  if (provider === OPENCODE_GO_PROVIDER) return true;
  return opencodeAccountByProvider(config, provider)?.base === OPENCODE_GO_PROVIDER;
}

/** Every declared account's provider the usage endpoint covers. */
export function declaredGoProviders(config: Pick<HundredfoldConfig, "engines">): string[] {
  return declaredOpencodeAccounts(config).map((account) => account.provider).filter((provider) => isGoProvider(config, provider));
}

function keyOfCredential(value: unknown): string | undefined {
  const key = typeof value === "object" && value !== null ? (value as { key?: unknown }).key : undefined;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
}

function parsedJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** opencode 2.x: the provider's stored credential, the active one first. */
function keyFromDatabase(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  const file = opencodeDatabasePath(env);
  if (!fs.existsSync(file)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
    const rows = db
      .prepare("SELECT value FROM credential WHERE integration_id = ? ORDER BY COALESCE(active, 0) DESC, time_updated DESC")
      .all(provider) as { value: string }[];
    for (const row of rows) {
      const key = keyOfCredential(parsedJson(row.value));
      if (key !== undefined) return key;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

/** opencode 1.x: `auth.json` beside the database, `{ "<provider>": { "type": "api", "key": "..." } }`. */
function keyFromAuthFile(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const parsed = parsedJson(fs.readFileSync(path.join(path.dirname(opencodeDatabasePath(env)), "auth.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? keyOfCredential((parsed as Record<string, unknown>)[provider]) : undefined;
  } catch {
    return undefined;
  }
}

export interface GoKeyDeps {
  /** The gateway's environment, account keys included; default: the one it holds them in. */
  env?: Record<string, string | undefined>;
  /** The environment that locates opencode's data directory. */
  processEnv?: NodeJS.ProcessEnv;
}

/** The credential store lookup, with the process environment as a parameter default so the one place it is read is named. */
function storedKey(provider: string, processEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  return keyFromDatabase(provider, processEnv) ?? keyFromAuthFile(provider, processEnv);
}

/** The key that signs `provider` in to OpenCode Go, or undefined when none can be found. */
export function goKeyFor(config: Pick<HundredfoldConfig, "engines">, provider: string, deps: GoKeyDeps = {}): string | undefined {
  const account = opencodeAccountByProvider(config, provider);
  if (account?.base !== undefined) {
    const key = account.keyEnv === undefined ? undefined : (deps.env ?? opencodeAccountKeyEnvironment())[account.keyEnv]?.trim();
    return key ? key : undefined;
  }
  return storedKey(provider, deps.processEnv);
}
