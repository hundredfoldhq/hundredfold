import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(os.tmpdir(), "hundredfold-go-usage-limits-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  HUNDREDFOLD_HOME: path.join(os.tmpdir(), "hundredfold-go-usage-limits-test"),
}));

import type { Employee, EngineLimitEngineSnapshot, HundredfoldConfig, ProviderUsage } from "../types.js";
import { readEngineHealth } from "../engine-health.js";
import { recordMeteredExhaustion } from "../engine-health-meter.js";
import { collectOpencodeAccounts } from "../engine-limits-opencode-accounts.js";
import { collectGoUsage, goProvidersInUse, providerHealthBuckets, withEngineUsage } from "../engine-limits-opencode-usage.js";
import { forgetGoUsageCacheForTest, parseGoUsage, unavailableUsage } from "../opencode-go-usage.js";

const NOW = new Date("2026-11-22T12:00:00Z");
const HOUR = 3_600_000;

function cfg(opencode: Record<string, unknown> = {}): HundredfoldConfig {
  return { engines: { default: "claude", claude: {}, opencode: { bin: process.execPath, model: "opencode-go/flash", ...opencode } }, connectors: {} } as unknown as HundredfoldConfig;
}
const employee = (name: string, model: string, engine = "opencode") => ({ name, engine, model }) as unknown as Employee;

function reading(rolling: number, weekly: number, monthly: number, weeklyLimited = false): ProviderUsage {
  const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();
  return {
    source: "OpenCode Go usage API", status: "ok", fetchedAt: NOW.toISOString(),
    windows: parseGoUsage({ usage: {
      rolling: { status: rolling >= 100 ? "rate-limited" : "ok", percent: rolling, resetsAt: at(3) },
      weekly: { status: weeklyLimited || weekly >= 100 ? "rate-limited" : "ok", percent: weekly, resetsAt: at(48) },
      monthly: { status: "ok", percent: monthly, resetsAt: at(300) },
    } })!,
  };
}

const ACCOUNTS = {
  main: { provider: "opencode-go" },
  second: { provider: "go-second", base: "opencode-go", keyEnv: "GO_SECOND_KEY", usageLimits: { monthlyUsd: { "*": 60 } } },
};

beforeEach(() => { fs.mkdirSync(path.join(TEST_HOME, "tmp"), { recursive: true }); forgetGoUsageCacheForTest(); });
afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe("goProvidersInUse", () => {
  it("names the built-in provider the default model runs on, and each declared Go account's", () => {
    expect(goProvidersInUse(cfg(), { employees: [] })).toEqual(["opencode-go"]);
    expect(goProvidersInUse(cfg({ accounts: ACCOUNTS }), { employees: [] })).toEqual(["go-second", "opencode-go"]);
  });

  it("adds a provider an opencode employee is pinned to, and ignores other engines' employees and other providers", () => {
    const config = cfg({ model: "openrouter/x" });
    expect(goProvidersInUse(config, { employees: [] })).toEqual([]);
    expect(goProvidersInUse(config, { employees: [employee("a", "opencode-go/flash"), employee("b", "opencode-go/flash", "claude"), employee("c", "openrouter/y")] })).toEqual(["opencode-go"]);
  });
});

