import { describe, expect, it } from "vitest";
import { claudeProfileFromDir } from "../claude-profile.js";
import { expandFallbackChain } from "../fallback-chain-expand.js";
import { homeGroupOf } from "../fallback-chain-group.js";
import { sessionFallbackChain } from "../fallback-chain.js";
import { accountSubject, employeeSubject, engineSubject } from "../fallback-chain-subjects.js";
import type { AccountPick, FallbackChainEntry } from "../fallback-chain-wire.js";
import type { EngineHealthReading } from "../engine-health.js";
import type { UsageSample } from "../claude-usage-history.js";
import type { Employee, HundredfoldConfig, JsonObject, ModelRegistry } from "../types.js";
import { sessionFallbackChainView } from "../../sessions/session-fallback-chain.js";
import { declaredClaudeAccounts } from "../claude-accounts-config.js";
import { makeSession } from "../../sessions/__tests__/helpers/session-fixture.js";

/** Balanced account groups through the resolver: expansion in place, ordering by headroom, the own account, the balanced session's chain, and the start pick. */

const DIRS = { A: "/srv/operator/.claude-a", B: "/srv/operator/.claude-b", C: "/srv/operator/.claude-c" };
const key = (name: keyof typeof DIRS): string => `claude:${claudeProfileFromDir(DIRS[name]).key}`;
const now = new Date("2026-11-20T12:00:00.000Z");
const HOUR = 3600_000;

const GROUP = { group: [{ engine: "claude" }, { engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }, { engine: "claude", profile: "C" }] };
const TAIL = { engine: "opencode", model: "openrouter/x" };

function config(fallback: FallbackChainEntry[] = [GROUP, TAIL], accountChains: Record<string, FallbackChainEntry[]> = {}): HundredfoldConfig {
  const accounts = Object.fromEntries(Object.entries(DIRS).map(([name, configDir]) => [name, { configDir, ...(accountChains[name] ? { fallback: accountChains[name] } : {}) }]));
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", accounts, fallback },
      opencode: { bin: "opencode", model: "opencode/big-pickle" },
    },
  } as unknown as HundredfoldConfig;
}

function entry(name: string, models: string[]): ModelRegistry[string] {
  return { name, available: true, defaultModel: models[0] ?? "", effortMechanism: "none" as const, models: models.map((id) => ({ id, label: id, supportsEffort: false, effortLevels: [] })) };
}
const registry = { claude: entry("claude", ["opus", "sonnet"]), opencode: entry("opencode", []) } as unknown as ModelRegistry;

/** A reading of one 5h window, fresh. */
const used = (percent: number, extra: Array<[string, number]> = []): UsageSample => ({
  at: now.getTime() - 60_000,
  windows: [["5h", percent], ...extra].map(([name, usedPercent]) => ({ name: name as string, usedPercent: usedPercent as number, resetsAt: Math.floor((now.getTime() + 3 * HOUR) / 1000) })),
});

const LIMITS: Record<string, UsageSample> = { claude: used(80), [key("A")]: used(70), [key("B")]: used(20), [key("C")]: used(50) };

function resolve(options: { config?: HundredfoldConfig; employee?: Employee; session?: Parameters<typeof makeSession>[0]; health?: EngineHealthReading; limits?: Record<string, UsageSample | undefined>; active?: Record<string, number> } = {}) {
  return sessionFallbackChain({
    config: options.config ?? config(),
    employee: options.employee,
    session: makeSession(options.session),
    registry,
    health: options.health ?? {},
    limits: options.limits ?? LIMITS,
    now,
    activeSessions: (account) => options.active?.[account] ?? 0,
  });
}

const keys = (links: Array<{ key: string }>): string[] => links.map((link) => link.key);

