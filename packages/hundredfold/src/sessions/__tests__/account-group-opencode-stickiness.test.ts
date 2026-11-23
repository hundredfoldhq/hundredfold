import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorMessage, connectorStub, eventually, scriptedEngine } from "./helpers/turn-parity-harness.js";
import { HOUR, MINUTE, START, answer, fallbackConfig, fallbackExpiryHarness, limitedUntil } from "./helpers/fallback-expiry-harness.js";
import type { EngineResult } from "../../shared/types.js";

/**
 * An opencode session the balancer pinned keeps its account, the way a Claude one does: over turns, a resume, a restart and
 * whatever its group's readings do meanwhile. The account is the provider its model is spelled on. A usage limit walks the
 * group's other members by headroom and then the rest of the chain, and the reset brings the session back to the account
 * it was pinned to.
 */

const { registry, healthPath, reset, settled, override } = await fallbackExpiryHarness("hundredfold-opencode-stickiness-");
const { SessionManager } = await import("../manager.js");
const { resetAccountCredits } = await import("../../shared/fallback-account-pick.js");

const LIMITS_DIR = path.join(path.dirname(path.dirname(healthPath)), "tmp", "engine-limits");

const A = "opencode/opencode-go";
const B = "opencode/opencode-go-b";
const C = "opencode/opencode-go-c";
const MODEL_A = "opencode-go/glm-5";
const MODEL_B = "opencode-go-b/glm-5";
const MODEL_C = "opencode-go-c/glm-5";

const worker = { name: "an-ocworker", engine: "opencode", model: MODEL_A, persona: "Opencode stickiness fixture" };

/** `used` percent in each account's 5h window, read fresh at the current (faked) time. */
function writeUsage(used: Record<string, number>): void {
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor((Date.now() + 24 * HOUR) / 1000);
  for (const [account, percent] of Object.entries(used)) {
    fs.writeFileSync(path.join(LIMITS_DIR, `opencode-usage-history.${encodeURIComponent(account)}.json`), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: percent, resetsAt: later }] }]));
  }
}

beforeEach(() => {
  reset();
  resetAccountCredits();
});
afterEach(() => vi.useRealTimers());

interface Run { model?: string }

/** A session manager over a scripted opencode (which records the model each run used) and a codex, with a group at the head of opencode's chain. */
function build(script: EngineResult[]) {
  const cfg = fallbackConfig() as any;
  cfg.engines.opencode = {
    bin: process.execPath, model: MODEL_A,
    accounts: {
      "go-a": { provider: "opencode-go" },
      "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY" },
      "go-c": { provider: "opencode-go-c", base: "opencode-go", keyEnv: "OPENCODE_GO_C_API_KEY" },
    },
    fallback: [{ group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }, { engine: "opencode", profile: "go-c" }] }, "codex"],
  };
  cfg.models.opencode = { default: MODEL_A, models: [MODEL_A, MODEL_B, MODEL_C].map((id) => ({ id })) };
  const opencode: any = scriptedEngine("opencode", script);
  const runs: Run[] = [];
  const run = opencode.run;
  opencode.run = async (opts: any) => {
    runs.push({ model: opts.model });
    return run(opts);
  };
  const codex: any = scriptedEngine("codex", [answer("codex answer", "codex-thread")]);
  const manager = new SessionManager(cfg, new Map([["opencode", opencode], ["codex", codex]]) as never, "opencode-stickiness-boot");
  return { manager, runs, codex };
}

async function turn(manager: InstanceType<typeof SessionManager>, key: string, text: string): Promise<string> {
  const answers = (id: string) => registry.getMessages(id).filter((m) => m.role === "assistant").length;
  const existing = registry.getSessionBySessionKey(key);
  const before = existing ? answers(existing.id) : 0;
  const routed = await manager.route(connectorMessage(key, text), connectorStub(), { employee: worker as never });
  const id = routed!.sessionId;
  await eventually(() => answers(id) > before && settled(id));
  return id;
}

const at = (ms: number) => vi.setSystemTime(new Date(START.getTime() + ms));
const pickOf = (id: string) => (registry.getSession(id)!.transportMeta as { accountPick?: { picked: string; reason: string } } | null)?.accountPick;
const modelOf = (id: string) => registry.getSession(id)!.model;
const answers = (count: number): EngineResult[] => Array.from({ length: count }, (_, n) => answer(`answer ${n}`, `thread-${n}`));

