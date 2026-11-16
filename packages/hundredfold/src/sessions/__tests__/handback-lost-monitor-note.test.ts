import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, EngineRunOpts, HundredfoldConfig } from "../../shared/types.js";
import type { TurnReceipt, TurnSurface } from "../turn/types.js";

/**
 * A session moved onto a stand-in account that holds a background Monitor there, and then handed back to its own
 * account: the stand-in's process is released when the revert moves the session off it, so the Monitor is recorded as
 * moved and the re-run turn's prompt tells the session so. The engine is the real interactive one over a fake PTY,
 * wired to the gateway's lost-task handling and move-off release as the server wires them; only the turns are scripted.
 */

vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-profile-signin.js")>()),
  verifyLocalClaudeProfile: () => undefined,
}));
vi.mock("../callbacks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../callbacks.js")>()),
  notifyRateLimitResumed: () => {},
}));
vi.mock("../claude-auth-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude-auth-watch.js")>()),
  refuseClaudeLaunch: () => undefined,
  observeClaudeTurnOutcome: () => {},
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-handback-monitor-"));
process.env.HUNDREDFOLD_HOME = tmp;
const reg = await import("../registry.js");
const { runTurn } = await import("../turn/runner.js");
const { beginEngineSubstitution, maybeRevertEngineOverride } = await import("../engine-override.js");
const { releaseEngineOnMove } = await import("../engine-move-release.js");
const { handleLostBackgroundTasks } = await import("../lost-background-tasks.js");
const { recordLeftBackgroundTasks, readLeftBackgroundTasks } = await import("../left-background-tasks.js");
const { ENGINE_SWITCHED_REASON } = await import("../../shared/engine-switch.js");
const { InteractiveClaudeEngine } = await import("../../engines/claude-interactive.js");
const { PtyLifecycleManager } = await import("../../engines/pty-lifecycle.js");
const { HookRegistry } = await import("../../gateway/hook-registry.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
const { initDb } = await import("../../shared/db.js");

const friend = claudeProfileFromDir(path.join(tmp, "claude-friend"));
const FRIEND_ACCOUNT = `claude:${friend.key}`;
const config = { gateway: {}, engines: { default: "claude", claude: { model: "opus" } }, sessions: {} } as unknown as HundredfoldConfig;

const MONITOR = {
  hook_event_name: "PostToolUse",
  tool_name: "Monitor",
  tool_input: { description: "watch the deploy log", timeout_ms: 600_000, command: "tail -f deploy.log" },
  tool_response: { taskId: "mon-1", timeoutMs: 600_000, persistent: false },
};
const NOTE_LEAD = /^\[Gateway\] A background task this session started was held by an engine process that was replaced when the session moved to another account or engine after a usage limit/;

function fakeHandle() {
  const handle: { killed: boolean; pid: number; kill: () => void } = { killed: false, pid: Math.floor(Math.random() * 9999), kill: () => { handle.killed = true; } };
  return handle;
}

interface Call { prompt: string; resumeSessionId?: string; profile: unknown }

/** The real engine over a fake PTY, an engines map whose `claude` entry kills and reports through it, and the gateway's wiring. */
function world(script: (call: number) => EngineResult | Promise<EngineResult>) {
  const registry = new HookRegistry();
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
  const real = new InteractiveClaudeEngine(lifecycle, registry);
  real.onLostBackgroundTasks((sessionId, tasks, cause) => handleLostBackgroundTasks(sessionId, tasks, cause));
  const calls: Call[] = [];
  const claude = {
    name: "claude",
    async run(opts: EngineRunOpts) {
      calls.push({ prompt: opts.prompt, resumeSessionId: opts.resumeSessionId, profile: opts.claudeProfile });
      return await script(calls.length);
    },
    kill: (id: string, reason?: string) => real.kill(id, reason),
    isAlive: (id: string) => real.isAlive(id),
    killAll: () => real.killAll(),
    holdsTurn: (id: string) => real.holdsTurn(id),
  } as unknown as Engine;
  const engines = new Map<string, Engine>([["claude", claude]]);
  const stopWiring = releaseEngineOnMove(engines);
  const typeIntoTerminal = (sessionId: string) => (real as unknown as { observeHook(id: string, hook: unknown): void }).observeHook(sessionId, { hook_event_name: "UserPromptSubmit", prompt: "typed by the operator" });
  const arm = (sessionId: string) => {
    lifecycle.adopt(sessionId, fakeHandle() as never);
    (real as unknown as { handleBackgroundMonitorHook(id: string, hook: unknown): void }).handleBackgroundMonitorHook(sessionId, MONITOR);
  };
  return { engines, calls, arm, typeIntoTerminal, dispose: () => { stopWiring(); registry.dispose(); } };
}

function recordingSurface() {
  const receipts: TurnReceipt[] = [];
  const surface: TurnSurface = {
    started: async () => {}, delta: () => {}, notice: async () => {}, reply: async () => {}, waiting: async () => {},
    settled: async (receipt) => { receipts.push(receipt); },
  };
  return { surface, receipts };
}

/** A session standing on the friend account until `until`, with its own thread parked. */
function onStandIn(ref: string, until: Date): string {
  const s = reg.createSession({ engine: "claude", source: "web", sourceRef: ref, model: "opus" });
  reg.recordEngineSessionId(s.id, "claude", "a-thread");
  reg.updateSession(s.id, { status: "running", attemptToken: "swap-attempt" } as never);
  beginEngineSubstitution({
    session: reg.getSession(s.id)!, attemptToken: "swap-attempt", config, employee: undefined, substitute: "claude",
    accounts: { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir },
    until, syncSince: new Date(Date.now() - 60_000).toISOString(), lastError: "limit",
  });
  reg.recordEngineSessionId(s.id, "claude", "b-thread");
  reg.updateSession(s.id, { status: "idle" } as never);
  return s.id;
}

const owed = (id: string) => (reg.getSession(id)!.transportMeta as Record<string, unknown> | null)?.leftBackgroundTasks as Array<{ id: string; reason: string }> | undefined;
const deliveries = () => (initDb().prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get() as { n: number }).n;
const weeklyLimit = (): EngineResult => ({
  sessionId: "b-thread", result: "", error: "You've hit your weekly limit",
  rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 5 * 24 * 3600 },
});

