import { beforeEach, describe, expect, it } from "vitest";
import { opencodeHomeGroupOf } from "../fallback-chain-group.js";
import { resetAccountCredits } from "../fallback-account-pick.js";
import { sessionFallbackChain } from "../fallback-chain.js";
import { employeeSubject, engineSubject } from "../fallback-chain-subjects.js";
import type { FallbackChainEntry } from "../fallback-chain-wire.js";
import type { EngineHealthReading } from "../engine-health.js";
import type { UsageSample } from "../claude-usage-history.js";
import type { Employee, HundredfoldConfig, ModelRegistry } from "../types.js";
import { makeSession } from "../../sessions/__tests__/helpers/session-fixture.js";

/** opencode account groups through the resolver: expansion to the session's model key on each member's provider, ordering and picking by headroom under `opencode/<provider>` keys. */

const now = new Date("2026-11-20T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

const A = "opencode/opencode-go";
const B = "opencode/opencode-go-b";
const C = "opencode/opencode-go-c";

const GROUP = { group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }, { engine: "opencode", profile: "go-c" }] };
const TAIL = { engine: "claude" };

function config(fallback: FallbackChainEntry[] = [GROUP, TAIL], model = "opencode-go/glm-5"): HundredfoldConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      opencode: {
        bin: "opencode", model, fallback,
        accounts: {
          "go-a": { provider: "opencode-go" },
          "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY" },
          "go-c": { provider: "opencode-go-c", base: "opencode-go", keyEnv: "OPENCODE_GO_C_API_KEY" },
        },
      },
    },
  } as unknown as HundredfoldConfig;
}

function entry(name: string, ids: string[]): ModelRegistry[string] {
  return { name, available: true, defaultModel: ids[0] ?? "", effortMechanism: "none" as const, models: ids.map((id) => ({ id, label: id, supportsEffort: false, effortLevels: [] })) };
}
/** go-b serves glm-5 only; go-c serves glm-5 and kimi; the built-in account serves both. */
const registry = {
  claude: entry("claude", ["opus"]),
  opencode: entry("opencode", ["opencode-go/glm-5", "opencode-go/kimi", "opencode-go-b/glm-5", "opencode-go-c/glm-5", "opencode-go-c/kimi"]),
} as unknown as ModelRegistry;

type Win = [name: string, usedPercent: number];
/** A reading, `ageMs` old, whose windows reset in three hours. */
function reading(windows: Win[], ageMs = MIN): UsageSample {
  return { at: now.getTime() - ageMs, windows: windows.map(([name, usedPercent]) => ({ name, usedPercent, resetsAt: Math.floor((now.getTime() + 3 * HOUR) / 1000) })) };
}
const used = (percent: number, ageMs?: number): UsageSample => reading([["5h", percent]], ageMs);

const LIMITS: Record<string, UsageSample | undefined> = { [A]: used(40), [B]: used(60), [C]: used(10) };
const spent = (hours = 1) => ({ state: "exhausted" as const, until: new Date(now.getTime() + hours * HOUR).toISOString() });

const worker = (fallback?: FallbackChainEntry[], model = "opencode-go/glm-5"): Employee =>
  ({ name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "opencode", model, persona: "p", ...(fallback ? { fallback: fallback as Employee["fallback"] } : {}) });

function env(options: { config?: HundredfoldConfig; health?: EngineHealthReading; limits?: Record<string, UsageSample | undefined> } = {}) {
  return { config: options.config ?? config(), registry, health: options.health ?? {}, limits: options.limits ?? LIMITS, now };
}

function resolve(options: { config?: HundredfoldConfig; health?: EngineHealthReading; limits?: Record<string, UsageSample | undefined>; session?: Parameters<typeof makeSession>[0]; employee?: Employee } = {}) {
  return sessionFallbackChain({
    ...env(options), employee: options.employee,
    session: makeSession({ engine: "opencode", model: "opencode-go/glm-5", ...options.session }),
  });
}

const keys = (links: Array<{ key: string }>): string[] => links.map((link) => link.key);
const pickOf = (options: Parameters<typeof env>[0] = {}) => engineSubject(env(options), "opencode").startPick;
const shares = (pick: ReturnType<typeof pickOf>): Record<string, number> => Object.fromEntries((pick?.candidates ?? []).map((candidate) => [candidate.account, candidate.sharePercent]));

beforeEach(resetAccountCredits);

