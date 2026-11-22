import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccountCredits } from "../../shared/fallback-account-pick.js";
import type { UsageSample } from "../../shared/claude-usage-history.js";
import type { FallbackChainEntry } from "../../shared/fallback-chain-wire.js";
import type { Employee, HundredfoldConfig } from "../../shared/types.js";

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
const installed = vi.hoisted(() => ({ on: (_host: string, _engine: string): boolean | undefined => undefined }));
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: (host: string, engine: string) => installed.on(host, engine),
}));
const { chargeAccountStart, metaWithAccountPick, pinAccountAtCreation } = await import("../account-pin.js");

/**
 * Where a new opencode session's account is chosen. The account is the provider the model is spelled on, so a pick of another
 * member is the session's `model` re-spelled on that member's provider; a pick of the session's own account changes nothing.
 */

const NOW = new Date("2026-11-20T12:00:00.000Z");
const HOUR = 3600_000;

const A = "opencode/opencode-go";
const B = "opencode/opencode-go-b";
const C = "opencode/opencode-go-c";

const GROUP = { group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }, { engine: "opencode", profile: "go-c" }] };
const PAIR = { group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }] };
const TAIL = { engine: "claude" };

function config(fallback: FallbackChainEntry[] = [GROUP, TAIL]): HundredfoldConfig {
  return {
    engines: {
      default: "opencode",
      claude: { bin: "claude", model: "opus" },
      opencode: {
        bin: "opencode", model: "opencode-go/glm-5", fallback,
        accounts: {
          "go-a": { provider: "opencode-go" },
          "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY" },
          "go-c": { provider: "opencode-go-c", base: "opencode-go", keyEnv: "OPENCODE_GO_C_API_KEY" },
        },
      },
    },
    // go-b serves glm-5 only; go-c serves glm-5 and kimi; the built-in account serves both.
    models: {
      claude: { default: "opus", models: [{ id: "opus" }] },
      opencode: {
        default: "opencode-go/glm-5",
        models: ["opencode-go/glm-5", "opencode-go/kimi", "opencode-go-b/glm-5", "opencode-go-c/glm-5", "opencode-go-c/kimi"].map((id) => ({ id })),
      },
    },
  } as unknown as HundredfoldConfig;
}

const employee = (extra: Partial<Employee> = {}): Employee =>
  ({ name: "dev", displayName: "Dev", department: "platform", rank: "employee", engine: "opencode", model: "opencode-go/glm-5", persona: "p", ...extra } as Employee);

const used = (percent: number): UsageSample => ({ at: NOW.getTime() - 60_000, windows: [{ name: "5h", usedPercent: percent, resetsAt: Math.floor((NOW.getTime() + 3 * HOUR) / 1000) }] });
const readings = (byAccount: Record<string, number>) => Object.fromEntries(Object.entries(byAccount).map(([account, percent]) => [account, used(percent)]));
const spent = (hours: number) => ({ state: "exhausted" as const, until: new Date(NOW.getTime() + hours * HOUR).toISOString(), recheckAt: new Date(NOW.getTime() + hours * HOUR).toISOString() });

const LIMITS = readings({ [A]: 80, [B]: 20, [C]: 70 });
const pin = (over: Partial<Parameters<typeof pinAccountAtCreation>[0]> = {}) =>
  pinAccountAtCreation({ config: config(), employee: employee(), engine: "opencode", model: "opencode-go/glm-5", now: NOW, inputs: { health: {}, limits: LIMITS }, ...over });

beforeEach(() => resetAccountCredits());
afterEach(() => {
  resetAccountCredits();
  installed.on = () => undefined;
});

describe("pinAccountAtCreation for opencode: when it balances", () => {
  it("picks the member with the most headroom and re-spells the model on its provider", () => {
    const result = pin();
    expect(result.accountPick).toMatchObject({ trigger: "start", source: "engine", groupIndex: 0, picked: B, reason: "weighted" });
    expect(result.accountPick!.candidates.map((candidate) => candidate.account)).toEqual([B, C, A]);
    expect(result.model).toBe("opencode-go-b/glm-5");
    expect(result).not.toHaveProperty("claudeConfigDir");
  });

  it("leaves the model as requested when the pick is the session's own account, but records the pick", () => {
    const result = pin({ inputs: { health: {}, limits: readings({ [A]: 5, [B]: 90, [C]: 90 }) } });
    expect(result.accountPick).toMatchObject({ picked: A });
    expect(result).not.toHaveProperty("model");
  });

  it("balances a session of no employee over the engine's own model", () => {
    const result = pin({ employee: undefined, model: undefined });
    expect(result.accountPick).toMatchObject({ picked: B });
    expect(result.model).toBe("opencode-go-b/glm-5");
  });

  it("uses the employee's own chain and names it as the pick's source", () => {
    const result = pin({ employee: employee({ fallback: [PAIR] as never }) });
    expect(result.accountPick).toMatchObject({ source: "employee", picked: B });
    expect(result.accountPick!.candidates.map((candidate) => candidate.account).sort()).toEqual([A, B].sort());
  });

  it("balances a model requested on the subject's own provider, across the members that serve its key", () => {
    // go-b does not serve kimi: only the built-in account and go-c are candidates.
    const result = pin({ model: "opencode-go/kimi" });
    expect(result.accountPick!.candidates.map((candidate) => candidate.account).sort()).toEqual([A, C].sort());
    expect(result.accountPick).toMatchObject({ picked: C });
    expect(result.model).toBe("opencode-go-c/kimi");
  });

  it.each([
    ["a session on an engine nothing balances", { engine: "codex" }],
    ["a model on another account's provider: a chosen account", { model: "opencode-go-b/glm-5" }],
    ["a chain with no group", { config: config([TAIL]) }],
    ["a group that does not open the chain", { config: config([TAIL, GROUP]) }],
    ["a group that holds none of the session's accounts", { config: config([{ group: [{ engine: "opencode", profile: "go-b" }, { engine: "opencode", profile: "go-c" }] }, TAIL]) }],
  ] as const)("balances nothing for %s", (_label, over) => {
    expect(pin(over as never)).toEqual({});
  });

  it("does not balance a Claude session over an opencode group", () => {
    expect(pin({ engine: "claude", model: "opus", employee: employee({ engine: "claude", model: "opus" }) })).toEqual({});
  });
});

