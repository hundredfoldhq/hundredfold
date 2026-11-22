import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import { resetAccountCredits } from "../../shared/fallback-account-pick.js";
import type { UsageSample } from "../../shared/claude-usage-history.js";
import type { FallbackChainEntry } from "../../shared/fallback-chain-wire.js";
import type { Employee, HundredfoldConfig } from "../../shared/types.js";

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
const { chargeAccountStart, metaWithAccountPick, pinAccountAtCreation, resetCreditsOnGroupChange } = await import("../account-pin.js");

/** Where a new Claude session's account is chosen: the conditions for balancing, what is stored, and that only a charged start moves the rotation. */

const DIR_A = "/srv/operator/.claude-a";
const DIR_B = "/srv/operator/.claude-b";
const KEY_A = `claude:${claudeProfileFromDir(DIR_A).key}`;
const KEY_B = `claude:${claudeProfileFromDir(DIR_B).key}`;
const NOW = new Date("2026-11-20T12:00:00.000Z");
const HOUR = 3600_000;

const GROUP = { group: [{ engine: "claude" }, { engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }] };
const TAIL = { engine: "opencode", model: "openrouter/x" };

function config(fallback: FallbackChainEntry[] = [GROUP, TAIL], engines: Record<string, unknown> = {}): HundredfoldConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", accounts: { A: { configDir: DIR_A }, B: { configDir: DIR_B } }, fallback },
      opencode: { bin: "opencode", model: "opencode/big-pickle" },
      ...engines,
    },
    models: { claude: { default: "opus", models: [{ id: "opus" }, { id: "sonnet" }] }, opencode: { default: "opencode/big-pickle", models: [] } },
  } as unknown as HundredfoldConfig;
}

const employee = (extra: Partial<Employee> = {}): Employee => ({ name: "worker", displayName: "Worker", department: "platform", rank: "employee", engine: "claude", persona: "p", ...extra } as Employee);

/** One fresh reading with `percent` used in its 5h window. */
const used = (percent: number): UsageSample => ({ at: NOW.getTime() - 60_000, windows: [{ name: "5h", usedPercent: percent, resetsAt: Math.floor((NOW.getTime() + 3 * HOUR) / 1000) }] });
const readings = (byAccount: Record<string, number>) => Object.fromEntries(Object.entries(byAccount).map(([account, percent]) => [account, used(percent)]));
const spent = (hours: number) => ({ state: "exhausted" as const, until: new Date(NOW.getTime() + hours * HOUR).toISOString(), recheckAt: new Date(NOW.getTime() + hours * HOUR).toISOString() });

const LIMITS = readings({ claude: 80, [KEY_A]: 70, [KEY_B]: 20 });
const pin = (over: Partial<Parameters<typeof pinAccountAtCreation>[0]> = {}) =>
  pinAccountAtCreation({ config: config(), engine: "claude", model: "opus", now: NOW, inputs: { health: {}, limits: LIMITS }, ...over });

beforeEach(() => resetAccountCredits());
afterEach(() => resetAccountCredits());

