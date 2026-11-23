import { describe, expect, it } from "vitest";
import { deepMerge } from "../../gateway/config-payload.js";
import { validateConfigShape } from "../config.js";
import { employeeFallbackProblems, employeeFallbackUpdate, loadEmployeeFallback, storedFallbackProblems } from "../employee-fallback.js";
import { duplicateProblemsByChain, groupCount, groupProblemsByChain, unchangedDuplicates } from "../fallback-chain-load.js";
import { fallbackChainProblems, fallbackGroupOf, fallbackLinkOf, type FallbackChainContext } from "../fallback-chain-wire.js";
import { configuredEngineNames } from "../engine-limits-configured.js";
import type { HundredfoldConfig } from "../types.js";

/** Balanced account groups in config: the validation sentences, where a group may be written, and how it loads and saves. */

const ctx = (self?: FallbackChainContext["self"]): FallbackChainContext => ({ engines: ["claude", "codex", "opencode"], profiles: new Set(["work", "spare", "third"]), self });
const check = (chain: unknown, self?: FallbackChainContext["self"]): string[] => fallbackChainProblems("fallback", chain, ctx(self));

const DEFAULT = { engine: "claude" };
const WORK = { engine: "claude", profile: "work" };
const SPARE = { engine: "claude", profile: "spare" };

describe("fallbackGroupOf", () => {
  it("reads a group's members in written order and nothing else as a group", () => {
    expect(fallbackGroupOf({ group: [DEFAULT, WORK] })).toEqual({ group: [DEFAULT, WORK] });
    expect(fallbackGroupOf(WORK)).toBeNull();
    expect(fallbackGroupOf("claude:work")).toBeNull();
    expect(fallbackGroupOf({ group: "claude" })).toBeNull();
    expect(fallbackGroupOf(null)).toBeNull();
  });

  it("leaves out a member that is not an object link, and fallbackLinkOf does not read a group as a link", () => {
    expect(fallbackGroupOf({ group: [WORK, "claude:spare", { group: [SPARE] }, SPARE] })).toEqual({ group: [WORK, SPARE] });
    expect(fallbackLinkOf({ group: [WORK, SPARE] })).toBeNull();
  });
});

describe("the sentences of a group", () => {
  it("accepts two or more distinct Claude accounts, the default login included, beside other entries", () => {
    expect(check([{ group: [DEFAULT, WORK, SPARE] }, { engine: "opencode", model: "opencode-go/glm" }, { engine: "claude", profile: "third" }])).toEqual([]);
    expect(check([{ group: [WORK, SPARE] }], { engine: "claude" })).toEqual([]);
  });

  it("refuses fewer than two members", () => {
    expect(check([{ group: [WORK] }])).toEqual(["fallback[0].group needs at least two accounts to balance between"]);
    expect(check([{ group: [] }])).toEqual(["fallback[0].group needs at least two accounts to balance between"]);
  });

  it("refuses a group that is not a list, and keys beside group", () => {
    expect(check([{ group: "claude" }])).toEqual(["fallback[0].group must be a list of Claude accounts"]);
    expect(check([{ group: [WORK, SPARE], engine: "claude", model: "x" }])).toEqual(['fallback[0] holds only "group"; remove "engine", "model"']);
  });

  it("refuses a group whose members are not on one engine, and an engine a group cannot hold", () => {
    expect(check([{ group: [WORK, { engine: "opencode", model: "opencode-go/glm" }] }])).toEqual(["fallback[0].group: a group's members all run on one engine"]);
    expect(check([{ group: [{ engine: "codex" }, WORK] }])).toEqual(["fallback[0].group: a group's members all run on one engine"]);
    expect(check([{ group: [{ engine: "codex" }, { engine: "pi" }] }])).toEqual(["fallback[0].group: a group's members all run on one engine"]);
    expect(check([{ group: [{ engine: "codex" }, { engine: "codex", model: "x" }] }])).toEqual(["fallback[0].group: a group holds Claude or opencode accounts only"]);
  });

  it("refuses a member that names a model", () => {
    expect(check([{ group: [WORK, { engine: "claude", profile: "spare", model: "sonnet" }] }])).toEqual(["fallback[0].group[1]: a group member is an account, so it names no model"]);
  });

  it("refuses a repeated member, spelled the same either way", () => {
    expect(check([{ group: [WORK, SPARE, WORK] }])).toEqual(["fallback[0].group[2] (claude · work) repeats an earlier member of this group: list each account once"]);
  });

  it("refuses an undeclared profile, as for any link", () => {
    expect(check([{ group: [WORK, { engine: "claude", profile: "ghost" }] }])).toEqual(['fallback[0].group[1]: profile "ghost" names no account under engines.claude.accounts']);
  });

  it("refuses strings and nested groups as members", () => {
    expect(check([{ group: [WORK, "claude:spare"] }])).toEqual(["fallback[0].group[1] must be a mapping with engine claude and an optional profile, not a string"]);
    expect(check([{ group: [WORK, { group: [SPARE, DEFAULT] }] }])).toEqual(["fallback[0].group[1]: a group cannot hold another group"]);
    expect(check([{ group: [WORK, 3] }])).toEqual(["fallback[0].group[1] must be a mapping with engine claude and an optional profile"]);
  });

  it("counts a member as a link for the duplicate rule: a standalone link repeating it is the duplicate", () => {
    expect(check([{ group: [WORK, SPARE] }, { engine: "claude", profile: "work" }])).toEqual([
      "fallback[1] duplicates fallback[0].group[0] (claude · work): a chain tries each target once, so list it once",
    ]);
    expect(check([{ engine: "claude", profile: "spare" }, { group: [WORK, SPARE] }])).toEqual([
      "fallback[1].group[1] duplicates fallback[0] (claude · spare): a chain tries each target once, so list it once",
    ]);
    expect(check([{ group: [WORK, SPARE] }, { group: [SPARE, DEFAULT] }])).toEqual([
      "fallback[1].group[0] duplicates fallback[0].group[1] (claude · spare): a chain tries each target once, so list it once",
    ]);
  });

  it("tolerates those duplicates when asked to, as the loader does, and reports them to the callback", () => {
    const seen: Array<{ index: number; first: number }> = [];
    const problems = fallbackChainProblems("fallback", [{ group: [WORK, SPARE] }, WORK], { ...ctx(), onDuplicate: ({ index, first }) => { seen.push({ index, first }); return true; } });
    expect(problems).toEqual([]);
    expect(seen).toEqual([{ index: 1, first: 0 }]);
  });

  it("relaxes the self-link refusal for a member only: the own account may be in a group, a standalone link to it still may not", () => {
    expect(check([{ group: [DEFAULT, WORK] }], { engine: "claude" })).toEqual([]);
    expect(check([{ group: [{ engine: "claude", profile: "work" }, SPARE] }], { engine: "claude", profile: "work" })).toEqual([]);
    expect(check([DEFAULT], { engine: "claude" })).toEqual(["fallback[0] (claude) is the target this chain falls back from; give it another profile or model"]);
  });
});

