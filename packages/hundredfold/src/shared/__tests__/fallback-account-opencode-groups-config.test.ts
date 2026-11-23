import { describe, expect, it } from "vitest";
import { validateConfigShape } from "../config.js";
import { employeeFallbackProblems, employeeFallbackUpdate, loadEmployeeFallback, storedFallbackProblems } from "../employee-fallback.js";
import { duplicateProblemsByChain, groupCount, groupProblemsByChain } from "../fallback-chain-load.js";
import { fallbackChainProblems, fallbackGroupOf, type FallbackChainContext } from "../fallback-chain-wire.js";
import type { HundredfoldConfig } from "../types.js";

/** opencode account groups in config: the sentences, where such a group may be written, and how it loads. */

const MIXED = "a group's members all run on one engine";
const NO_PROFILE = "an opencode group member names its account with profile";
const WRONG_PLACE = "an opencode group balances an opencode session's own model; put it in an opencode employee's chain or engines.opencode.fallback";

const ctx = (extra: Partial<FallbackChainContext> = {}): FallbackChainContext => ({
  engines: ["claude", "codex", "opencode"],
  profiles: new Set(["work"]),
  opencodeProfiles: new Set(["go-a", "go-b", "go-c"]),
  ownEngine: "opencode",
  ...extra,
});
const check = (chain: unknown, extra?: Partial<FallbackChainContext>): string[] => fallbackChainProblems("fallback", chain, ctx(extra));

const GO_A = { engine: "opencode", profile: "go-a" };
const GO_B = { engine: "opencode", profile: "go-b" };
const GO_C = { engine: "opencode", profile: "go-c" };
const WORK = { engine: "claude", profile: "work" };

describe("the sentences of an opencode group", () => {
  it("accepts two or more distinct declared accounts, beside other entries", () => {
    expect(check([{ group: [GO_A, GO_B] }, { engine: "claude" }])).toEqual([]);
    expect(check([{ group: [GO_A, GO_B, GO_C] }, { engine: "opencode", model: "opencode-go-b/glm-5" }])).toEqual([]);
  });

  it("reads such a group whole", () => {
    expect(fallbackGroupOf({ group: [GO_A, GO_B] })).toEqual({ group: [GO_A, GO_B] });
  });

  it("refuses a group that mixes engines, with no other sentence for its members", () => {
    expect(check([{ group: [GO_A, WORK] }])).toEqual([`fallback[0].group: ${MIXED}`]);
    expect(check([{ group: [WORK, { engine: "opencode" }] }])).toEqual([`fallback[0].group: ${MIXED}`]);
    expect(check([{ group: [GO_A, { engine: "codex" }] }])).toEqual([`fallback[0].group: ${MIXED}`]);
  });

  it("refuses an opencode member with no profile", () => {
    expect(check([{ group: [GO_A, { engine: "opencode" }] }])).toEqual([`fallback[0].group[1]: ${NO_PROFILE}`]);
    expect(check([{ group: [{ engine: "opencode", model: "opencode-go/glm-5" }, GO_B] }])).toEqual([`fallback[0].group[0]: ${NO_PROFILE}`]);
  });

  it("refuses a member that names a model, an account that is not declared, and a repeat", () => {
    expect(check([{ group: [GO_A, { ...GO_B, model: "opencode-go-b/glm-5" }] }])).toEqual(["fallback[0].group[1]: a group member is an account, so it names no model"]);
    expect(check([{ group: [GO_A, { engine: "opencode", profile: "ghost" }] }])).toEqual(['fallback[0].group[1]: profile "ghost" names no account under engines.opencode.accounts']);
    expect(check([{ group: [GO_A, GO_A] }])).toEqual(["fallback[0].group[1] (opencode · go-a) repeats an earlier member of this group: list each account once"]);
  });

  it("keeps the size, nesting and string rules", () => {
    expect(check([{ group: [GO_A] }])).toEqual(["fallback[0].group needs at least two accounts to balance between"]);
    expect(check([{ group: [GO_A, { group: [GO_B, GO_C] }] }])).toEqual(["fallback[0].group[1]: a group cannot hold another group"]);
    expect(check([{ group: [GO_A, "opencode"] }])).toEqual(["fallback[0].group[1] must be a mapping with engine claude and an optional profile, not a string"]);
  });

  it("does not check the account names when it is not given them", () => {
    expect(check([{ group: [GO_A, { engine: "opencode", profile: "ghost" }] }], { opencodeProfiles: undefined })).toEqual([]);
  });

  it("refuses an opencode group in a chain whose own target is not on opencode, and only that sentence", () => {
    expect(check([{ group: [GO_A, GO_B] }], { ownEngine: "claude" })).toEqual([`fallback[0].group: ${WRONG_PLACE}`]);
    expect(check([{ group: [GO_A, GO_B] }], { ownEngine: undefined, self: { engine: "codex" } })).toEqual([`fallback[0].group: ${WRONG_PLACE}`]);
    expect(check([{ group: [GO_A, GO_B] }], { ownEngine: undefined, self: { engine: "claude", profile: "work" } })).toEqual([`fallback[0].group: ${WRONG_PLACE}`]);
    // Where the own engine is not known (the editor with no subject), only the shape is judged.
    expect(check([{ group: [GO_A, GO_B] }], { ownEngine: undefined })).toEqual([]);
  });

  it("leaves a Claude group valid wherever it was, and a profile on a standalone opencode link refused", () => {
    expect(check([{ group: [WORK, { engine: "claude" }] }], { ownEngine: "codex" })).toEqual([]);
    expect(check([{ engine: "opencode", profile: "go-a" }])).toEqual(["fallback[0]: only a claude target takes a profile"]);
  });

  it("counts a member as a link for the duplicate rule", () => {
    expect(check([{ group: [GO_A, GO_B] }, { group: [GO_B, GO_C] }])).toEqual([
      "fallback[1].group[0] duplicates fallback[0].group[1] (opencode · go-b): a chain tries each target once, so list it once",
    ]);
  });

  it("no longer says a group holds Claude accounts only", () => {
    const all = [...check([{ group: [GO_A, WORK] }]), ...check([{ group: [{ engine: "codex" }, { engine: "pi" }] }]), ...check([{ group: [GO_A, GO_B] }], { ownEngine: "claude" })];
    expect(all.join(";")).not.toContain("Claude accounts only");
  });
});