describe("collectGoUsage", () => {
  it("is unavailable with no-key, never a zero, for a provider whose key cannot be found, without asking the provider", async () => {
    const fetchImpl = vi.fn();
    const usage = await collectGoUsage(cfg({ accounts: ACCOUNTS }), { employees: [], env: {}, processEnv: { XDG_DATA_HOME: path.join(TEST_HOME, "none") }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect([...usage.keys()]).toEqual(["go-second", "opencode-go"]);
    for (const reading of usage.values()) expect(reading).toMatchObject({ status: "unavailable", unavailable: { code: "no-key" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads each account with its own key and turns the monthly percentage into dollars only where an allowance is configured", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      seen.push(String((init.headers as Record<string, string>).Authorization));
      return new Response(JSON.stringify({ usage: { monthly: { status: "ok", percent: 25, resetsAt: "2026-12-01T00:00:00Z" } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const usage = await collectGoUsage(cfg({ accounts: ACCOUNTS }), { employees: [], env: { GO_SECOND_KEY: "second-key" }, processEnv: { XDG_DATA_HOME: path.join(TEST_HOME, "none") }, fetchImpl });
    expect(seen).toEqual(["Bearer second-key"]);
    expect(usage.get("go-second")).toMatchObject({ status: "ok", monthlyLimitUsd: 60, consumedUsd: 15, remainingUsd: 45 });
    expect(usage.get("opencode-go")?.unavailable?.code).toBe("no-key");
  });
});

describe("the provider's reading on the snapshots", () => {
  const unmetered = (): EngineLimitEngineSnapshot => ({
    name: "opencode", available: true, status: "unsupported", source: "model-registry", refreshedAt: NOW.toISOString(), defaultModel: "opencode-go/flash", models: [],
    unsupportedReason: "OpenCode exposes no account quota endpoint",
  });

  it("turns an engine with nothing metered into a snapshot carrying the provider's windows", () => {
    const snap = withEngineUsage(unmetered(), cfg(), new Map([["opencode-go", reading(30, 40, 50)]]));
    expect(snap.status).toBe("snapshot");
    expect(snap.unsupportedReason).toBeUndefined();
    expect(snap.providerUsage?.windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 30], ["7d", 40], ["30d", 50]]);
  });

  it("keeps the engine as it was and carries the reason when the reading is unavailable", () => {
    const snap = withEngineUsage(unmetered(), cfg(), new Map([["opencode-go", unavailableUsage("forbidden", NOW)]]));
    expect(snap.status).toBe("unsupported");
    expect(snap.providerUsage?.unavailable?.code).toBe("forbidden");
  });

  it("leaves a provider a declared account covers to that account's card", () => {
    const snap = withEngineUsage(unmetered(), cfg({ accounts: ACCOUNTS }), new Map([["opencode-go", reading(1, 1, 1)]]));
    expect(snap.providerUsage).toBeUndefined();
  });

  it("puts each account's own reading on its snapshot, and a provider with none on none", () => {
    const engine = { ...unmetered(), buckets: [] };
    const accounts = collectOpencodeAccounts(cfg({ accounts: ACCOUNTS }), engine, {
      employees: [], env: {}, health: {}, now: NOW,
      providerUsage: new Map([["go-second", reading(10, 20, 30)], ["opencode-go", unavailableUsage("unauthorized", NOW)]]),
    })!;
    const byProvider = Object.fromEntries(accounts.map((a) => [a.provider, a]));
    expect(byProvider["go-second"]).toMatchObject({ status: "snapshot", providerUsage: { status: "ok" } });
    expect(byProvider["opencode-go"]).toMatchObject({ status: "unsupported", providerUsage: { unavailable: { code: "unauthorized" } } });
  });
});

describe("feeding engine health without counting twice", () => {
  const ledgerBucket = (id: string, used: number) => ({ id, windows: [{ name: "5h", usedPercent: used, resetsAt: (NOW.getTime() + 9 * HOUR) / 1000 }] });

  it("replaces a provider's ledger buckets with the provider's own windows where it answered", () => {
    const buckets = providerHealthBuckets(
      [ledgerBucket("opencode-go/flash", 100), ledgerBucket("openrouter/x", 5)],
      new Map([["opencode-go", reading(10, 20, 30)]]),
    );
    expect(buckets.map((b) => b.id)).toEqual(["openrouter/x", "opencode-go/*"]);
    expect(buckets[1]!.windows!.map((w) => w.usedPercent)).toEqual([10, 20, 30]);
  });

  it("keeps the ledger's buckets for a provider whose reading is unavailable", () => {
    const buckets = providerHealthBuckets([ledgerBucket("opencode-go/flash", 100)], new Map([["opencode-go", unavailableUsage("network", NOW)]]));
    expect(buckets.map((b) => b.id)).toEqual(["opencode-go/flash"]);
  });

  it("holds the provider out until the provider's own reset when it says a window is spent, even at a rounded percentage", () => {
    const usage = reading(20, 99, 40, true);
    recordMeteredExhaustion(providerHealthBuckets([], new Map([["opencode-go", usage]])), NOW);
    expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ state: "exhausted", window: "7d", until: new Date(NOW.getTime() + 48 * HOUR).toISOString() });
  });

  it("records nothing for a provider under its limits, and an old ledger spend a fresh reading says is gone no longer holds it", () => {
    recordMeteredExhaustion(providerHealthBuckets([ledgerBucket("opencode-go/flash", 100)], new Map([["opencode-go", reading(10, 20, 30)]])), NOW);
    expect(readEngineHealth(NOW)["opencode/opencode-go"]).toBeUndefined();
  });
});