describe("where a group may be written", () => {
  const ACCOUNTS = { work: { configDir: "/srv/operator/.claude-work" }, spare: { configDir: "/srv/operator/.claude-spare" } };
  const GROUP = { group: [DEFAULT, WORK, SPARE] };
  const shape = (claude: Record<string, unknown>): string[] => validateConfigShape({ engines: { default: "claude", claude: { bin: "claude", model: "opus", accounts: ACCOUNTS, ...claude } } });

  it("engines.claude.fallback and an account's fallback load with a group", () => {
    expect(shape({ fallback: [GROUP, { engine: "opencode", model: "opencode-go/glm" }] })).toEqual([]);
    expect(shape({ accounts: { work: { configDir: "/srv/operator/.claude-work", fallback: [{ group: [WORK, SPARE] }, "codex"] }, spare: ACCOUNTS.spare } })).toEqual([]);
  });

  it("refuses a malformed group in either place with the wire sentence", () => {
    expect(shape({ fallback: [{ group: [WORK] }] })).toEqual(["engines.claude.fallback[0].group needs at least two accounts to balance between"]);
    expect(shape({ accounts: { work: { configDir: "/srv/operator/.claude-work", fallback: [{ group: [WORK, { engine: "opencode" }] }] }, spare: ACCOUNTS.spare } }))
      .toEqual(["engines.claude.accounts.work.fallback[0].group: a group's members all run on one engine"]);
  });

  it("a duplicate with a standalone link loads (it is warned and de-duplicated) but is reported", () => {
    const engines = { claude: { accounts: ACCOUNTS, fallback: [GROUP, { engine: "claude", profile: "work" }] } };
    const tolerant = validateConfigShape({ engines: { default: "claude", claude: { bin: "claude", model: "opus", ...engines.claude } } }, { tolerateDuplicates: () => true });
    expect(tolerant).toEqual([]);
    // A write is refused with the sentence.
    expect(shape({ fallback: [GROUP, { engine: "claude", profile: "work" }] })).toEqual([
      "engines.claude.fallback[1] duplicates engines.claude.fallback[0].group[1] (claude · work): a chain tries each target once, so list it once",
    ]);
    expect(duplicateProblemsByChain(engines)["engines.claude.fallback"]).toEqual([
      "engines.claude.fallback[1] duplicates engines.claude.fallback[0].group[1] (claude · work): a chain tries each target once, so list it once",
    ]);
  });

  it("a save leaving a duplicated chain as the file has it is not blocked, one that changes it is", () => {
    const existing = { engines: { claude: { fallback: [GROUP, WORK] } } };
    const tolerated = unchangedDuplicates(existing);
    const dup = { where: "engines.claude.fallback", chain: [GROUP, WORK], index: 1, first: 0, problem: "x" };
    expect(tolerated(dup)).toBe(true);
    expect(tolerated({ ...dup, chain: [GROUP, WORK, SPARE] })).toBe(false);
  });

  it("reports group problems by chain for doctor, and counts the groups", () => {
    const engines = { claude: { accounts: ACCOUNTS, fallback: [{ group: [WORK] }], } };
    expect(groupProblemsByChain(engines)).toEqual({ "engines.claude.fallback": ["engines.claude.fallback[0].group needs at least two accounts to balance between"] });
    expect(groupProblemsByChain({ claude: { accounts: ACCOUNTS, fallback: [WORK] } })).toEqual({});
    expect(groupCount({ claude: { accounts: ACCOUNTS, fallback: [GROUP, WORK, { group: [WORK, SPARE] }] } })).toBe(2);
  });

  it("deepMerge writes a group as sent, never merging it into a stored entry", () => {
    const stored = { engines: { claude: { fallback: [{ engine: "claude", profile: "work" }, { engine: "claude", profile: "spare" }] } } };
    const sent = { engines: { claude: { fallback: [{ group: [DEFAULT, WORK, SPARE] }, { engine: "claude", profile: "spare", model: "sonnet" }] } } };
    expect(deepMerge(stored, sent)).toEqual(sent);
    const back = { engines: { claude: { fallback: [WORK, SPARE] } } };
    expect(deepMerge(sent, back)).toEqual(back);
  });

  it("an engine named only by a group member counts as configured", () => {
    const config = { engines: { default: "codex", codex: { bin: "codex", model: "m", fallback: [{ group: [WORK, SPARE] }] } } } as unknown as HundredfoldConfig;
    expect(configuredEngineNames(config).has("claude")).toBe(true);
  });
});