describe("where an opencode group may be written", () => {
  const ACCOUNTS = { "go-a": { provider: "opencode-go" }, "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "GO_B_KEY" } };
  const GROUP = { group: [GO_A, GO_B] };
  const shape = (opencode: Record<string, unknown>, claude: Record<string, unknown> = {}): string[] =>
    validateConfigShape({ engines: { default: "opencode", claude: { bin: "claude", model: "opus", ...claude }, opencode: { bin: "opencode", model: "opencode-go/glm-5", accounts: ACCOUNTS, ...opencode } } });

  it("engines.opencode.fallback loads with a group", () => {
    expect(shape({ fallback: [GROUP, { engine: "claude" }] })).toEqual([]);
  });

  it("refuses a group naming an undeclared account, and one with no profile, in engines.opencode.fallback", () => {
    expect(shape({ fallback: [{ group: [GO_A, { engine: "opencode", profile: "ghost" }] }] })).toEqual(['engines.opencode.fallback[0].group[1]: profile "ghost" names no account under engines.opencode.accounts']);
    expect(shape({ fallback: [{ group: [GO_A, { engine: "opencode" }] }] })).toEqual([`engines.opencode.fallback[0].group[1]: ${NO_PROFILE}`]);
  });

  it("refuses it in engines.claude.fallback, in a Claude account's chain and in another engine's chain", () => {
    expect(shape({}, { fallback: [GROUP] })).toEqual([`engines.claude.fallback[0].group: ${WRONG_PLACE}`]);
    expect(shape({}, { accounts: { work: { configDir: "/srv/operator/.claude-work", fallback: [GROUP] } } })).toEqual([`engines.claude.accounts.work.fallback[0].group: ${WRONG_PLACE}`]);
    const codex = validateConfigShape({ engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "m", fallback: [GROUP] }, opencode: { bin: "opencode", model: "opencode-go/glm-5", accounts: ACCOUNTS } } });
    expect(codex).toEqual([`engines.codex.fallback[0].group: ${WRONG_PLACE}`]);
  });

  it("reports group problems by chain for doctor, and counts the groups", () => {
    const engines = { opencode: { accounts: ACCOUNTS, fallback: [{ group: [GO_A, { engine: "opencode" }] }] } };
    expect(groupProblemsByChain(engines)).toEqual({ "engines.opencode.fallback": [`engines.opencode.fallback[0].group[1]: ${NO_PROFILE}`] });
    expect(groupProblemsByChain({ opencode: { accounts: ACCOUNTS, fallback: [GROUP] }, claude: { fallback: [GROUP] } })).toEqual({
      "engines.opencode.fallback": [],
      "engines.claude.fallback": [`engines.claude.fallback[0].group: ${WRONG_PLACE}`],
    });
    expect(groupCount({ opencode: { accounts: ACCOUNTS, fallback: [GROUP, GO_A] } })).toBe(1);
    expect(duplicateProblemsByChain({ opencode: { accounts: ACCOUNTS, fallback: [GROUP, { group: [GO_B, GO_A] }] } })["engines.opencode.fallback"]).toHaveLength(2);
  });
});