describe("an opencode session pinned to an account", () => {
  it("is pinned at its first turn to the account with the most headroom, and runs on its model", async () => {
    writeUsage({ [A]: 90, [B]: 40, [C]: 70 });
    const { manager, runs } = build(answers(1));
    const id = await turn(manager, "stub:oc-first", "one");
    expect(pickOf(id)).toMatchObject({ picked: B, reason: "weighted" });
    expect(modelOf(id)).toBe(MODEL_B);
    expect(runs[0]!.model).toBe(MODEL_B);
  }, 30_000);

  it("keeps it over many turns, a resume and a restart while another account's readings turn better", async () => {
    writeUsage({ [A]: 90, [B]: 40, [C]: 70 });
    const { manager, runs } = build(answers(8));
    const key = "stub:oc-sticky";
    const id = await turn(manager, key, "one");
    const first = pickOf(id);

    // The account it sits on is now nearly spent and another is nearly empty: nothing may move it.
    writeUsage({ [A]: 90, [B]: 97, [C]: 3 });
    for (const text of ["two", "three", "four"]) await turn(manager, key, text);
    expect(modelOf(id)).toBe(MODEL_B);
    expect(pickOf(id)).toEqual(first);

    // A restart: the row is recovered as interrupted and the next message resumes it.
    registry.updateSession(id, { status: "running" });
    registry.recoverStaleSessions();
    expect(registry.getSession(id)!.status).toBe("interrupted");
    await turn(manager, key, "five");
    await turn(manager, key, "six");
    expect(modelOf(id)).toBe(MODEL_B);
    expect(pickOf(id)).toEqual(first);
    expect(new Set(runs.map((run) => run.model))).toEqual(new Set([MODEL_B]));
    expect(runs).toHaveLength(6);
  }, 60_000);

  it("spreads a burst of starts across an even group and never alternates afterwards", async () => {
    writeUsage({ [A]: 50, [B]: 50, [C]: 50 });
    const { manager } = build(answers(12));
    const first = await turn(manager, "stub:oc-alt-1", "a");
    const second = await turn(manager, "stub:oc-alt-2", "b");
    const third = await turn(manager, "stub:oc-alt-3", "c");
    const homes = [first, second, third].map(modelOf);
    expect(new Set(homes)).toEqual(new Set([MODEL_A, MODEL_B, MODEL_C]));
    for (let round = 0; round < 3; round++) {
      await turn(manager, "stub:oc-alt-1", `again ${round}`);
      await turn(manager, "stub:oc-alt-2", `again ${round}`);
      await turn(manager, "stub:oc-alt-3", `again ${round}`);
    }
    expect([first, second, third].map(modelOf)).toEqual(homes);
  }, 90_000);
});

describe("a pinned opencode session at a usage limit", () => {
  it("hops to the group's other accounts by headroom, then the rest of the chain, and returns to its pinned account at the reset", async () => {
    writeUsage({ [A]: 90, [B]: 40, [C]: 70 });
    // B (its pin) is limited for three hours; then C, the best of the others, is limited too.
    const { manager, runs, codex } = build([
      answer("first", "b-thread"),
      limitedUntil(new Date(START.getTime() + 3 * HOUR)), answer("on c", "c-thread"),
      limitedUntil(new Date(START.getTime() + 90 * MINUTE)), answer("on a", "a-thread"),
      answer("back on b", "b-thread-2"),
    ]);
    const key = "stub:oc-hops";
    const id = await turn(manager, key, "one");
    expect(modelOf(id)).toBe(MODEL_B);
    writeUsage({ [A]: 90, [B]: 99, [C]: 40 });

    at(10 * MINUTE);
    await turn(manager, key, "two");
    expect(override(id)).toMatchObject({ originalEngine: "opencode", originalModel: MODEL_B, substituteTarget: { engine: "opencode", model: MODEL_C } });
    expect(runs.at(-1)!.model).toBe(MODEL_C);

    // C is out too: the next of the group is the built-in account, ahead of the chain's codex.
    at(20 * MINUTE);
    await turn(manager, key, "three");
    expect(override(id)).toMatchObject({ originalModel: MODEL_B, substituteTarget: { engine: "opencode", model: MODEL_A } });
    expect(runs.at(-1)!.model).toBe(MODEL_A);
    expect(codex.runs).toBe(0);
    expect(override(id)).toMatchObject({ originalModel: MODEL_B }); // the pin is what the session returns to throughout

    at(4 * HOUR);
    await turn(manager, key, "four");
    expect(override(id)).toBeUndefined();
    expect(runs.at(-1)!.model).toBe(MODEL_B); // back on the pinned account, not the group's first member
    expect(modelOf(id)).toBe(MODEL_B);
    expect(pickOf(id)).toMatchObject({ picked: B });
  }, 90_000);

  it("goes on to the rest of the chain once every member of the group is out", async () => {
    writeUsage({ [A]: 90, [B]: 40, [C]: 70 });
    const { manager, codex } = build([
      answer("first", "b-thread"),
      limitedUntil(new Date(START.getTime() + 5 * HOUR)), limitedUntil(new Date(START.getTime() + 5 * HOUR)), limitedUntil(new Date(START.getTime() + 5 * HOUR)),
    ]);
    const key = "stub:oc-rest";
    const id = await turn(manager, key, "one");
    await turn(manager, key, "two");
    expect(codex.runs).toBe(1);
    expect(registry.getSession(id)!.engine).toBe("codex");
    expect(override(id)).toMatchObject({ originalEngine: "opencode", originalModel: MODEL_B });
  }, 60_000);
});

describe("an opencode session that names its own account", () => {
  it("is not balanced when the start asks for a model of another account's provider", async () => {
    writeUsage({ [A]: 90, [B]: 40, [C]: 70 });
    const { manager, runs } = build(answers(1));
    const routed = await manager.route(connectorMessage("stub:oc-chosen", "one"), connectorStub(), { employee: worker as never, model: MODEL_C });
    const id = routed!.sessionId;
    await eventually(() => settled(id));
    expect(pickOf(id)).toBeUndefined();
    expect(modelOf(id)).toBe(MODEL_C);
    expect(runs[0]!.model).toBe(MODEL_C);
  }, 30_000);
});