describe("pinAccountAtCreation: when it balances", () => {
  it("picks a member of the group at the head of the engine chain for a session of the instance default", () => {
    const result = pin();
    expect(result.accountPick).toMatchObject({ trigger: "start", source: "engine", groupIndex: 0, picked: KEY_B, reason: "weighted" });
    expect(result.accountPick!.candidates.map((candidate) => candidate.account)).toEqual([KEY_B, KEY_A, "claude"]);
    expect(result.claudeConfigDir).toBe(DIR_B);
  });

  it("stores no directory when the pick is the session's own login, but still records the pick", () => {
    const result = pin({ inputs: { health: {}, limits: readings({ claude: 5, [KEY_A]: 90, [KEY_B]: 90 }) } });
    expect(result.accountPick).toMatchObject({ picked: "claude" });
    expect(result).not.toHaveProperty("claudeConfigDir");
  });

  it("uses the employee's own chain, and names it as the pick's source", () => {
    const own = employee({ fallback: [{ group: [{ engine: "claude" }, { engine: "claude", profile: "A" }] }] as never });
    const result = pin({ employee: own });
    expect(result.accountPick).toMatchObject({ source: "employee", picked: KEY_A });
    expect(result.accountPick!.candidates.map((candidate) => candidate.account).sort()).toEqual(["claude", KEY_A].sort());
  });

  it("uses the chain of the employee's own declared account, and names it as the source", () => {
    const named = config([TAIL]);
    (named.engines.claude as { accounts: Record<string, unknown> }).accounts.A = { configDir: DIR_A, fallback: [{ group: [{ engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }] }] };
    const result = pin({ config: named, employee: employee({ claudeConfigDir: DIR_A }) });
    expect(result.accountPick).toMatchObject({ source: "account", groupIndex: 0, picked: KEY_B });
    expect(result.claudeConfigDir).toBe(DIR_B);
  });

  it("does not take the default login for an employee whose own login is a named profile", () => {
    const result = pin({ employee: employee({ claudeConfigDir: DIR_A, fallback: [GROUP] as never }), inputs: { health: {}, limits: readings({ claude: 0, [KEY_A]: 90, [KEY_B]: 90 }) } });
    expect(result.accountPick!.candidates.map((candidate) => candidate.account).sort()).toEqual([KEY_A, KEY_B].sort());
    expect(result.accountPick!.picked).not.toBe("claude");
  });

  it.each([
    ["a session on another engine", { engine: "opencode" }],
    ["a caller that named a profile", { namedProfile: true }],
    ["a remote employee", { employee: employee({ remoteHost: "build.example.test", remoteCwd: "/srv/work" } as Partial<Employee>) }],
    ["a chain with no group", { config: config([TAIL]) }],
    ["a group that does not open the chain", { config: config([TAIL, GROUP]) }],
    ["a group that does not hold the employee's own login", { employee: employee({ claudeConfigDir: "/srv/operator/.claude-other" }) }],
  ] as const)("balances nothing for %s", (_label, over) => {
    expect(pin(over as never)).toEqual({});
  });

  it("names the model in play: a model-scoped window counts only for that family", () => {
    const scoped = (opus: number): UsageSample => ({
      at: NOW.getTime() - 60_000,
      windows: [
        { name: "5h", usedPercent: 10, resetsAt: Math.floor((NOW.getTime() + 3 * HOUR) / 1000) },
        { name: "7d Opus", usedPercent: opus, resetsAt: Math.floor((NOW.getTime() + 3 * HOUR) / 1000) },
      ],
    });
    const limits = { claude: scoped(95), [KEY_A]: used(50), [KEY_B]: used(50) };
    const sonnet = pin({ model: "sonnet", inputs: { health: {}, limits } });
    const opus = pin({ model: "opus", inputs: { health: {}, limits } });
    expect(sonnet.accountPick!.candidates.find((candidate) => candidate.account === "claude")).toMatchObject({ headroomPercent: 90 });
    expect(opus.accountPick!.candidates.find((candidate) => candidate.account === "claude")).toMatchObject({ headroomPercent: 5 });
  });
});

describe("pinAccountAtCreation: every member at its limit", () => {
  it("pins the member that reopens first and says so", () => {
    const health = { claude: spent(5), [KEY_A]: spent(2), [KEY_B]: spent(9) };
    const result = pin({ inputs: { health, limits: LIMITS } });
    expect(result.accountPick).toMatchObject({ reason: "all-exhausted", picked: KEY_A });
    expect(result.claudeConfigDir).toBe(DIR_A);
  });
});