describe("expansion in place", () => {
  it("lists a group's members where the group is written, as ordinary links, ordered by headroom", () => {
    const { source, links } = resolve();
    expect(source).toBe("engine");
    // The default login is the own target; the other three come by headroom: B (80 left), C (50), A (30).
    expect(keys(links)).toEqual(["claude||opus", "claude|B|opus", "claude|C|opus", "claude|A|opus", "opencode||openrouter/x"]);
    expect(links.map((link) => link.account)).toEqual(["claude", key("B"), key("C"), key("A"), "opencode"]);
    expect(links[0]).not.toHaveProperty("group");
    expect(links.at(-1)).not.toHaveProperty("group");
  });

  it("annotates each member with the group's place, the group as written and its ranking input", () => {
    const { links } = resolve();
    const [, b, , a] = links;
    expect(b!.group).toMatchObject({ index: 0, written: GROUP, headroom: { account: key("B"), state: "fresh", headroomPercent: 80, activeSessions: 0, tightest: { window: "5h", usedPercent: 20 } } });
    expect(a!.group!.headroom).toMatchObject({ account: key("A"), headroomPercent: 30 });
    expect(b!.written).toEqual({ engine: "claude", profile: "B" });
  });

  it("puts the own account at index 0 and drops it from the expansion, whichever member it is", () => {
    const onA = resolve({ session: { claudeConfigDir: DIRS.A, transportMeta: { accountPick: pick("engine") } } });
    expect(keys(onA.links)).toEqual(["claude|A|opus", "claude|B|opus", "claude|C|opus", "claude||opus", "opencode||openrouter/x"]);
    expect(onA.links.filter((link) => link.group).map((link) => link.account)).toEqual([key("B"), key("C"), "claude"]);
  });

  it("orders ties by active sessions, then written order, and reflects a new reading on the next resolution", () => {
    const equal = { claude: used(50), [key("A")]: used(50), [key("B")]: used(50), [key("C")]: used(50) };
    expect(keys(resolve({ limits: equal }).links)).toEqual(["claude||opus", "claude|A|opus", "claude|B|opus", "claude|C|opus", "opencode||openrouter/x"]);
    expect(keys(resolve({ limits: equal, active: { [key("A")]: 2, [key("B")]: 0, [key("C")]: 1 } }).links).slice(1, 4)).toEqual(["claude|B|opus", "claude|C|opus", "claude|A|opus"]);
    expect(keys(resolve({ limits: { ...LIMITS, [key("A")]: used(5) } }).links).slice(1, 4)).toEqual(["claude|A|opus", "claude|B|opus", "claude|C|opus"]);
  });

  it("orders an exhausted member after the rest, and an account with no reading between", () => {
    const spent = { state: "exhausted" as const, until: new Date(now.getTime() + HOUR).toISOString() };
    expect(keys(resolve({ health: { [key("B")]: spent } }).links).slice(1, 4)).toEqual(["claude|C|opus", "claude|A|opus", "claude|B|opus"]);
    expect(keys(resolve({ limits: { ...LIMITS, [key("C")]: undefined } }).links).slice(1, 4)).toEqual(["claude|B|opus", "claude|A|opus", "claude|C|opus"]);
  });

  it("applies a model-scoped window only to its family", () => {
    const opusFull = { ...LIMITS, [key("B")]: used(20, [["7d Opus", 99]]) };
    expect(keys(resolve({ limits: opusFull }).links)[1]).toBe("claude|C|opus");
    expect(keys(resolve({ limits: opusFull, session: { model: "sonnet" } }).links)[1]).toBe("claude|B|sonnet");
  });

  it("keeps a member the session cannot use after the usable ones, with its reason", () => {
    const withGhost = config([{ group: [{ engine: "claude" }, { engine: "claude", profile: "ghost" }, { engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }] }]);
    const { links } = resolve({ config: withGhost });
    expect(links.map((link) => [link.key, link.skip])).toEqual([["claude||opus", undefined], ["claude|B|opus", undefined], ["claude|A|opus", undefined], ["claude|ghost|opus", "profile-unknown"]]);
  });

  it("lists a member once when the chain also names it as a link (a tolerated duplicate)", () => {
    const { links } = resolve({ config: config([{ engine: "claude", profile: "A" }, GROUP]) });
    expect(keys(links).filter((k) => k === "claude|A|opus")).toHaveLength(1);
    // The standalone link keeps its place and carries no group.
    expect(links[1]).toMatchObject({ key: "claude|A|opus" });
    expect(links[1]).not.toHaveProperty("group");
  });

  it("expands a group in an employee's chain and in a declared account's chain, in the written place", () => {
    const worker: Employee = { name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "claude", model: "opus", persona: "p", fallback: [TAIL, GROUP] };
    expect(keys(resolve({ employee: worker }).links)).toEqual(["claude||opus", "opencode||openrouter/x", "claude|B|opus", "claude|C|opus", "claude|A|opus"]);
    const accountChain = config([], { A: [{ group: [{ engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }] }, TAIL] });
    expect(keys(resolve({ config: accountChain, session: { claudeConfigDir: DIRS.A } }).links)).toEqual(["claude|A|opus", "claude|B|opus", "opencode||openrouter/x"]);
  });

  it("expands a group named by a legacy string entry's own chain, tagged with its index there", () => {
    const c = config(["claude:A"], { A: [TAIL, { group: [{ engine: "claude", profile: "B" }, { engine: "claude", profile: "C" }] }] });
    const out = expandFallbackChain(c, ["claude:A"], { mode: "account", selfAccount: "claude" });
    expect(out.map(({ link, origin, group }) => [link.profile ?? link.engine, origin, group?.index])).toEqual([["A", "config", undefined], ["opencode", "legacy", undefined], ["B", "legacy", 1], ["C", "legacy", 1]]);
    expect(out[2]!.group!.written).toBe(out[3]!.group!.written);
  });
});