describe("an employee's chain", () => {
  const config = { engines: { default: "claude", claude: { bin: "claude", model: "opus", accounts: { work: { configDir: "/srv/operator/.claude-work" }, spare: { configDir: "/srv/operator/.claude-spare" } } } } } as unknown as HundredfoldConfig;
  const worker = { engine: "claude", model: "opus" };
  const onWork = { engine: "claude", model: "opus", claudeConfigDir: "/srv/operator/.claude-work" };

  it("accepts a group that lists the employee's own account, and keeps it whole on update", () => {
    const chain = [{ group: [DEFAULT, WORK, SPARE] }, { engine: "opencode", model: "opencode-go/glm" }];
    expect(employeeFallbackProblems(config, worker, chain)).toEqual([]);
    expect(employeeFallbackUpdate(config, worker, chain)).toEqual({ ok: true, value: chain });
    expect(employeeFallbackProblems(config, onWork, [{ group: [WORK, SPARE] }])).toEqual([]);
  });

  it("refuses the same things a config chain does, with fallback[i] paths", () => {
    expect(employeeFallbackProblems(config, worker, [{ group: [WORK] }])).toEqual(["fallback[0].group needs at least two accounts to balance between"]);
    expect(employeeFallbackProblems(config, worker, [{ group: [WORK, "claude:spare"] }])).toEqual(["fallback[0].group[1] must be a mapping with engine claude and an optional profile, not a string"]);
    expect(employeeFallbackUpdate(config, worker, [{ group: [WORK, WORK] }])).toMatchObject({ ok: false });
  });

  it("still refuses a standalone link equal to the own target and a repeat across a group and a link", () => {
    expect(employeeFallbackProblems(config, onWork, [{ group: [WORK, SPARE] }, WORK]).join(";")).toContain("fallback[1] duplicates fallback[0].group[0]");
    expect(employeeFallbackProblems(config, worker, [DEFAULT]).join(";")).toContain("is the target this chain falls back from");
  });

  it("loads a group chain from an employee file whole, and an invalid one is left out with its problems", () => {
    const good = [{ group: [DEFAULT, WORK] }, { engine: "codex", model: "gpt" }];
    expect(loadEmployeeFallback(good, { ...worker, name: "dev" }, config, "dev.yaml")).toEqual({ fallback: good });
    const bad = loadEmployeeFallback([{ group: [WORK] }], { ...worker, name: "dev" }, config, "dev.yaml");
    expect(bad.fallback).toBeUndefined();
    expect(bad.problems).toEqual(["fallback[0].group needs at least two accounts to balance between"]);
  });

  it("rechecks a stored group chain when the employee's target changes", () => {
    const stored = { ...worker, fallback: [{ group: [DEFAULT, WORK] }] };
    expect(storedFallbackProblems(config, stored, { engine: "claude", model: "sonnet" })).toEqual([]);
    // A group of Claude accounts is still valid on another engine's employee: it is a block of fallback links there.
    expect(storedFallbackProblems(config, stored, { engine: "codex", model: "gpt" })).toEqual([]);
    const withOwn = { ...worker, fallback: [{ group: [DEFAULT, WORK] }, { engine: "claude", profile: "spare" }] };
    expect(storedFallbackProblems(config, withOwn, { engine: "claude", model: "sonnet" })).toEqual([]);
  });
});
