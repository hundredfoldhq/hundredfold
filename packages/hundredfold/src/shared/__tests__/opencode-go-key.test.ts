import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HundredfoldConfig } from "../types.js";
import { declaredGoProviders, goKeyFor, isGoProvider } from "../opencode-go-key.js";

const config = (accounts: Record<string, unknown> = {}) =>
  ({ engines: { default: "claude", claude: {}, opencode: { accounts } } }) as unknown as HundredfoldConfig;

const ACCOUNTS = {
  main: { provider: "opencode-go" },
  second: { provider: "go-second", base: "opencode-go", keyEnv: "GO_SECOND_KEY" },
  router: { provider: "router-b", base: "openrouter", keyEnv: "ROUTER_B_KEY" },
};

let dataHome: string;
let processEnv: NodeJS.ProcessEnv;

function writeDatabase(rows: { id: string; provider: string; active: number | null; updated: number; value: string }[]): void {
  const dir = path.join(dataHome, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "opencode.db"));
  db.exec("CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)");
  const insert = db.prepare("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, 'l', ?, ?, 1, ?)");
  for (const row of rows) insert.run(row.id, row.provider, row.value, row.active, row.updated);
  db.close();
}

beforeEach(() => {
  dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "go-key-"));
  processEnv = { XDG_DATA_HOME: dataHome };
});
afterEach(() => fs.rmSync(dataHome, { recursive: true, force: true }));

describe("which providers the usage endpoint covers", () => {
  it("covers opencode-go and accounts cloning it, and no other provider", () => {
    const cfg = config(ACCOUNTS);
    expect(isGoProvider(cfg, "opencode-go")).toBe(true);
    expect(isGoProvider(cfg, "go-second")).toBe(true);
    expect(isGoProvider(cfg, "router-b")).toBe(false);
    expect(isGoProvider(cfg, "openrouter")).toBe(false);
    expect(declaredGoProviders(cfg)).toEqual(["opencode-go", "go-second"]);
  });
});

describe("goKeyFor", () => {
  it("gives an alias account the key its variable holds, and nothing when the variable is unset", () => {
    expect(goKeyFor(config(ACCOUNTS), "go-second", { env: { GO_SECOND_KEY: "  alias-key  " }, processEnv })).toBe("alias-key");
    expect(goKeyFor(config(ACCOUNTS), "go-second", { env: {}, processEnv })).toBeUndefined();
  });

  it("never falls back to opencode's stored credential for an alias account", () => {
    writeDatabase([{ id: "c1", provider: "go-second", active: 1, updated: 1, value: JSON.stringify({ type: "api", key: "stored" }) }]);
    expect(goKeyFor(config(ACCOUNTS), "go-second", { env: {}, processEnv })).toBeUndefined();
  });

  it("reads the built-in provider's active credential from opencode's database, newest first among equals", () => {
    writeDatabase([
      { id: "c1", provider: "opencode-go", active: 0, updated: 9, value: JSON.stringify({ type: "api", key: "inactive" }) },
      { id: "c2", provider: "opencode-go", active: 1, updated: 1, value: JSON.stringify({ type: "api", key: "active-old" }) },
      { id: "c3", provider: "opencode-go", active: 1, updated: 2, value: JSON.stringify({ type: "api", key: "active-new" }) },
      { id: "c4", provider: "openrouter", active: 1, updated: 3, value: JSON.stringify({ type: "api", key: "other" }) },
    ]);
    expect(goKeyFor(config(), "opencode-go", { processEnv })).toBe("active-new");
  });

  it("skips a credential that holds no key, then falls back to auth.json on 1.x", () => {
    writeDatabase([{ id: "c1", provider: "opencode-go", active: 1, updated: 1, value: JSON.stringify({ type: "oauth" }) }]);
    fs.writeFileSync(path.join(dataHome, "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "from-auth-file" } }));
    expect(goKeyFor(config(), "opencode-go", { processEnv })).toBe("from-auth-file");
  });

  it("reads auth.json alone when there is no database, and returns nothing when neither exists or parses", () => {
    expect(goKeyFor(config(), "opencode-go", { processEnv })).toBeUndefined();
    fs.mkdirSync(path.join(dataHome, "opencode"), { recursive: true });
    fs.writeFileSync(path.join(dataHome, "opencode", "auth.json"), "{not json");
    expect(goKeyFor(config(), "opencode-go", { processEnv })).toBeUndefined();
    fs.writeFileSync(path.join(dataHome, "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "k" } }));
    expect(goKeyFor(config(), "opencode-go", { processEnv })).toBe("k");
  });
});