describe("pinAccountAtCreation for opencode: a switch", () => {
  it("puts the model back on the own account's provider when the pick is the own account", () => {
    const result = pin({ trigger: "switch", model: "opencode-go-b/glm-5", employee: undefined, inputs: { health: {}, limits: readings({ [A]: 5, [B]: 90, [C]: 90 }) } });
    // A model on another provider is a chosen account: nothing is balanced, so nothing is put back.
    expect(result).toEqual({});
    const own = pin({ trigger: "switch", model: "opencode-go/glm-5", inputs: { health: {}, limits: readings({ [A]: 5, [B]: 90, [C]: 90 }) } });
    expect(own.accountPick).toMatchObject({ trigger: "switch", picked: A });
    expect(own.model).toBe("opencode-go/glm-5");
  });

  it("pins the model to the picked member", () => {
    const result = pin({ trigger: "switch" });
    expect(result.accountPick).toMatchObject({ trigger: "switch", picked: B });
    expect(result.model).toBe("opencode-go-b/glm-5");
  });
});

describe("pinAccountAtCreation for opencode: the rotation", () => {
  it("returns the same pick however often it is asked", () => {
    const first = pin().accountPick!;
    for (let i = 0; i < 5; i++) expect(pin().accountPick!.picked).toBe(first.picked);
  });

  it("is spread by headroom: 60 and 40 headroom give six starts and four over ten", () => {
    const two = config([PAIR, TAIL]);
    const limits = readings({ [A]: 40, [B]: 60 });
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      const result = pin({ config: two, inputs: { health: {}, limits } });
      chargeAccountStart(result);
      counts[result.accountPick!.picked] = (counts[result.accountPick!.picked] ?? 0) + 1;
    }
    expect(counts).toEqual({ [A]: 6, [B]: 4 });
  });

  it("splits a burst of starts across an even group, one start to each member", () => {
    const limits = readings({ [A]: 50, [B]: 50, [C]: 50 });
    const picked = Array.from({ length: 3 }, () => {
      const result = pin({ inputs: { health: {}, limits } });
      chargeAccountStart(result);
      return result.accountPick!.picked;
    });
    expect(new Set(picked)).toEqual(new Set([A, B, C]));
  });

  it("charges nothing for a pin without a pick, and nothing for a pick that is not charged", () => {
    chargeAccountStart({});
    const before = pin().accountPick!;
    expect(pin().accountPick).toEqual(before);
  });

  it("walks to another member when the best one is at its limit", () => {
    const result = pin({ inputs: { health: { [B]: spent(2) }, limits: LIMITS } });
    expect(result.accountPick).toMatchObject({ picked: C });
    expect(result.model).toBe("opencode-go-c/glm-5");
  });

  it("pins the member that reopens first when every member is at its limit, and says so", () => {
    const result = pin({ inputs: { health: { [A]: spent(5), [B]: spent(2), [C]: spent(9) }, limits: LIMITS } });
    expect(result.accountPick).toMatchObject({ reason: "all-exhausted", picked: B });
    expect(result.model).toBe("opencode-go-b/glm-5");
  });
});

describe("pinAccountAtCreation for opencode: a remote employee", () => {
  const remote = employee({ remoteHost: "build-host", remoteUser: "me" } as Partial<Employee>);

  it("is balanced like a gateway session, and judged by the records of its own host", () => {
    // go-b's exhaustion was recorded for another host: it says nothing about this one, so go-b is still the best member.
    const health = { [B]: { ...spent(4), host: "other-host" } };
    const result = pin({ employee: remote, inputs: { health, limits: LIMITS } });
    expect(result.accountPick).toMatchObject({ picked: B });
    expect(result.model).toBe("opencode-go-b/glm-5");
    expect(result).not.toHaveProperty("remoteAccountPin");

    // The same record for its own host does count.
    const own = pin({ employee: remote, inputs: { health: { [B]: { ...spent(4), host: "build-host" } }, limits: LIMITS } });
    expect(own.accountPick).toMatchObject({ picked: C });
  });

  it("offers only the members its host serves: a host without opencode leaves the own account, one without another engine still balances", () => {
    installed.on = (host, engine) => (host.endsWith("build-host") ? engine !== "opencode" : undefined);
    const none = pin({ employee: remote });
    expect(none.accountPick).toMatchObject({ picked: A, reason: "only-candidate" });
    expect(none.accountPick!.candidates.map((candidate) => candidate.account)).toEqual([A]);
    expect(none).not.toHaveProperty("model");

    installed.on = (host, engine) => (host.endsWith("build-host") ? engine !== "claude" : undefined);
    const served = pin({ employee: remote });
    expect(served.accountPick).toMatchObject({ picked: B });
    expect(served.model).toBe("opencode-go-b/glm-5");

    // A gateway session is judged by this gateway's engines, whatever a host says.
    installed.on = () => false;
    expect(pin().accountPick).toMatchObject({ picked: B });
  });
});

describe("metaWithAccountPick for an opencode pick", () => {
  it("records the pick in the transport meta", () => {
    const result = pin();
    expect(metaWithAccountPick({ keep: true }, result)).toEqual({ keep: true, accountPick: result.accountPick });
  });
});
