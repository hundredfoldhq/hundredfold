import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `hundredfold limits` shows the provider's own usage, and keeps the local ledger's figures from sitting beside it as a second reading. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-limits-usage-"));
process.env.HUNDREDFOLD_HOME = tmp;
const collect = vi.fn();
vi.mock("../../shared/engine-limits.js", () => ({ collectEngineLimits: (...args: unknown[]) => collect(...args) }));
vi.mock("../../shared/config.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../shared/config.js")>()), loadConfig: () => ({ engines: {} }) }));
vi.mock("../../shared/models.js", async (importOriginal) => {
  const none = async () => {};
  return { ...(await importOriginal<typeof import("../../shared/models.js")>()), refreshPiModels: none, refreshOpencodeModels: none, refreshGrokModels: none, refreshMusecodeModels: none, refreshHermesModels: none };
});

const { runLimits } = await import("../limits.js");

const win = (name: string, usedPercent: number, mins: number) => ({ name, usedPercent, windowDurationMins: mins });
const ledger = [{ id: "opencode-go/flash", windows: [win("5h", 0, 300), win("30d", 0, 43200)] }, { id: "openrouter/x", windows: [win("30d", 7, 43200)] }];
const OK = { provider: "opencode-go", source: "OpenCode Go usage API", status: "ok", fetchedAt: "2026-11-22T12:00:00.000Z", windows: [win("5h", 31, 300), win("30d", 52, 43200)] };
const UNAVAILABLE = { provider: "opencode-go", source: "OpenCode Go usage API", status: "unavailable", fetchedAt: "2026-11-22T12:00:00.000Z", unavailable: { code: "key-expired", message: "The OpenCode Go key has expired (401)." } };
const base = { available: true, status: "snapshot", source: "hundredfold turn ledger", refreshedAt: "2026-11-22T12:00:00.000Z", models: [] };

function response(providerUsage: object) {
  return {
    generatedAt: base.refreshedAt, default: "claude",
    engines: { opencode: { ...base, name: "opencode", windows: ledger[0]!.windows, buckets: ledger, providerUsage } },
    accounts: { opencode: [{ ...base, name: "opencode", account: "go-a", label: "go-a", location: { kind: "local" }, employees: [], provider: "opencode-go", buckets: [ledger[0]], providerUsage }] },
  };
}

let out: string[];
beforeEach(() => {
  out = [];
  collect.mockReset();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(" ")); });
});
afterEach(() => vi.restoreAllMocks());

const sections = () => out.join("\n").split("\n\n");

describe("hundredfold limits beside the provider's own usage", () => {
  it("prints the provider's windows and leaves out the covered provider's ledger figures, keeping other providers'", async () => {
    collect.mockResolvedValue(response(OK));
    await runLimits({});
    const [engine, account] = sections().slice(-2) as [string, string];
    expect(engine).toContain("5h: 31% used");
    expect(engine).not.toContain("opencode-go/flash");
    expect(engine).not.toContain("Limits:");
    expect(engine).toContain("openrouter/x");
    expect(account).toContain("30d: 52% used");
    expect(account).not.toContain("Buckets");
  });

  it("says why the reading is unavailable and labels the ledger it falls back to as an estimate", async () => {
    collect.mockResolvedValue(response(UNAVAILABLE));
    await runLimits({});
    const [engine, account] = sections().slice(-2) as [string, string];
    expect(engine).toContain("Provider usage: unavailable (The OpenCode Go key has expired (401).)");
    expect(engine).toContain("Limits (local estimate from this gateway's own turns):");
    expect(engine).toContain("Buckets (local estimate");
    expect(account).toContain("Buckets (local estimate");
  });
});