describe("expansion to the session's model key on each member's provider", () => {
  it("lists the other members as {opencode, <provider>/<model key>}, ordered by headroom, the own account being index 0", () => {
    const { source, links } = resolve();
    expect(source).toBe("engine");
    // glm-5 on the built-in provider is the own target; C has 90 left, B 40.
    expect(keys(links)).toEqual(["opencode||opencode-go/glm-5", "opencode||opencode-go-c/glm-5", "opencode||opencode-go-b/glm-5", "claude||"]);
    expect(links.slice(1, 3).map((link) => [link.engine, link.model, link.account, link.profile])).toEqual([
      ["opencode", "opencode-go-c/glm-5", "opencode", undefined],
      ["opencode", "opencode-go-b/glm-5", "opencode", undefined],
    ]);
    expect(links[0]).not.toHaveProperty("group");
    expect(links.at(-1)).not.toHaveProperty("group");
  });

  it("keeps the link as config spells it, and tags each member with the group and its ranking input", () => {
    const [, c, b] = resolve().links;
    expect(c!.written).toEqual({ engine: "opencode", profile: "go-c" });
    expect(c!.group).toMatchObject({ index: 0, written: GROUP, headroom: { account: C, label: "opencode · opencode-go-c/glm-5", state: "fresh", headroomPercent: 90, weight: 90, sharePercent: 69, tightest: { window: "5h", usedPercent: 10 } } });
    expect(b!.group!.headroom).toMatchObject({ account: B, headroomPercent: 40, weight: 40, sharePercent: 31 });
  });

  it("carries the model key over whichever member is the own account", () => {
    const onB = resolve({ session: { model: "opencode-go-b/glm-5" } });
    expect(keys(onB.links).slice(0, 3)).toEqual(["opencode||opencode-go-b/glm-5", "opencode||opencode-go-c/glm-5", "opencode||opencode-go/glm-5"]);
    expect(onB.links.filter((link) => link.group).map((link) => link.group!.headroom!.account)).toEqual([C, A]);
  });

  it("skips a member whose account does not serve the key, after the usable ones, with the existing reason", () => {
    const { links } = resolve({ session: { model: "opencode-go/kimi" } });
    expect(links.map((link) => [link.key, link.skip])).toEqual([
      ["opencode||opencode-go/kimi", undefined],
      ["opencode||opencode-go-c/kimi", undefined],
      ["opencode||opencode-go-b/kimi", "model-not-served"],
      ["claude||", undefined],
    ]);
  });

  it("skips a member that names no declared account as profile-unknown, and one with no model key to carry over as model-not-served", () => {
    const ghost = config([{ group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "ghost" }, { engine: "opencode", profile: "go-b" }] }]);
    expect(resolve({ config: ghost }).links.map((link) => [link.key, link.skip])).toEqual([
      ["opencode||opencode-go/glm-5", undefined], ["opencode||opencode-go-b/glm-5", undefined], ["opencode|ghost|", "profile-unknown"],
    ]);
    const keyless = resolve({ session: { model: "opencode-go/" } });
    expect(keyless.links.filter((link) => link.group).map((link) => link.skip)).toEqual(["model-not-served", "model-not-served"]);
  });

  it("expands a group in an opencode employee's chain, in the written place", () => {
    const links = resolve({ employee: worker([TAIL, GROUP]), session: { employee: "dev" } }).links;
    expect(keys(links)).toEqual(["opencode||opencode-go/glm-5", "claude||", "opencode||opencode-go-c/glm-5", "opencode||opencode-go-b/glm-5"]);
  });

  it("lists a member once when the chain also names it as a link (a tolerated duplicate)", () => {
    const { links } = resolve({ config: config([{ engine: "opencode", model: "opencode-go-b/glm-5" }, GROUP]) });
    expect(keys(links).filter((k) => k === "opencode||opencode-go-b/glm-5")).toHaveLength(1);
    expect(links[1]).not.toHaveProperty("group");
  });
});

