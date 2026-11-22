import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorMessage, connectorStub, eventually, scriptedEngine } from "./helpers/turn-parity-harness.js";
import { HOUR, MINUTE, START, answer, fallbackConfig, fallbackExpiryHarness, limitedUntil } from "./helpers/fallback-expiry-harness.js";
import type { EngineResult } from "../../shared/types.js";

/**
 * A session the balancer pinned keeps its account: over turns, a resume, a restart and whatever its group's readings do
 * meanwhile. A usage limit walks the group's other members by headroom and then the rest of the chain, and the reset
 * brings the session back to the account it was pinned to, not to its employee's login and not to the group's first member.
 */

const { registry, healthPath, reset, settled, override } = await fallbackExpiryHarness("hundredfold-account-stickiness-");
const { SessionManager } = await import("../manager.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
const { resetAccountCredits } = await import("../../shared/fallback-account-pick.js");

const LIMITS_DIR = path.join(path.dirname(path.dirname(healthPath)), "tmp", "engine-limits");

function profile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hundredfold-stickiness-${name}-`));
  fs.writeFileSync(path.join(dir, ".credentials.json"), "{\"signedIn\":true}");
  return dir;
}
const WORK = profile("work");
const SPARE = profile("spare");
const workKey = `claude:${claudeProfileFromDir(WORK).key}`;
const spareKey = `claude:${claudeProfileFromDir(SPARE).key}`;

const worker = { name: "a-worker", engine: "claude", model: "opus", persona: "Stickiness fixture" };

/** `used` percent in each account's 5h window, read fresh at the current (faked) time. */
function writeUsage(used: Record<string, number>): void {
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor((Date.now() + 24 * HOUR) / 1000);
  for (const [account, percent] of Object.entries(used)) {
    const file = account === "claude" ? "claude-usage-history.json" : `claude-usage-history.${encodeURIComponent(account)}.json`;
    fs.writeFileSync(path.join(LIMITS_DIR, file), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: percent, resetsAt: later }] }]));
  }
}

beforeEach(() => {
  reset();
  resetAccountCredits();
});
afterEach(() => vi.useRealTimers());

interface Run { profile: string | null | undefined; model?: string; resume?: string }

/** A session manager over a scripted claude (which records the profile each run used) and a codex, with a group at the head of claude's chain. */
function build(script: EngineResult[]) {
  const cfg = fallbackConfig() as any;
  cfg.engines.claude = {
    bin: process.execPath, model: "opus", accounts: { work: { configDir: WORK }, spare: { configDir: SPARE } },
    fallback: [{ group: [{ engine: "claude" }, { engine: "claude", profile: "work" }, { engine: "claude", profile: "spare" }] }, "codex"],
  };
  cfg.models.claude = { default: "opus", models: [{ id: "opus" }, { id: "sonnet" }] };
  const claude: any = scriptedEngine("claude", script);
  const runs: Run[] = [];
  const run = claude.run;
  claude.run = async (opts: any) => {
    runs.push({ profile: opts.claudeProfile?.dir ?? opts.claudeProfile ?? null, model: opts.model, resume: opts.resume ?? opts.resumeSessionId });
    return run(opts);
  };
  const codex: any = scriptedEngine("codex", [answer("codex answer", "codex-thread")]);
  const manager = new SessionManager(cfg, new Map([["claude", claude], ["codex", codex]]) as never, "stickiness-boot");
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
const pinned = (id: string) => registry.getSession(id)!.claudeConfigDir;
const claudeAnswers = (count: number): EngineResult[] => Array.from({ length: count }, (_, n) => answer(`answer ${n}`, `thread-${n}`));

describe("a session pinned to an account", () => {
  it("is pinned at its first turn to the account with the most headroom, and runs there", async () => {
    writeUsage({ claude: 90, [workKey]: 40, [spareKey]: 70 });
    const { manager, runs } = build(claudeAnswers(1));
    const id = await turn(manager, "stub:pinned-first", "one");
    expect(pickOf(id)).toMatchObject({ picked: workKey, reason: "weighted" });
    expect(pinned(id)).toBe(WORK);
    expect(runs[0]!.profile).toBe(WORK);
  }, 30_000);

  it("keeps it over many turns, a resume and a restart while another account's readings turn better", async () => {
    writeUsage({ claude: 90, [workKey]: 40, [spareKey]: 70 });
    const { manager, runs } = build(claudeAnswers(8));
    const key = "stub:sticky";
    const id = await turn(manager, key, "one");
    const first = pickOf(id);

    // The account it sits on is now nearly spent and another is nearly empty: nothing may move it.
    writeUsage({ claude: 90, [workKey]: 97, [spareKey]: 3 });
    for (const text of ["two", "three", "four"]) await turn(manager, key, text);
    expect(pinned(id)).toBe(WORK);
    expect(pickOf(id)).toEqual(first);

    // A restart: the row is recovered as interrupted and the next message resumes it.
    registry.updateSession(id, { status: "running" });
    registry.recoverStaleSessions();
    expect(registry.getSession(id)!.status).toBe("interrupted");
    await turn(manager, key, "five");
    await turn(manager, key, "six");
    expect(pinned(id)).toBe(WORK);
    expect(pickOf(id)).toEqual(first);
    expect(new Set(runs.map((run) => run.profile))).toEqual(new Set([WORK]));
    expect(runs).toHaveLength(6);
  }, 60_000);

  it("never alternates between accounts as new sessions start and old ones take turns", async () => {
    writeUsage({ claude: 50, [workKey]: 50, [spareKey]: 50 });
    const { manager } = build(claudeAnswers(12));
    const first = await turn(manager, "stub:alt-1", "a");
    const second = await turn(manager, "stub:alt-2", "b");
    const third = await turn(manager, "stub:alt-3", "c");
    const homes = [first, second, third].map(pinned);
    expect(new Set(homes.map((home) => home ?? "claude")).size).toBe(3); // an even group spreads three starts across three accounts
    for (let round = 0; round < 3; round++) {
      await turn(manager, "stub:alt-1", `again ${round}`);
      await turn(manager, "stub:alt-2", `again ${round}`);
      await turn(manager, "stub:alt-3", `again ${round}`);
    }
    expect([first, second, third].map(pinned)).toEqual(homes);
  }, 90_000);
});

describe("a pinned session at a usage limit", () => {
  it("hops to the group's other accounts by headroom, then the rest of the chain, and returns to its own account at the reset", async () => {
    writeUsage({ claude: 90, [workKey]: 40, [spareKey]: 70 });
    // work (its own) is limited for three hours; then spare, the best of the others (60% against 10%), is limited too.
    const { manager, runs, codex } = build([
      answer("first", "work-thread"),
      limitedUntil(new Date(START.getTime() + 3 * HOUR)), answer("on spare", "spare-thread"),
      limitedUntil(new Date(START.getTime() + 90 * MINUTE)), answer("on default", "default-thread"),
      answer("back on work", "work-thread-2"),
    ]);
    const key = "stub:hops";
    const id = await turn(manager, key, "one");
    expect(pinned(id)).toBe(WORK);
    writeUsage({ claude: 90, [workKey]: 99, [spareKey]: 40 });

    at(10 * MINUTE);
    await turn(manager, key, "two");
    expect(override(id)).toMatchObject({ originalAccount: workKey, substituteAccount: spareKey });
    expect(runs.at(-1)!.profile).toBe(SPARE);

    // Spare is out too: the next of the group is the default login, ahead of the chain's codex.
    at(20 * MINUTE);
    await turn(manager, key, "three");
    expect(override(id)).toMatchObject({ originalAccount: workKey, substituteAccount: "claude" });
    expect(codex.runs).toBe(0);
    expect(pinned(id)).toBe(WORK); // the pin is the session's own account throughout

    at(4 * HOUR);
    await turn(manager, key, "four");
    expect(override(id)).toBeUndefined();
    expect(runs.at(-1)!.profile).toBe(WORK); // back on the pinned account, not the employee's login nor the group's first member
    expect(pinned(id)).toBe(WORK);
    expect(pickOf(id)).toMatchObject({ picked: workKey });
  }, 90_000);

  it("goes on to the rest of the chain once every member of the group is out", async () => {
    writeUsage({ claude: 90, [workKey]: 40, [spareKey]: 70 });
    const { manager, codex } = build([
      answer("first", "work-thread"),
      limitedUntil(new Date(START.getTime() + 5 * HOUR)), limitedUntil(new Date(START.getTime() + 5 * HOUR)), limitedUntil(new Date(START.getTime() + 5 * HOUR)),
    ]);
    const key = "stub:rest";
    const id = await turn(manager, key, "one");
    await turn(manager, key, "two");
    expect(codex.runs).toBe(1);
    expect(registry.getSession(id)!.engine).toBe("codex");
    expect(pinned(id)).toBe(WORK);
    expect(override(id)).toMatchObject({ originalEngine: "claude" });
  }, 60_000);
});