beforeEach(() => {
  initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM callback_deliveries; DELETE FROM sessions;");
});

afterEach(() => vi.useRealTimers());

describe("a Monitor the stand-in account held when the session is handed back to its own", () => {
  it("is named in the re-run turn's prompt, with no nudge, and is not owed once that turn settled", async () => {
    const until = new Date(Date.now() + 1_500);
    const id = onStandIn("web:handback-monitor", until);
    const { engines, calls, arm, dispose } = world((call) => (call === 1 ? weeklyLimit() : { sessionId: "a-thread", result: "done on the own account" }));
    arm(id);
    reg.insertMessage(id, "user", "now publish them");
    const started = reg.beginSessionAttempt(id)!;
    const { surface, receipts } = recordingSurface();

    await runTurn({
      session: reg.getSession(id)!, attemptToken: started.attemptToken!, prompt: "now publish them", attachments: [], config, engines,
      gatewayBootId: "test-boot", connectorNames: [], channel: "web", user: "operator",
    }, surface);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.profile).toEqual(friend);
    // The stand-in's turn, limited, read nothing of it: the Monitor was alive then.
    expect(calls[0]!.prompt).not.toContain("mon-1");
    // The re-run is on the own account's thread, and leads with the note.
    expect(calls[1]!.profile).toBeNull();
    expect(calls[1]!.resumeSessionId).toBe("a-thread");
    expect(calls[1]!.prompt).toMatch(NOTE_LEAD);
    expect(calls[1]!.prompt).toContain("- mon-1 (Monitor): watch the deploy log: `tail -f deploy.log`");
    expect(deliveries()).toBe(0);
    expect(owed(id)).toBeUndefined();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.result).toBe("done on the own account");
    dispose();
  }, 15_000);
});