describe("ranking under opencode/<provider> keys", () => {
  const order = (options: Parameters<typeof resolve>[0]): string[] => resolve(options).links.filter((link) => link.group).map((link) => link.model!);

  it("orders by headroom, then by the order written, and follows a new reading", () => {
    expect(order({})).toEqual(["opencode-go-c/glm-5", "opencode-go-b/glm-5"]);
    expect(order({ limits: { [A]: used(10), [B]: used(10), [C]: used(10) } })).toEqual(["opencode-go-b/glm-5", "opencode-go-c/glm-5"]);
    expect(order({ limits: { ...LIMITS, [B]: used(5) } })).toEqual(["opencode-go-b/glm-5", "opencode-go-c/glm-5"]);
  });

  it("reads a member's reading under its own key, never the shared `opencode` account", () => {
    expect(order({ limits: { opencode: used(1), [A]: used(10), [B]: used(50), [C]: used(90) } })).toEqual(["opencode-go-b/glm-5", "opencode-go-c/glm-5"]);
  });

  it("orders a member at its limit last, whether health holds its provider or only the session's model on it", () => {
    expect(order({ health: { [C]: spent() } })).toEqual(["opencode-go-b/glm-5", "opencode-go-c/glm-5"]);
    expect(order({ health: { [`${C}/glm-5`]: spent() } })).toEqual(["opencode-go-b/glm-5", "opencode-go-c/glm-5"]);
    // A hold on another model of the provider does not count.
    expect(order({ health: { [`${C}/kimi`]: spent() } })).toEqual(["opencode-go-c/glm-5", "opencode-go-b/glm-5"]);
  });

  it("orders an account with no reading after the rest", () => {
    expect(order({ limits: { ...LIMITS, [C]: undefined } })).toEqual(["opencode-go-b/glm-5", "opencode-go-c/glm-5"]);
  });

  it("applies a model-scoped window only to a session on exactly that model key", () => {
    const scoped = { ...LIMITS, [C]: reading([["5h", 10], ["5h glm-5", 99]]), [B]: reading([["5h", 60], ["7d glm", 99], ["5h kimi", 99]]) };
    // C's glm-5 window binds a glm-5 session; B's windows for other keys do not (no family or prefix match).
    expect(order({ limits: scoped })).toEqual(["opencode-go-b/glm-5", "opencode-go-c/glm-5"]);
    // A session on kimi: C's glm-5 window does not apply, and B's kimi window does.
    expect(order({ limits: scoped, session: { model: "opencode-go/kimi" } })).toEqual(["opencode-go-c/kimi", "opencode-go-b/kimi"]);
  });
});

describe("the start pick of an opencode subject", () => {
  it("is a split in proportion to headroom: 60/40 and 90/10", () => {
    expect(shares(pickOf({ limits: { [A]: used(40), [B]: used(60), [C]: used(100) } }))).toEqual({ [A]: 60, [B]: 40, [C]: 0 });
    expect(shares(pickOf({ limits: { [A]: used(10), [B]: used(90), [C]: used(100) } }))).toEqual({ [A]: 90, [B]: 10, [C]: 0 });
  });

  it("is over the whole home group, own account included, recorded as an engine pick at entry 0", () => {
    const pick = pickOf();
    expect(pick).toMatchObject({ trigger: "start", source: "engine", groupIndex: 0, reason: "weighted" });
    expect(pick!.candidates.map((candidate) => [candidate.account, candidate.label, candidate.sharePercent])).toEqual([
      [C, "opencode · go-c", 47], [A, "opencode · go-a", 32], [B, "opencode · go-b", 21],
    ]);
  });

  it("gives an exhausted account none, and a signed-out one none", () => {
    expect(shares(pickOf({ health: { [B]: spent() } }))).toMatchObject({ [B]: 0 });
    const authFailure = { state: "exhausted" as const, failureClass: "auth" as const, until: new Date(now.getTime() + HOUR).toISOString() };
    expect(shares(pickOf({ health: { [C]: authFailure } }))).toMatchObject({ [C]: 0 });
    expect(pickOf({ health: { [`${A}/glm-5`]: spent() } })!.candidates.find((candidate) => candidate.account === A)).toMatchObject({ state: "exhausted", weight: 0 });
  });

  it("splits evenly when no account has a reading, and gives one with no reading nothing while another has one", () => {
    const none = pickOf({ limits: {} });
    expect(none).toMatchObject({ reason: "no-readings" });
    expect(Object.values(shares(none))).toEqual([33, 33, 33]);
    expect(shares(pickOf({ limits: { [A]: used(50) } }))).toEqual({ [A]: 100, [B]: 0, [C]: 0 });
  });

  it("halves the weight of a stale reading", () => {
    const stale = pickOf({ limits: { [A]: used(50, 31 * MIN), [B]: used(50), [C]: used(100) } });
    expect(stale!.candidates.map((candidate) => [candidate.account, candidate.state, candidate.weight])).toEqual([[B, "fresh", 50], [C, "fresh", 0], [A, "stale", 25]]);
  });

  it("applies a model-scoped ledger window only to its model, and leaves a member that does not serve the key out", () => {
    const scoped = { [A]: reading([["5h", 10], ["5h glm-5", 100]]), [B]: used(50), [C]: used(50) };
    expect(shares(pickOf({ limits: scoped }))).toEqual({ [A]: 0, [B]: 50, [C]: 50 });
    const onKimi = engineSubject(env({ config: config([GROUP, TAIL], "opencode-go/kimi"), limits: scoped }), "opencode").startPick;
    // B does not serve kimi: it is no candidate; A's glm-5 window is not kimi's.
    expect(onKimi!.candidates.map((candidate) => candidate.account).sort()).toEqual([A, C]);
    expect(onKimi!.candidates.every((candidate) => candidate.weight === 90 || candidate.weight === 50)).toBe(true);
  });

  it("alternates in the smooth order once starts are charged, as the Claude group does", async () => {
    const { recordAccountStart } = await import("../fallback-account-pick.js");
    const limits = { [A]: used(40), [B]: used(60), [C]: used(100) };
    const picks: string[] = [];
    for (let start = 0; start < 5; start++) {
      const pick = pickOf({ limits })!;
      picks.push(pick.picked);
      recordAccountStart(pick);
    }
    expect(picks).toEqual([A, B, A, B, A]);
  });

  it("is an employee subject's own: its model's provider is the own account", () => {
    const employee = worker([GROUP, TAIL], "opencode-go-b/glm-5");
    const subject = employeeSubject(env(), employee, { scoped: false, remote: false });
    expect(subject.source).toBe("employee");
    expect(subject.startPick).toMatchObject({ source: "employee", groupIndex: 0 });
    expect(subject.startPick!.candidates.map((candidate) => candidate.account).sort()).toEqual([A, B, C]);
    // An opencode employee with no model of its own runs the engine's, whose provider is the built-in account.
    const modelless = employeeSubject(env(), { ...worker([GROUP, TAIL]), model: undefined } as Employee, { scoped: false, remote: false });
    expect(modelless.startPick).toBeDefined();
  });
});

