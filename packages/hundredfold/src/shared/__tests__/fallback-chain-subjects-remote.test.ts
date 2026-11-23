import { describe, expect, it, vi } from "vitest";
import type { UsageSample } from "../claude-usage-history.js";
import type { FallbackWrittenEntry } from "../fallback-chain-wire.js";
import type { Employee, HundredfoldConfig, ModelRegistry } from "../types.js";

/**
 * A remote employee whose chain opens with a group holding its own login gets a start pick in `GET /api/fallback-chains`,
 * and it is the pick a new session of that employee is pinned to: the subject and `pinAccountAtCreation` resolve the same
 * home group (engine mode, the member naming no profile is the employee's own login on its host) over the same readings.
 */

function entry(name: string): ModelRegistry[string] {
  return { name, available: true, defaultModel: "opus", effortMechanism: "none" as const, models: [{ id: "opus", label: "opus", supportsEffort: false, effortLevels: [] }] };
}
const registry = { claude: entry("claude"), opencode: entry("opencode") } as unknown as ModelRegistry;

vi.mock("../models.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../models.js")>()), getModelRegistry: () => registry }));

const { employeeSubject, fallbackChainsResponse } = await import("../fallback-chain-subjects.js");
const { pinAccountAtCreation } = await import("../../sessions/account-pin.js");
const { remoteClaudeAccountKey } = await import("../engine-account.js");

const now = new Date("2026-11-20T12:00:00.000Z");
const HOUR = 3600_000;
const HOST = { remoteHost: "build-host", remoteUser: "me" };
const OWN_DIR = "/home/me/.claude-own";
const SPARE_DIR = "/home/me/.claude-spare";
const OTHER_DIR = "/home/other/.claude-other";
const OWN = remoteClaudeAccountKey(HOST, OWN_DIR);
const SPARE = remoteClaudeAccountKey(HOST, SPARE_DIR);
const OTHER = remoteClaudeAccountKey({ remoteHost: "other-host", remoteUser: "other" }, OTHER_DIR);

const GROUP = { group: [{ engine: "claude" }, { engine: "claude", profile: "spare" }, { engine: "claude", profile: "other" }] };

const config = {
  engines: {
    default: "claude",
    claude: {
      bin: "claude", model: "opus",
      accounts: { spare: { ...HOST, configDir: SPARE_DIR }, other: { remoteHost: "other-host", remoteUser: "other", configDir: OTHER_DIR } },
    },
  },
} as unknown as HundredfoldConfig;

function worker(fallback?: FallbackWrittenEntry[]): Employee {
  return {
    name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "claude", model: "opus", persona: "p",
    ...HOST, remoteCwd: "/srv/work/dev", remoteClaudeConfigDir: OWN_DIR, ...(fallback ? { fallback } : {}),
  };
}

const used = (percent: number): UsageSample => ({
  at: now.getTime() - 60_000,
  windows: [{ name: "5h", usedPercent: percent, resetsAt: Math.floor((now.getTime() + 3 * HOUR) / 1000) }],
});

const SCOPE = { scoped: false, remote: true, host: "me@build-host" };

describe("a remote employee's start pick", () => {
  it.each([
    ["the spare login has more headroom", { [OWN]: used(80), [SPARE]: used(10) }, SPARE],
    ["its own login has more headroom", { [OWN]: used(5), [SPARE]: used(90) }, OWN],
  ])("is reported when %s, and matches the pin a new session gets", (_, limits, expected) => {
    const employee = worker([GROUP]);
    const subject = employeeSubject({ config, registry, health: {}, limits, now }, employee, SCOPE);
    expect(subject.startPick).toMatchObject({ trigger: "start", source: "employee", groupIndex: 0, picked: expected });
    // A member on another user@host is no candidate: its profile is not a directory on this employee's host.
    expect(subject.startPick!.candidates.map((candidate) => candidate.account).sort()).toEqual([OWN, SPARE].sort());
    expect(subject.effective.find((link) => link.account === OTHER)?.skip).toBe("remote");

    const pin = pinAccountAtCreation({ config, employee, engine: "claude", model: "opus", now, inputs: { health: {}, limits } });
    const { trigger: _trigger, ...pick } = pin.accountPick!;
    const { trigger: _subjectTrigger, ...reported } = subject.startPick!;
    expect(reported).toEqual(pick);
    expect(pin.remoteAccountPin ?? null).toEqual(expected === SPARE ? { account: SPARE, configDir: SPARE_DIR } : null);
  });

  it("is reported for an inherited engine chain too, and in the whole response", () => {
    const withEngineChain = { ...config, engines: { ...config.engines, claude: { ...config.engines.claude, fallback: [GROUP] } } } as unknown as HundredfoldConfig;
    const limits = { [OWN]: used(80), [SPARE]: used(10) };
    const response = fallbackChainsResponse({ config: withEngineChain, registry, health: {}, limits, now }, { employee: worker(), scope: SCOPE });
    const subject = response.subjects.find((candidate) => candidate.kind === "employee");
    expect(subject?.startPick).toMatchObject({ source: "engine", picked: SPARE });
  });

  it("is absent when its own login is not in the head group", () => {
    const limits = { [OWN]: used(80), [SPARE]: used(10) };
    const subject = employeeSubject({ config, registry, health: {}, limits, now }, worker([{ group: [{ engine: "claude", profile: "spare" }, { engine: "claude", profile: "other" }] }]), SCOPE);
    expect(subject).not.toHaveProperty("startPick");
  });
});
