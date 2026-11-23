/**
 * The per-account usage history of opencode accounts: the samples built from the health buckets, the path beside
 * Claude's (whose names do not change), and that the engine-health refresh (collectEngineLimits) writes one per
 * declared account, with no reading meaning no sample.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineLimitBucket, HundredfoldConfig, ProviderUsage } from "../types.js";

const NODE = process.execPath;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const HOUR = 3_600_000;
const sec = (ms: number): number => Math.ceil(ms / 1000);

let home: string;
let mod: typeof import("../opencode-usage-history.js");
let history: typeof import("../claude-usage-history.js");
let collect: typeof import("../engine-limits.js").collectEngineLimits;
let latest: typeof import("../fallback-chain-limits.js");
let parseGoUsage: typeof import("../opencode-go-usage.js").parseGoUsage;

function cfg(opencode: Record<string, unknown>): HundredfoldConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: NODE, model: "opus" }, opencode: { bin: NODE, model: "opencode-go/flash", ...opencode } },
    connectors: {},
  } as unknown as HundredfoldConfig;
}
const ACCOUNTS = { "go-a": { provider: "opencode-go" }, "go-b": { provider: "go-b", base: "opencode-go", keyEnv: "GO_B_KEY" } };

function usage(fivePercent: number, weeklyPercent: number): ProviderUsage {
  const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
  return {
    source: "OpenCode Go usage API", status: "ok", fetchedAt: new Date().toISOString(),
    windows: parseGoUsage({ usage: {
      rolling: { status: "ok", percent: fivePercent, resetsAt: at(3) },
      weekly: { status: "ok", percent: weeklyPercent, resetsAt: at(72) },
      monthly: { status: "ok", percent: 35, resetsAt: at(300) },
    } })!,
  };
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-oc-usage-history-"));
  process.env.HUNDREDFOLD_HOME = home;
  process.env.HUNDREDFOLD_CLAUDE_USAGE_API = "off";
  mod = await import("../opencode-usage-history.js");
  history = await import("../claude-usage-history.js");
  latest = await import("../fallback-chain-limits.js");
  ({ collectEngineLimits: collect } = await import("../engine-limits.js"));
  ({ parseGoUsage } = await import("../opencode-go-usage.js"));
});
beforeEach(() => {
  fs.rmSync(path.join(home, "tmp", "engine-limits"), { recursive: true, force: true });
  fs.rmSync(path.join(home, "tmp", "engine-health.json"), { force: true });
});
afterAll(() => {
  delete process.env.HUNDREDFOLD_HOME;
  delete process.env.HUNDREDFOLD_CLAUDE_USAGE_API;
  fs.rmSync(home, { recursive: true, force: true });
});

const bucket = (id: string, windows: Array<[string, number, number?]>): EngineLimitBucket => ({
  id, name: id, windows: windows.map(([name, usedPercent, resetsAt]) => ({ name, usedPercent, windowDurationMins: 1, ...(resetsAt === undefined ? {} : { resetsAt }) })),
});

describe("the history path", () => {
  it("keeps Claude's file names and puts an opencode account's beside them", () => {
    expect(path.basename(history.usageHistoryPath("claude"))).toBe("claude-usage-history.json");
    expect(path.basename(history.usageHistoryPath("claude:abc123"))).toBe("claude-usage-history.claude%3Aabc123.json");
    expect(path.basename(history.usageHistoryPath("claude@dev@host:abc"))).toBe(`claude-usage-history.${encodeURIComponent("claude@dev@host:abc")}.json`);
    expect(path.basename(history.usageHistoryPath("opencode/go-b"))).toBe("opencode-usage-history.opencode%2Fgo-b.json");
    expect(path.dirname(history.usageHistoryPath("opencode/go-b"))).toBe(path.dirname(history.usageHistoryPath("claude")));
  });
});

describe("opencodeSampleFromBuckets", () => {
  it("keeps 5h, 7d and 30d of the provider's unscoped bucket, with the reset the window states", () => {
    const reset = sec(NOW + 2 * HOUR);
    const sample = mod.opencodeSampleFromBuckets([bucket("go-b/*", [["5h", 20, reset], ["7d", 55, reset + 1], ["30d", 35, reset + 2]])], "go-b", NOW);
    expect(sample).toEqual({ at: NOW, windows: [
      { name: "5h", usedPercent: 20, resetsAt: reset }, { name: "7d", usedPercent: 55, resetsAt: reset + 1 }, { name: "30d", usedPercent: 35, resetsAt: reset + 2 },
    ] });
  });

  it("names a per-model ledger window `<window> <model key>`, and reads another provider's buckets as none of its own", () => {
    const sample = mod.opencodeSampleFromBuckets([
      bucket("go-b/glm-5", [["5h", 30, sec(NOW + HOUR)]]),
      bucket("go-b/*", [["7d", 10, sec(NOW + HOUR)]]),
      bucket("go-b-other/glm-5", [["5h", 99, sec(NOW + HOUR)]]),
      bucket("opencode-go/glm-5", [["5h", 99, sec(NOW + HOUR)]]),
    ], "go-b", NOW);
    expect(sample!.windows.map((w) => [w.name, w.usedPercent])).toEqual([["5h glm-5", 30], ["7d", 10]]);
  });

  it("holds a window that names no reset to its own length from the reading, and drops windows it does not keep", () => {
    const sample = mod.opencodeSampleFromBuckets([bucket("go-b/*", [["5h", 0], ["7d", 1], ["90d", 50], ["1h", 50]])], "go-b", NOW);
    expect(sample!.windows).toEqual([
      { name: "5h", usedPercent: 0, resetsAt: sec(NOW) + 5 * 3600 },
      { name: "7d", usedPercent: 1, resetsAt: sec(NOW) + 7 * 86_400 },
    ]);
    expect(mod.opencodeSampleFromBuckets([{ id: "go-b/*", windows: [{ name: "5h" }] }], "go-b", NOW)).toBeUndefined();
  });

  it("is no sample when no bucket of the provider has a window", () => {
    expect(mod.opencodeSampleFromBuckets([], "go-b", NOW)).toBeUndefined();
    expect(mod.opencodeSampleFromBuckets([bucket("go-b/*", [])], "go-b", NOW)).toBeUndefined();
    expect(mod.opencodeSampleFromBuckets([bucket("other/*", [["5h", 1]])], "go-b", NOW)).toBeUndefined();
  });
});

describe("recordOpencodeAccountSamples", () => {
  it("appends one sample per declared account that has a reading, to that account's history", () => {
    const config = cfg({ accounts: ACCOUNTS });
    mod.recordOpencodeAccountSamples(config, [bucket("opencode-go/*", [["5h", 40, sec(NOW + HOUR)]]), bucket("undeclared/*", [["5h", 1, sec(NOW + HOUR)]])], NOW);
    expect(history.readClaudeUsageHistory(0, history.usageHistoryPath("opencode/opencode-go")).map((s) => s.windows[0])).toEqual([{ name: "5h", usedPercent: 40, resetsAt: sec(NOW + HOUR) }]);
    // No reading for go-b: no file at all, so it reads as unknown.
    expect(fs.existsSync(history.usageHistoryPath("opencode/go-b"))).toBe(false);
    expect(fs.existsSync(history.usageHistoryPath("opencode/undeclared"))).toBe(false);
  });

  it("collapses readings inside the collapse window, appends one beyond it, and drops what has aged out of the retention", () => {
    const config = cfg({ accounts: ACCOUNTS });
    const b = [bucket("opencode-go/*", [["5h", 40, sec(NOW + HOUR)]])];
    mod.recordOpencodeAccountSamples(config, b, NOW);
    mod.recordOpencodeAccountSamples(config, b, NOW + history.USAGE_HISTORY_COLLAPSE_MS - 1);
    mod.recordOpencodeAccountSamples(config, b, NOW + history.USAGE_HISTORY_COLLAPSE_MS);
    const file = history.usageHistoryPath("opencode/opencode-go");
    expect(history.readClaudeUsageHistory(0, file).map((s) => s.at)).toEqual([NOW, NOW + history.USAGE_HISTORY_COLLAPSE_MS]);
    mod.recordOpencodeAccountSamples(config, b, NOW + history.USAGE_HISTORY_RETENTION_MS + HOUR);
    expect(history.readClaudeUsageHistory(0, file).map((s) => s.at)).toEqual([NOW + history.USAGE_HISTORY_RETENTION_MS + HOUR]);
  });

  it("is what latestAccountReading reads", () => {
    mod.recordOpencodeAccountSamples(cfg({ accounts: ACCOUNTS }), [bucket("opencode-go/*", [["5h", 40, sec(NOW + HOUR)]])], NOW);
    expect(latest.latestAccountReading("opencode/opencode-go")).toMatchObject({ at: NOW });
    expect(latest.latestAccountReading("opencode/go-b")).toBeUndefined();
    expect(latest.latestLimitReadings(cfg({ accounts: ACCOUNTS }))).toMatchObject({ "opencode/opencode-go": { at: NOW }, "opencode/go-b": undefined });
  });
});

describe("collectEngineLimits writes the readings", () => {
  it("appends a sample for each account the provider's meter answered for, and none for one it did not", async () => {
    await collect(cfg({ accounts: ACCOUNTS }), { engine: "opencode", goUsage: async () => new Map([["opencode-go", usage(10, 40)]]) });
    const sample = history.readClaudeUsageHistory(0, history.usageHistoryPath("opencode/opencode-go"));
    expect(sample).toHaveLength(1);
    expect(sample[0]!.windows.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 10], ["7d", 40], ["30d", 35]]);
    expect(fs.existsSync(history.usageHistoryPath("opencode/go-b"))).toBe(false);
  });

  it("writes nothing for an engine with no reading, and nothing under Claude's names", async () => {
    await collect(cfg({ accounts: ACCOUNTS }), { engine: "opencode", goUsage: async () => new Map() });
    const dir = path.dirname(history.usageHistoryPath("claude"));
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.includes("usage-history")) : [];
    expect(files).toEqual([]);
  });
});