describe("where there is no home group", () => {
  it("has no pick when the own model's provider is no declared account", () => {
    expect(engineSubject(env({ config: config([GROUP, TAIL], "opencode/big-pickle") }), "opencode").startPick).toBeUndefined();
  });

  it("has no pick when the group is not the first entry, holds no own account, or there is none", () => {
    expect(pickOf({ config: config([TAIL, GROUP]) })).toBeUndefined();
    expect(pickOf({ config: config([{ group: [{ engine: "opencode", profile: "go-b" }, { engine: "opencode", profile: "go-c" }] }, TAIL]) })).toBeUndefined();
    expect(pickOf({ config: config([TAIL]) })).toBeUndefined();
    expect(pickOf({ config: config([]) })).toBeUndefined();
  });

  it("has no pick for a subject that is not on opencode, and the Claude subject's chain is untouched by an opencode group elsewhere", () => {
    const claude = engineSubject(env(), "claude");
    expect(claude.startPick).toBeUndefined();
    expect(claude.effective).toEqual([]);
  });

  it("resolves a chain with no group byte-identically: no group key, and the same links twice", () => {
    for (const chain of [[{ engine: "opencode", model: "opencode-go-b/glm-5" }, TAIL], ["claude"], []] as FallbackChainEntry[][]) {
      const first = resolve({ config: config(chain) });
      for (const link of first.links) expect(Object.keys(link)).not.toContain("group");
      expect(JSON.parse(JSON.stringify(resolve({ config: config(chain) })))).toEqual(JSON.parse(JSON.stringify(first)));
    }
  });
});

describe("opencodeHomeGroupOf", () => {
  const c = config();
  it("is the first entry's group when it holds the account the own model's provider names", () => {
    expect(opencodeHomeGroupOf(c, [GROUP, TAIL], "opencode-go-b/glm-5")).toMatchObject({ index: 0, written: GROUP, ownAccount: B });
    expect(opencodeHomeGroupOf(c, [GROUP], "opencode-go/kimi")!.members.map((member) => member.account)).toEqual([A, B, C]);
  });

  it("is undefined for a model with no declared account, a group that is not first, and a Claude group", () => {
    expect(opencodeHomeGroupOf(c, [GROUP], "openrouter/x")).toBeUndefined();
    expect(opencodeHomeGroupOf(c, [GROUP], undefined)).toBeUndefined();
    expect(opencodeHomeGroupOf(c, [TAIL, GROUP], "opencode-go/glm-5")).toBeUndefined();
    expect(opencodeHomeGroupOf(c, [{ group: [{ engine: "claude" }, { engine: "claude", profile: "x" }] }], "opencode-go/glm-5")).toBeUndefined();
  });
});
