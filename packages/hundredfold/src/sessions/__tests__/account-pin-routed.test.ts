import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorMessage, connectorStub, createTestHome, engineResult, eventually, scriptedEngine, testConfig } from "./helpers/turn-parity-harness.js";
import type { HundredfoldConfig } from "../../shared/types.js";

/**
 * A session a connector routes (Slack, Telegram and the rest) picks its account like every other start: the same 60/40
 * split over ten starts, the same refusal to balance a session that names another engine, and a rotation that a refused
 * route leaves alone.
 */

const HOME = createTestHome("hundredfold-account-pin-routed-");
const LIMITS_DIR = path.join(HOME, "tmp", "engine-limits");
const dbModule = await import("../../shared/db.js");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const OUTSIDE = process.env.HUNDREDFOLD_VITEST_SYSTEM_TEMP_ROOT ?? os.tmpdir();
const FRIEND = path.join(OUTSIDE, "account-pin-routed-friend");

let registry: typeof import("../registry.js");
let ManagerClass: typeof import("../manager.js").SessionManager;
let resetAccountCredits: typeof import("../../shared/fallback-account-pick.js").resetAccountCredits;
let friendKey: string;

beforeAll(async () => {
  registry = await import("../registry.js");
  ({ SessionManager: ManagerClass } = await import("../manager.js"));
  ({ resetAccountCredits } = await import("../../shared/fallback-account-pick.js"));
  const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
  friendKey = `claude:${claudeProfileFromDir(FRIEND).key}`;
  dbModule.initDb();
}, 60_000);

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  resetAccountCredits();
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600;
  for (const [account, used] of [["claude", 40], [friendKey, 60]] as const) {
    const file = account === "claude" ? "claude-usage-history.json" : `claude-usage-history.${encodeURIComponent(account)}.json`;
    fs.writeFileSync(path.join(LIMITS_DIR, file), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: used, resetsAt: later }] }]));
  }
});

function config(): HundredfoldConfig {
  const base = testConfig() as unknown as Record<string, unknown>;
  const engines = base["engines"] as Record<string, unknown>;
  engines["claude"] = { bin: process.execPath, model: "opus", accounts: { friend: { configDir: FRIEND } }, fallback: [{ group: [{ engine: "claude" }, { engine: "claude", profile: "friend" }] }, "codex"] };
  engines["codex"] = { bin: process.execPath, model: "gpt-5.6-sol" };
  base["models"] = {
    claude: { default: "opus", models: [{ id: "opus" }] },
    codex: { default: "gpt-5.6-sol", models: [{ id: "gpt-5.6-sol" }] },
  };
  return base as unknown as HundredfoldConfig;
}

const employee = { name: "parity-worker", engine: "claude", model: "opus", persona: "Routed start fixture" };

async function route(opts: Record<string, unknown> = {}, text = "probe") {
  const manager = new ManagerClass(config(), new Map<string, unknown>([
    ["claude", scriptedEngine("claude", [engineResult({ result: "ok" })])],
    ["codex", scriptedEngine("codex", [engineResult({ result: "ok" })])],
  ]) as never, "routed-boot");
  const key = `stub:routed-${Math.random().toString(16).slice(2)}`;
  const routed = await manager.route(connectorMessage(key, text), connectorStub(), opts);
  const id = routed!.sessionId;
  await eventually(() => ["idle", "error", "interrupted"].includes(registry.getSession(id)?.status ?? ""));
  return registry.getSession(id)!;
}

const accountOf = (session: { claudeConfigDir: string | null }) => (session.claudeConfigDir ? friendKey : "claude");
const pickOf = (session: { transportMeta: unknown }) => (session.transportMeta as { accountPick?: { picked: string; reason: string } } | null)?.accountPick;

async function tally(opts: Record<string, unknown>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (let n = 0; n < 10; n++) {
    const session = await route(opts);
    expect(pickOf(session)).toMatchObject({ reason: "weighted", picked: accountOf(session) });
    counts[accountOf(session)] = (counts[accountOf(session)] ?? 0) + 1;
  }
  return counts;
}

describe("SessionManager.route — the account of a new routed session", () => {
  it("is spread six to four over ten starts of an employee", async () => {
    expect(await tally({ employee })).toEqual({ claude: 6, [friendKey]: 4 });
  }, 90_000);

  it("is spread the same way for a session of no employee", async () => {
    expect(await tally({})).toEqual({ claude: 6, [friendKey]: 4 });
  }, 90_000);

  it("is still balanced when the caller names the claude engine or a model", async () => {
    expect(pickOf(await route({ employee, engine: "claude" }))).toMatchObject({ picked: "claude" });
    expect(pickOf(await route({ employee, model: "opus" }))).toMatchObject({ picked: friendKey });
  }, 60_000);

  it("balances nothing for a session that names another engine, and does not charge it", async () => {
    const other = await route({ employee, engine: "codex" });
    expect(other.engine).toBe("codex");
    expect(pickOf(other)).toBeUndefined();
    expect(other.claudeConfigDir).toBeNull();
    expect(pickOf(await route({ employee }))).toMatchObject({ picked: "claude" }); // still the first start of the rotation
  }, 60_000);

  it("keeps the pick with the connector's own transport meta", async () => {
    const session = await route({ employee });
    expect(pickOf(session)).toBeDefined();
    expect(session.transportMeta).toHaveProperty("accountPick");
  }, 30_000);
});
