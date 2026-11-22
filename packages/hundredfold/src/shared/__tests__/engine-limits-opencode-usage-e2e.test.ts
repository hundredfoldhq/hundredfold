/**
 * end to end: OpenCode Go's own usage reading reaches the limits response per engine and per account, a window
 * the provider says is spent holds the provider out until its reset, and an unreadable reading says why
 * instead of passing for zero.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HundredfoldConfig, ProviderUsage } from "../types.js";
import type { OpencodeAccountLimitSnapshot } from "../engine-limits-opencode-accounts.js";

const NODE = process.execPath;
const NOW = Date.now();
const HOUR = 3_600_000;

let home: string;
let collect: typeof import("../engine-limits.js").collectEngineLimits;
let parseGoUsage: typeof import("../opencode-go-usage.js").parseGoUsage;
let unavailableUsage: typeof import("../opencode-go-usage.js").unavailableUsage;

function cfg(opencode: Record<string, unknown>): HundredfoldConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: NODE, model: "opus" }, opencode: { bin: NODE, model: "opencode-go/flash", ...opencode } },
    connectors: {},
  } as unknown as HundredfoldConfig;
}

function usage(weeklyPercent: number, limited: boolean): ProviderUsage {
  const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
  return {
    source: "OpenCode Go usage API", status: "ok", fetchedAt: new Date(NOW).toISOString(),
    windows: parseGoUsage({ usage: {
      rolling: { status: "ok", percent: 10, resetsAt: at(3) },
      weekly: { status: limited ? "rate-limited" : "ok", percent: weeklyPercent, resetsAt: at(72) },
      monthly: { status: "ok", percent: 35, resetsAt: at(300) },
    } })!,
  };
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-go-usage-e2e-"));
  process.env.HUNDREDFOLD_HOME = home;
  process.env.HUNDREDFOLD_CLAUDE_USAGE_API = "off";
  ({ collectEngineLimits: collect } = await import("../engine-limits.js"));
  ({ parseGoUsage, unavailableUsage } = await import("../opencode-go-usage.js"));
});
beforeEach(async () => {
  fs.rmSync(path.join(home, "tmp", "engine-health.json"), { force: true });
});
afterAll(() => {
  delete process.env.HUNDREDFOLD_HOME;
  delete process.env.HUNDREDFOLD_CLAUDE_USAGE_API;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("collectEngineLimits: opencode's provider-reported usage", () => {
  it("shows an unmetered engine's provider windows, with no allowance configured and nothing from the ledger", async () => {
    const out = await collect(cfg({}), { engine: "opencode", goUsage: async () => new Map([["opencode-go", usage(40, false)]]) });
    const engine = out.engines.opencode!;
    expect(engine.status).toBe("snapshot");
    expect(engine.unsupportedReason).toBeUndefined();
    expect(engine.providerUsage?.windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 10], ["7d", 40], ["30d", 35]]);
    const { readEngineHealth } = await import("../engine-health.js");
    expect(readEngineHealth()["opencode/opencode-go"]).toBeUndefined();
  });

  it("reads the provider of a Go model the registry alone names as the default, with no model pinned", async () => {
    const config = cfg({ model: undefined });
    (config as unknown as { models: unknown }).models = { opencode: { default: "opencode-go/flash", models: [{ id: "opencode-go/flash", label: "Flash" }] } };
    const asked: (string | undefined)[] = [];
    const out = await collect(config, {
      engine: "opencode",
      goUsage: async (_config, deps) => { asked.push(deps?.defaultModel); return new Map([["opencode-go", usage(40, false)]]); },
    });
    expect(asked).toEqual(["opencode-go/flash"]);
    expect(out.engines.opencode?.providerUsage).toMatchObject({ status: "ok" });
    expect(out.engines.opencode?.status).toBe("snapshot");
  });

  it("holds the provider out until the reset the provider reports for a spent window", async () => {
    await collect(cfg({}), { engine: "opencode", goUsage: async () => new Map([["opencode-go", usage(100, true)]]) });
    const { readEngineHealth, isEngineExhausted } = await import("../engine-health.js");
    const record = readEngineHealth()["opencode/opencode-go"];
    expect(record).toMatchObject({ state: "exhausted", window: "7d" });
    expect(Date.parse(record!.until!)).toBeGreaterThan(NOW + 71 * HOUR);
    expect(isEngineExhausted(readEngineHealth(), "opencode/opencode-go")).toBe(true);
  });

  it("carries each declared account's own reading on its card", async () => {
    const out = await collect(
      cfg({ accounts: { main: { provider: "opencode-go" }, second: { provider: "go-second", base: "opencode-go", keyEnv: "GO_SECOND_KEY" } } }),
      { goUsage: async () => new Map([["opencode-go", usage(20, false)], ["go-second", unavailableUsage("forbidden")]]) },
    );
    const cards = Object.fromEntries(((out.accounts?.opencode ?? []) as OpencodeAccountLimitSnapshot[]).map((a) => [a.provider, a]));
    expect(cards["opencode-go"]).toMatchObject({ status: "snapshot", providerUsage: { status: "ok" } });
    expect(cards["go-second"]).toMatchObject({ providerUsage: { status: "unavailable", unavailable: { code: "forbidden" } } });
    expect(JSON.stringify(out)).not.toContain("GO_SECOND_KEY=");
  });

  it("does not ask the provider when opencode is not among the engines read", async () => {
    let asked = false;
    await collect(cfg({}), { engine: "codex", goUsage: async () => { asked = true; return new Map(); } });
    expect(asked).toBe(false);
  });
});