describe("an opencode employee's chain", () => {
  const config = {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", accounts: { work: { configDir: "/srv/operator/.claude-work" } } },
      opencode: { bin: "opencode", model: "opencode-go/glm-5", accounts: { "go-a": { provider: "opencode-go" }, "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "GO_B_KEY" } } },
    },
  } as unknown as HundredfoldConfig;
  const onOpencode = { engine: "opencode", model: "opencode-go/glm-5" };
  const onClaude = { engine: "claude", model: "opus" };
  const chain = [{ group: [GO_A, GO_B] }, { engine: "claude" }];
  const bare = [{ group: [GO_A, GO_B] }];

  it("accepts an opencode group and keeps it whole on update", () => {
    expect(employeeFallbackProblems(config, onOpencode, chain)).toEqual([]);
    expect(employeeFallbackUpdate(config, onOpencode, chain)).toEqual({ ok: true, value: chain });
  });

  it("refuses the group on a Claude employee, an undeclared account and a missing profile, with the wire sentences", () => {
    expect(employeeFallbackProblems(config, onClaude, bare)).toEqual([`fallback[0].group: ${WRONG_PLACE}`]);
    expect(employeeFallbackProblems(config, onOpencode, [{ group: [GO_A, { engine: "opencode", profile: "ghost" }] }])).toEqual(['fallback[0].group[1]: profile "ghost" names no account under engines.opencode.accounts']);
    expect(employeeFallbackProblems(config, onOpencode, [{ group: [GO_A, { engine: "opencode" }] }])).toEqual([`fallback[0].group[1]: ${NO_PROFILE}`]);
    expect(employeeFallbackProblems(config, onOpencode, [{ group: [GO_A, WORK] }])).toEqual([`fallback[0].group: ${MIXED}`]);
  });

  it("checks the shapes alone when there is no config to read account names from, and still refuses the wrong place", () => {
    expect(employeeFallbackProblems(undefined, onOpencode, chain)).toEqual([]);
    expect(employeeFallbackProblems(undefined, onClaude, bare)).toEqual([`fallback[0].group: ${WRONG_PLACE}`]);
  });

  it("loads from an employee file whole, and an invalid one is left out with its problems", () => {
    expect(loadEmployeeFallback(chain, { ...onOpencode, name: "dev" }, config, "dev.yaml")).toEqual({ fallback: chain });
    const bad = loadEmployeeFallback(bare, { ...onClaude, name: "dev" }, config, "dev.yaml");
    expect(bad.fallback).toBeUndefined();
    expect(bad.problems).toEqual([`fallback[0].group: ${WRONG_PLACE}`]);
  });

  it("rechecks a stored opencode group when the employee moves to another engine", () => {
    const stored = { ...onOpencode, fallback: [{ group: [GO_A, GO_B] }] };
    expect(storedFallbackProblems(config, stored, { engine: "opencode", model: "opencode-go-b/glm-5" })).toEqual([]);
    expect(storedFallbackProblems(config, stored, { engine: "claude", model: "opus" })).toEqual([`fallback[0].group: ${WRONG_PLACE}`]);
  });
});