describe("the rotation moves only when a start is charged", () => {
  it("returns the same pick however often it is asked", () => {
    const first = pin().accountPick!;
    for (let i = 0; i < 5; i++) expect(pin().accountPick!.picked).toBe(first.picked);
  });

  it("is spread by headroom: 60 and 40 headroom give six starts and four over ten", () => {
    const two = config([{ group: [{ engine: "claude" }, { engine: "claude", profile: "A" }] }, TAIL]);
    const limits = readings({ claude: 40, [KEY_A]: 60 });
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      const result = pin({ config: two, inputs: { health: {}, limits } });
      chargeAccountStart(result);
      counts[result.accountPick!.picked] = (counts[result.accountPick!.picked] ?? 0) + 1;
    }
    expect(counts).toEqual({ claude: 6, [KEY_A]: 4 });
  });

  it("charges nothing for a pin without a pick, and nothing for a pick that is not charged", () => {
    chargeAccountStart({});
    chargeAccountStart(undefined);
    const before = pin().accountPick!;
    expect(pin().accountPick).toEqual(before);
  });

  it("charges nothing for an all-exhausted pick", () => {
    const health = { claude: spent(5), [KEY_A]: spent(2), [KEY_B]: spent(9) };
    const result = pin({ inputs: { health, limits: LIMITS } });
    chargeAccountStart(result);
    // The rotation is untouched: once the accounts reopen the first pick is what a fresh process would make.
    const fresh = pin().accountPick!.picked;
    resetAccountCredits();
    expect(pin().accountPick!.picked).toBe(fresh);
  });

  it("forgets the credits when a reload changes a group, and only then", () => {
    const run = (): string[] => {
      const picks: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = pin();
        chargeAccountStart(result);
        picks.push(result.accountPick!.picked);
      }
      return picks;
    };
    const fresh = run();
    // Three starts in: the next pick would differ from a fresh rotation's first.
    const midway = pin().accountPick!.picked;
    resetCreditsOnGroupChange(config(), config());
    expect(pin().accountPick!.picked).toBe(midway);
    resetCreditsOnGroupChange(config(), config([{ group: [{ engine: "claude" }, { engine: "claude", profile: "A" }] }, TAIL]));
    expect(pin().accountPick!.picked).toBe(fresh[0]);
  });

  it("also forgets them when engines.opencode.fallback gains, loses or changes a group", () => {
    const group = (...profiles: string[]) => [{ group: profiles.map((profile) => ({ engine: "opencode", profile })) }];
    const withOpencode = (fallback?: unknown[]) => config(undefined, { opencode: { bin: "opencode", model: "opencode-go/glm-5", ...(fallback ? { fallback } : {}) } });
    const startThree = (): string => {
      resetAccountCredits();
      const fresh = pin().accountPick!.picked;
      for (let i = 0; i < 3; i++) chargeAccountStart(pin());
      return fresh;
    };
    const fresh = startThree();
    const midway = pin().accountPick!.picked;
    expect(midway).not.toBe(fresh);
    // A reload that leaves every chain as it was keeps the rotation going.
    resetCreditsOnGroupChange(withOpencode(group("a", "b")), withOpencode(group("a", "b")));
    expect(pin().accountPick!.picked).toBe(midway);
    for (const [before, after] of [[undefined, group("a", "b")], [group("a", "b"), group("a", "b", "c")], [group("a", "b"), undefined]] as const) {
      startThree();
      resetCreditsOnGroupChange(withOpencode(before as unknown[] | undefined), withOpencode(after as unknown[] | undefined));
      expect(pin().accountPick!.picked).toBe(fresh);
    }
  });
});

describe("metaWithAccountPick", () => {
  it("records the pick in the transport meta and leaves the meta alone without one", () => {
    const result = pin();
    expect(metaWithAccountPick({ keep: true }, result)).toEqual({ keep: true, accountPick: result.accountPick });
    expect(metaWithAccountPick({ keep: true }, {})).toEqual({ keep: true });
    expect(metaWithAccountPick(undefined, {})).toBeUndefined();
  });
});

describe("a session pinned off its employee's login at creation", () => {
  it("is rerouted against the pinned account, which the swap records as the one to return to", async () => {
    const { rerouteAtCreation } = await import("../fallback-reroute.js");
    const { availabilityRegistry } = await import("../availability-registry.js");
    const cfg = config([GROUP, TAIL]);
    // The pinned account (B) is out; the employee's own login (default) is not the account the session returns to.
    const health = { [KEY_B]: spent(2) };
    const chosen = pin({ config: cfg, inputs: { health: {}, limits: readings({ claude: 99, [KEY_A]: 99, [KEY_B]: 1 }) } });
    expect(chosen.claudeConfigDir).toBe(DIR_B);
    const result = rerouteAtCreation({
      config: cfg, engine: "claude", model: "opus", registry: availabilityRegistry({}, () => true), health,
      scope: { scoped: false, remote: false }, now: NOW, pin: chosen,
    });
    expect(result).toMatchObject({ engine: "claude", reroute: { account: { original: KEY_B, substitute: "claude" } } });
  });
});
