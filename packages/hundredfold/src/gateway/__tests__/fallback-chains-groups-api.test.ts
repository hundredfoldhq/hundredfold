import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import type { HundredfoldConfig } from "../../shared/types.js";
import { baseConfig, call, home, loadApi, registry, resetFallbackFixture, setConfig, unloadApi } from "./session-fallback-api-harness.js";

/** Balanced account groups over HTTP: GET /api/fallback-chains (members, group annotation, startPick), the employee PATCH and PUT /api/config accepting and refusing groups, and a balanced session's view. */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const DIR_A = "/srv/operator/.claude-a";
const DIR_B = "/srv/operator/.claude-b";
const KEY_A = `claude:${claudeProfileFromDir(DIR_A).key}`;
const KEY_B = `claude:${claudeProfileFromDir(DIR_B).key}`;
const WORKER_FILE = path.join(home, "org", "a-worker.yaml");
const LIMITS_DIR = path.join(home, "tmp", "engine-limits");
const GROUP = { group: [{ engine: "claude" }, { engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }] };

beforeAll(loadApi);
afterAll(unloadApi);
beforeEach(() => {
  resetFallbackFixture();
  setConfig(groupConfig());
  fs.writeFileSync(WORKER_FILE, yaml.dump({ name: "a-worker", displayName: "A Worker", department: "platform", rank: "employee", engine: "claude", model: "opus", persona: "Fallback mode fixture" }));
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
});

function groupConfig(fallback: unknown[] = [GROUP, { engine: "codex" }]): HundredfoldConfig {
  return {
    ...baseConfig,
    engines: {
      ...baseConfig.engines,
      claude: { bin: "claude", model: "opus", accounts: { A: { configDir: DIR_A }, B: { configDir: DIR_B } }, fallback },
    },
  } as unknown as HundredfoldConfig;
}

/** Writes one fresh reading per account: the default login's history file, and each account's beside it. */
function writeUsage(percent: Record<string, number>): void {
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600;
  for (const [account, used] of Object.entries(percent)) {
    const file = account === "claude" ? "claude-usage-history.json" : `claude-usage-history.${encodeURIComponent(account)}.json`;
    fs.writeFileSync(path.join(LIMITS_DIR, file), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: used, resetsAt: later }] }]));
  }
}

const subject = (body: any, kind: string, id: string) => body.subjects.find((s: any) => s.kind === kind && s.id === id);
const keys = (links: Array<{ key: string }>) => links.map((link) => link.key);

describe("GET /api/fallback-chains with a group", () => {
  it("carries the members with their group, and the pick a new session would make", async () => {
    writeUsage({ claude: 90, [KEY_A]: 60, [KEY_B]: 10 });
    const claude = subject((await call("GET", "/api/fallback-chains")).body, "engine", "claude");
    expect(claude.configured).toEqual([GROUP, { engine: "codex" }]);
    expect(keys(claude.effective)).toEqual(["claude|B|opus", "claude|A|opus", "codex||"]);
    expect(claude.effective[0].group).toMatchObject({ index: 0, written: GROUP, headroom: { account: KEY_B, state: "fresh", headroomPercent: 90 } });
    expect(claude.effective[2]).not.toHaveProperty("group");
    expect(claude.startPick).toMatchObject({ trigger: "start", source: "engine", groupIndex: 0, picked: KEY_B, reason: "most-headroom" });
    expect(claude.startPick.candidates.map((c: any) => c.account)).toEqual([KEY_B, KEY_A, "claude"]);
  });

  it("an employee subject has its own start pick, and a chain with no group has none", async () => {
    writeUsage({ claude: 5, [KEY_A]: 60, [KEY_B]: 10 });
    const employee = subject((await call("GET", "/api/fallback-chains?employee=a-worker")).body, "employee", "a-worker");
    expect(employee.startPick).toMatchObject({ source: "engine", picked: "claude" });
    setConfig(groupConfig([{ engine: "codex" }]));
    const plain = subject((await call("GET", "/api/fallback-chains?employee=a-worker")).body, "employee", "a-worker");
    expect(plain).not.toHaveProperty("startPick");
    for (const link of plain.effective) expect(link).not.toHaveProperty("group");
  });

  it("reads no usage file for a chain with no group, and ranks accounts with no reading as unknown", async () => {
    const claude = subject((await call("GET", "/api/fallback-chains")).body, "engine", "claude");
    expect(claude.startPick).toMatchObject({ reason: "no-readings", picked: "claude" });
    expect(claude.startPick.candidates.every((c: any) => c.state === "unknown" && !("headroomPercent" in c))).toBe(true);
  });
});