describe("the revert that moves a session off its stand-in", () => {
  const expire = (id: string) => {
    const meta = reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>>;
    reg.updateSession(id, { transportMeta: { ...meta, engineOverride: { ...meta.engineOverride, until: "2020-01-01T00:00:00.000Z" } } as never });
  };

  it("records what the stand-in's process held as moved, and returns the row with it, so a caller carries it", () => {
    const id = onStandIn("web:revert-records", new Date(Date.now() + 3600_000));
    const { arm, dispose } = world(() => ({ sessionId: "", result: "" }));
    arm(id);
    expire(id);

    const back = maybeRevertEngineOverride(reg.getSession(id)!);

    expect(back.engineSessionId).toBe("a-thread");
    expect(readLeftBackgroundTasks(back).map((entry) => [entry.id, entry.reason])).toEqual([["mon-1", "moved"]]);
    expect(deliveries()).toBe(0);
    dispose();
  });

  it("does not release the stand-in's process while a turn runs on it", () => {
    const id = onStandIn("web:revert-busy", new Date(Date.now() + 3600_000));
    const kill = vi.fn();
    const busy = { name: "claude", run: async () => ({ sessionId: "", result: "" }), kill, isAlive: () => true, killAll: () => {}, holdsTurn: () => true } as unknown as Engine;
    const stop = releaseEngineOnMove(new Map([["claude", busy]]));
    expire(id);

    const back = maybeRevertEngineOverride(reg.getSession(id)!);

    expect(back.engineSessionId).toBe("a-thread");
    expect(kill).not.toHaveBeenCalled();
    expect(owed(id)).toBeUndefined();
    stop();
  });

  it("does not release a process with a turn typed into its terminal, which the engine's own idle recycle spares too", () => {
    const id = onStandIn("web:revert-terminal-turn", new Date(Date.now() + 3600_000));
    const { arm, typeIntoTerminal, dispose } = world(() => ({ sessionId: "", result: "" }));
    arm(id);
    typeIntoTerminal(id);
    expire(id);

    const back = maybeRevertEngineOverride(reg.getSession(id)!);

    expect(back.engineSessionId).toBe("a-thread");
    expect(owed(id)).toBeUndefined();
    dispose();
  });

  it("does not interrupt an engine that cannot say whether a turn runs: for it a kill is the turn interrupt", () => {
    const id = onStandIn("web:revert-silent-engine", new Date(Date.now() + 3600_000));
    const kill = vi.fn();
    const silent = { name: "claude", run: async () => ({ sessionId: "", result: "" }), kill, isAlive: () => true, killAll: () => {} } as unknown as Engine;
    const stop = releaseEngineOnMove(new Map([["claude", silent]]));
    expire(id);

    maybeRevertEngineOverride(reg.getSession(id)!);

    expect(kill).not.toHaveBeenCalled();
    stop();
  });

  it("releases an idle stand-in's process as a move, and never one on another engine's behalf", () => {
    const id = onStandIn("web:revert-idle", new Date(Date.now() + 3600_000));
    const kill = vi.fn();
    const idle = { name: "claude", run: async () => ({ sessionId: "", result: "" }), kill, isAlive: () => true, killAll: () => {}, holdsTurn: () => false } as unknown as Engine;
    const other = vi.fn();
    const stop = releaseEngineOnMove(new Map<string, Engine>([["claude", idle], ["codex", { name: "codex", run: async () => ({ sessionId: "", result: "" }), kill: other, isAlive: () => true, killAll: () => {} } as unknown as Engine]]));
    expire(id);

    maybeRevertEngineOverride(reg.getSession(id)!);

    expect(kill).toHaveBeenCalledExactlyOnceWith(id, ENGINE_SWITCHED_REASON);
    expect(other).not.toHaveBeenCalled();
    stop();
  });

  it("keeps a task recorded after the caller read the session, when it writes its reverted meta", () => {
    const id = onStandIn("web:revert-stale", new Date(Date.now() + 3600_000));
    expire(id);
    const stale = reg.getSession(id)!;
    recordLeftBackgroundTasks(id, [{ id: "mon-2", kind: "monitor", command: "tail -f x.log", description: null, agentType: null }], "moved");

    maybeRevertEngineOverride(stale);

    expect(owed(id)?.map((entry) => entry.id)).toEqual(["mon-2"]);
  });
});
