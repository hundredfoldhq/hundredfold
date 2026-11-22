import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Employee, EngineLimitEngineSnapshot, HundredfoldConfig } from "../../shared/types.js";

/**
 * The 15-minute engine-health refresh keeps the usage history a remote employee's balancer reads. It reads every remote login
 * over SSH (each declared remote account, and each remote employee's own) and appends the reading to that account's history
 * under its key, which is the key the pick looks it up by. The host is faked; the token script is not run here.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-remote-usage-groups-"));
process.env.HUNDREDFOLD_HOME = tmp;
const { readRemoteAccountUsage } = await import("../remote-account-usage.js");
const { collectClaudeAccounts, registerAccountRoster, registerRemoteAccountReader } = await import("../../shared/engine-limits-accounts.js");
const { latestAccountReading } = await import("../../shared/fallback-chain-limits.js");
const { remoteClaudeAccountKey } = await import("../../shared/engine-account.js");
const { clearAccountReadings } = await import("../../shared/account-readings.js");
const { resetAccountCredits } = await import("../../shared/fallback-account-pick.js");
const { pinAccountAtCreation } = await import("../../sessions/account-pin.js");

const HOST = { remoteHost: "build-host", remoteUser: "me" };
const HOME_DIR = "/home/me/.claude-own";
const SPARE_DIR = "/home/me/.claude-spare";
const OWN_KEY = remoteClaudeAccountKey(HOST, HOME_DIR);
const SPARE_KEY = remoteClaudeAccountKey(HOST, SPARE_DIR);
const USED: Record<string, number> = { [HOME_DIR]: 40, [SPARE_DIR]: 70 };

const config = {
  engines: {
    default: "claude",
    claude: {
      bin: "claude", model: "opus", accounts: { spare: { ...HOST, configDir: SPARE_DIR } },
      fallback: [{ group: [{ engine: "claude" }, { engine: "claude", profile: "spare" }] }],
    },
  },
  remote: { root: "/srv/work", mount: "/mnt/hundredfold" },
} as unknown as HundredfoldConfig;

const employee = {
  name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "claude", model: "opus", persona: "p",
  ...HOST, remoteCwd: "/srv/work/dev", remoteClaudeConfigDir: HOME_DIR,
} as Employee;

const facts = { home: "/home/me", stageDir: "/home/me/.stage", nodeBin: "/usr/bin/node", claudeBin: "/usr/local/bin/claude", hundredfoldVersion: "0.34.0", entryDir: "/x" };

/** The host's answers: the token script prints a token naming the profile it was asked about, and the usage call answers by token. */
const fakeHost = {
  probe: async () => true,
  facts: async () => facts,
  run: async (_destination: string, args: string[], opts?: { stdin?: string }) => (opts?.stdin
    ? { code: 0, stdout: JSON.stringify({ accessToken: `token:${args.join(" ").replaceAll("'", "").split(" ").at(-1)}`, expiresAt: Date.now() + 3600_000 }), stderr: "" }
    : { code: 0, stdout: JSON.stringify({ subscriptionType: "max" }), stderr: "" }),
  fetchUsage: async (token: string) => ({ limits: [{ kind: "session", percent: USED[token.replace("token:", "")] ?? 0, resets_at: "2099-01-01T00:00:00Z" }] }),
  now: () => Date.now(),
};

const defaultSnapshot = { name: "claude", available: true, status: "static", source: "test", refreshedAt: new Date().toISOString(), models: [] } as EngineLimitEngineSnapshot;

beforeEach(() => {
  clearAccountReadings();
  resetAccountCredits();
  fs.rmSync(path.join(tmp, "tmp", "engine-limits"), { recursive: true, force: true });
  registerAccountRoster(() => [employee]);
  registerRemoteAccountReader((_config, account) => readRemoteAccountUsage(account, fakeHost));
});
afterAll(() => {
  registerAccountRoster(undefined as never);
  registerRemoteAccountReader(undefined);
});

describe("the engine-health refresh, for a remote employee's group", () => {
  it("reads the declared remote account and the employee's own remote login into their usage histories", async () => {
    const accounts = await collectClaudeAccounts(config, defaultSnapshot);
    expect(accounts?.map((account) => account.account).sort()).toEqual(["claude", OWN_KEY, SPARE_KEY].sort());
    expect(latestAccountReading(OWN_KEY)?.windows[0]).toMatchObject({ usedPercent: 40 });
    expect(latestAccountReading(SPARE_KEY)?.windows[0]).toMatchObject({ usedPercent: 70 });
  });

  it("is what the pick weighs: 60 against 30 headroom, with nothing handed to it", async () => {
    await collectClaudeAccounts(config, defaultSnapshot);
    const pick = pinAccountAtCreation({ config, employee, engine: "claude", model: "opus" }).accountPick!;
    expect(pick.reason).toBe("weighted");
    expect(pick.picked).toBe(OWN_KEY);
    expect(pick.candidates.map((candidate) => [candidate.account, candidate.headroomPercent, candidate.state])).toEqual([
      [OWN_KEY, 60, "fresh"],
      [SPARE_KEY, 30, "fresh"],
    ]);
  });

  it("weighs a host that never answered as no reading, not as headroom", async () => {
    registerRemoteAccountReader((_config, account) => readRemoteAccountUsage(account, { ...fakeHost, probe: async () => account.key === OWN_KEY }));
    await collectClaudeAccounts(config, defaultSnapshot);
    expect(latestAccountReading(OWN_KEY)).toBeDefined();
    expect(latestAccountReading(SPARE_KEY)).toBeUndefined();
    const candidates = pinAccountAtCreation({ config, employee, engine: "claude", model: "opus" }).accountPick!.candidates;
    expect(candidates.find((candidate) => candidate.account === SPARE_KEY)).toMatchObject({ state: "unknown", weight: 0 });
  });
});