describe("PATCH /api/org/employees/:name with a group", () => {
  it("writes an accepted group whole", async () => {
    const chain = [GROUP, { engine: "codex", model: "gpt-mapped" }];
    expect((await call("PATCH", "/api/org/employees/a-worker", { fallback: chain })).status).toBe(200);
    expect((yaml.load(fs.readFileSync(WORKER_FILE, "utf-8")) as any).fallback).toEqual(chain);
    const employee = subject((await call("GET", "/api/fallback-chains?employee=a-worker")).body, "employee", "a-worker");
    expect(employee.configured).toEqual(chain);
    expect(employee.source).toBe("employee");
  });

  it.each([
    ["one member", [{ group: [{ engine: "claude", profile: "A" }] }], "fallback[0].group needs at least two accounts to balance between"],
    ["an opencode member", [{ group: [{ engine: "claude", profile: "A" }, { engine: "opencode", model: "x/y" }] }], "fallback[0].group[1]: a group holds Claude accounts only (opencode account groups are a follow-up)"],
    ["a member's model", [{ group: [{ engine: "claude", profile: "A" }, { engine: "claude", profile: "B", model: "sonnet" }] }], "fallback[0].group[1]: a group member is an account, so it names no model"],
    ["an undeclared profile", [{ group: [{ engine: "claude", profile: "A" }, { engine: "claude", profile: "ghost" }] }], 'fallback[0].group[1]: profile "ghost" names no account under engines.claude.accounts'],
  ])("refuses %s with the wire sentence and writes nothing", async (_name, fallback, sentence) => {
    const got = await call("PATCH", "/api/org/employees/a-worker", { fallback });
    expect(got.status).toBe(400);
    expect(got.body.error).toBe(sentence);
    expect(yaml.load(fs.readFileSync(WORKER_FILE, "utf-8"))).not.toHaveProperty("fallback");
  });
});

describe("PUT /api/config with a group", () => {
  const file = path.join(home, "config.yaml");
  const onDisk = () => (yaml.load(fs.readFileSync(file, "utf-8")) as any).engines.claude;

  it("writes the group exactly as sent over a stored chain, and refuses a malformed one without touching the file", async () => {
    const stored = [{ engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }];
    fs.writeFileSync(file, yaml.dump({ gateway: { port: 7798, host: "127.0.0.1" }, engines: { default: "claude", claude: { bin: "claude", model: "opus", accounts: { A: { configDir: DIR_A }, B: { configDir: DIR_B } }, fallback: stored } } }));
    try {
      const chain = [GROUP, { engine: "claude", profile: "A" }];
      // A standalone repeat of a member is a duplicate: refused on write.
      const dup = await call("PUT", "/api/config", { engines: { claude: { fallback: chain } } });
      expect(dup.status).toBe(400);
      expect(dup.body.error).toContain("engines.claude.fallback[1] duplicates engines.claude.fallback[0].group[1] (claude · A)");
      expect(onDisk().fallback).toEqual(stored);

      const ok = [GROUP, { engine: "codex" }];
      expect((await call("PUT", "/api/config", { engines: { claude: { fallback: ok } } })).status).toBe(200);
      expect(onDisk().fallback).toEqual(ok);

      const bad = await call("PUT", "/api/config", { engines: { claude: { fallback: [{ group: [{ engine: "claude" }] }] } } });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain("engines.claude.fallback[0].group needs at least two accounts to balance between");
      expect(onDisk().fallback).toEqual(ok);

      const account = await call("PUT", "/api/config", { engines: { claude: { accounts: { A: { configDir: DIR_A, fallback: [{ group: [{ engine: "claude", profile: "A" }, { engine: "codex" }] }] } } } } });
      expect(account.status).toBe(400);
      expect(account.body.error).toContain("engines.claude.accounts.A.fallback[0].group[1]: a group holds Claude accounts only");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("GET /api/sessions/:id fallback.chain for a balanced session", () => {
  it("has the chain its pick came from and carries the pick", async () => {
    writeUsage({ claude: 10, [KEY_A]: 60, [KEY_B]: 30 });
    const pick = {
      at: "2026-11-20T12:00:00.000Z", trigger: "start", source: "engine", groupIndex: 0, picked: KEY_B, reason: "most-headroom",
      candidates: [{ account: KEY_B, label: "claude · B", state: "fresh", headroomPercent: 70, tightest: { window: "5h", usedPercent: 30 }, readingAt: "2026-11-20T11:59:00.000Z", activeSessions: 0 }],
    };
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:balanced", model: "opus", claudeConfigDir: DIR_B, transportMeta: { accountPick: pick } });
    const chain = (await call("GET", `/api/sessions/${session.id}`)).body.fallback.chain;
    expect(chain.source).toBe("engine");
    expect(keys(chain.links)).toEqual(["claude|B|opus", "claude||opus", "claude|A|opus", "codex||"]);
    expect(chain.pick).toEqual(pick);
    expect(chain.links[1].group).toMatchObject({ index: 0, headroom: { account: "claude", headroomPercent: 90 } });
  });
});