describe("a chain with no group", () => {
  const CASES: Array<[string, FallbackChainEntry[]]> = [
    ["objects", [{ engine: "claude", profile: "A", model: "opus" }, TAIL]],
    ["legacy strings", ["claude:A", "opencode"]],
    ["empty", []],
  ];

  it.each(CASES)("resolves with no group key on any link and a cache-stable shape: %s", (_name, chain) => {
    const first = resolve({ config: config(chain) });
    for (const link of first.links) expect(Object.keys(link)).not.toContain("group");
    expect(JSON.parse(JSON.stringify(resolve({ config: config(chain) })))).toEqual(JSON.parse(JSON.stringify(first)));
    for (const { group } of expandFallbackChain(config(chain), chain, { mode: "account", selfAccount: "claude" })) expect(group).toBeUndefined();
  });

  it("keeps the exact links of the plain acceptance chain", () => {
    const { links } = resolve({ config: config([{ engine: "claude", profile: "A", model: "opus" }, TAIL]) });
    expect(links.map(({ key: k, account, label, origin, written }) => ({ k, account, label, origin, written }))).toEqual([
      { k: "claude||opus", account: "claude", label: "claude · opus", origin: "config", written: { engine: "claude", model: "opus" } },
      { k: "claude|A|opus", account: key("A"), label: "claude · A · opus", origin: "config", written: { engine: "claude", profile: "A", model: "opus" } },
      { k: "opencode||openrouter/x", account: "opencode", label: "opencode · openrouter/x", origin: "config", written: TAIL },
    ]);
  });
});

function pick(source: AccountPick["source"], picked = key("A")): JsonObject {
  const record: AccountPick = {
    at: now.toISOString(), trigger: "start", source, groupIndex: 0, picked, reason: "most-headroom",
    candidates: [{ account: picked, label: "claude · A", state: "fresh", headroomPercent: 30, tightest: { window: "5h", usedPercent: 70, resetsAt: "2026-11-20T15:00:00.000Z" }, readingAt: "2026-11-20T11:59:00.000Z", activeSessions: 1 }],
  };
  return record as unknown as JsonObject;
}

describe("a balanced session", () => {
  const worker = (fallback?: FallbackChainEntry[]): Employee => ({ name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "claude", model: "opus", persona: "p", ...(fallback ? { fallback } : {}) });

  it("resolves against the chain its pick came from, not the pinned account's own", () => {
    // A has a chain of its own; the engine's group is what the session keeps.
    const c = config([GROUP, TAIL], { A: [{ engine: "claude", profile: "C" }] });
    const plain = resolve({ config: c, session: { claudeConfigDir: DIRS.A } });
    expect(plain.source).toBe("account");
    expect(keys(plain.links)).toEqual(["claude|A|opus", "claude|C|opus"]);
    const balanced = resolve({ config: c, session: { claudeConfigDir: DIRS.A, transportMeta: { accountPick: pick("engine") } } });
    expect(balanced.source).toBe("engine");
    expect(keys(balanced.links)).toEqual(["claude|A|opus", "claude|B|opus", "claude|C|opus", "claude||opus", "opencode||openrouter/x"]);
  });

  it("keeps the employee's chain for a pick from the employee, and the employee's own login's chain for a pick from the account", () => {
    const own = [GROUP, TAIL];
    const fromEmployee = resolve({ employee: worker(own), session: { employee: "dev", claudeConfigDir: DIRS.B, transportMeta: { accountPick: pick("employee", key("B")) } } });
    expect(fromEmployee.source).toBe("employee");
    expect(keys(fromEmployee.links)[0]).toBe("claude|B|opus");

    const c = config([{ engine: "codex" }], { A: [{ group: [{ engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }] }, TAIL] });
    const loginA = { ...worker(), claudeConfigDir: DIRS.A };
    const pinnedB = resolve({ config: c, employee: loginA, session: { employee: "dev", claudeConfigDir: DIRS.B, transportMeta: { accountPick: pick("account", key("B")) } } });
    expect(pinnedB.source).toBe("account");
    expect(keys(pinnedB.links)).toEqual(["claude|B|opus", "claude|A|opus", "opencode||openrouter/x"]);
  });

  it("falls back to the ordinary chain when the chain it came from is gone, and ignores a malformed pick", () => {
    const gone = resolve({ config: config([TAIL]), session: { claudeConfigDir: DIRS.A, transportMeta: { accountPick: pick("employee") } } });
    expect(gone.source).toBe("account");
    const malformed = resolve({ session: { claudeConfigDir: DIRS.A, transportMeta: { accountPick: { source: "engine", picked: 4 } } } });
    expect(malformed.source).toBe("account");
  });

  it("an explicit fallback target still wins over the pick", () => {
    const { source } = resolve({ session: { fallbackTarget: { engine: "opencode", model: "openrouter/x" }, transportMeta: { accountPick: pick("engine") } } });
    expect(source).toBe("session");
  });
});

describe("the session view's pick", () => {
  const view = (transportMeta: Record<string, unknown> | null) => sessionFallbackChainView({
    config: config(), session: makeSession({ claudeConfigDir: DIRS.A, transportMeta: transportMeta as never }), registry, health: {}, limits: LIMITS, now,
  });

  it("carries the recorded pick whole, and none for a session the balancer did not pin", () => {
    const recorded = pick("engine");
    expect(view({ accountPick: recorded }).pick).toEqual(recorded);
    expect(view(null)).not.toHaveProperty("pick");
    expect(view({ accountPick: { ...recorded, trigger: "later" } })).not.toHaveProperty("pick");
    expect(view({ accountPick: { ...recorded, candidates: [{ account: "x" }] } })).not.toHaveProperty("pick");
    expect(view({ accountPick: { ...recorded, groupIndex: 1.5 } })).not.toHaveProperty("pick");
  });
});

describe("homeGroupOf", () => {
  const c = config();
  it("is the first entry's group when it holds the own account, whichever member that is", () => {
    for (const own of ["claude", key("A"), key("C")]) expect(homeGroupOf(c, [GROUP, TAIL], own)).toMatchObject({ index: 0, written: GROUP, members: expect.any(Array) });
    expect(homeGroupOf(c, [GROUP], key("B"))!.members.map((member) => member.account)).toEqual(["claude", key("A"), key("B"), key("C")]);
  });

  it("is undefined when the group is not first, does not hold the own account, or there is none", () => {
    expect(homeGroupOf(c, [TAIL, GROUP], "claude")).toBeUndefined();
    expect(homeGroupOf(c, [{ group: [{ engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }] }], "claude")).toBeUndefined();
    expect(homeGroupOf(c, [TAIL], "claude")).toBeUndefined();
    expect(homeGroupOf(c, [], "claude")).toBeUndefined();
  });

  it("reads a member naming no profile as the login the subject runs", () => {
    expect(homeGroupOf(c, [{ group: [{ engine: "claude" }, { engine: "claude", profile: "B" }] }], key("A"), key("A"))).toBeDefined();
    expect(homeGroupOf(c, [{ group: [{ engine: "claude" }, { engine: "claude", profile: "B" }] }], key("A"))).toBeUndefined();
  });
});

describe("the chains API subjects", () => {
  const env = { config: config(), registry, health: {} as EngineHealthReading, limits: LIMITS, now };

  it("an engine subject with a home group carries the group's members and the pick a new session would make", () => {
    const claude = engineSubject(env, "claude");
    expect(claude.configured).toEqual([GROUP, TAIL]);
    expect(claude.effective.filter((link) => link.group).map((link) => link.account)).toEqual([key("B"), key("C"), key("A")]);
    expect(claude.startPick).toMatchObject({ trigger: "start", source: "engine", groupIndex: 0, picked: key("B"), reason: "most-headroom" });
    expect(claude.startPick!.candidates.map((candidate) => candidate.account)).toEqual([key("B"), key("C"), key("A"), "claude"]);
    expect(engineSubject(env, "opencode")).not.toHaveProperty("startPick");
  });

  it("an employee subject has one when its own login is in the group, from its own chain or an inherited one", () => {
    const dev: Employee = { name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "claude", model: "opus", persona: "p" };
    const open = { scoped: false, remote: false };
    expect(employeeSubject(env, dev, open).startPick).toMatchObject({ source: "engine", picked: key("B") });
    expect(employeeSubject(env, { ...dev, fallback: [GROUP] }, open).startPick).toMatchObject({ source: "employee" });
    // A login outside the group, a group that is not first, a remote employee and a non-Claude employee have none.
    expect(employeeSubject(env, { ...dev, fallback: [{ group: [{ engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }] }] }, open)).not.toHaveProperty("startPick");
    expect(employeeSubject(env, { ...dev, fallback: [TAIL, GROUP] }, open)).not.toHaveProperty("startPick");
    expect(employeeSubject(env, dev, { scoped: false, remote: true, host: "u@h" })).not.toHaveProperty("startPick");
    expect(employeeSubject(env, { ...dev, engine: "opencode", model: "x/y", fallback: [GROUP] }, open)).not.toHaveProperty("startPick");
  });

  it("leaves the default login out of the pick for an employee on a named profile, but not out of its fallback members", () => {
    const onA: Employee = { name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "claude", model: "opus", persona: "p", claudeConfigDir: DIRS.A, fallback: [GROUP] };
    const subject = employeeSubject(env, onA, { scoped: false, remote: false });
    expect(subject.startPick!.candidates.map((candidate) => candidate.account).sort()).toEqual([key("A"), key("B"), key("C")].sort());
    expect(subject.effective.filter((link) => link.group).map((link) => link.account)).toContain("claude");
  });

  it("leaves a member out of the pick that the employee cannot use, and says all-exhausted when every candidate is out", () => {
    const dev: Employee = { name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "claude", model: "opus", persona: "p", fallback: [{ group: [{ engine: "claude" }, { engine: "claude", profile: "A" }] }] };
    const spent = (hours: number) => ({ state: "exhausted" as const, until: new Date(now.getTime() + hours * HOUR).toISOString() });
    const out = employeeSubject({ ...env, health: { claude: spent(3), [key("A")]: spent(1) } }, dev, { scoped: false, remote: false });
    expect(out.startPick).toMatchObject({ reason: "all-exhausted", picked: key("A") });
  });

  it("an account subject shows its group as members, without a start pick", () => {
    const withAccountGroup = { ...env, config: config([], { A: [{ group: [{ engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }] }] }) };
    const [account] = declaredClaudeAccounts(withAccountGroup.config);
    const subject = accountSubject(withAccountGroup, account!);
    expect(subject.effective.map((link) => link.key)).toEqual(["claude|B|opus"]);
    expect(subject.effective[0]!.group).toMatchObject({ index: 0 });
    expect(subject).not.toHaveProperty("startPick");
  });
});
