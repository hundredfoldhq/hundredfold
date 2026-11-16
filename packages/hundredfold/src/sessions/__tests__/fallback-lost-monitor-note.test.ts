import { describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, EngineRunOpts } from "../../shared/types.js";
import type { TurnReceipt, TurnSurface } from "../turn/types.js";
import { CLAUDE_B, answer, config, employee, limited, newSession, reg, resetsIn, useWalkHarness, who, type Call } from "./fallback-walk-harness.js";

// node-pty loads a native module at import time; nothing here spawns a process.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("../callbacks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../callbacks.js")>()),
  notifyRateLimitResumed: () => {},
}));

const { InteractiveClaudeEngine } = await import("../../engines/claude-interactive.js");
const { PtyLifecycleManager } = await import("../../engines/pty-lifecycle.js");
const { HookRegistry } = await import("../../gateway/hook-registry.js");
const { handleLostBackgroundTasks } = await import("../lost-background-tasks.js");
const { runTurn } = await import("../turn/runner.js");
const { initDb } = await import("../../shared/db.js");

/**
 * A session that holds a background Monitor when a usage limit moves its turn along the fallback chain. The Monitor
 * lives inside the limited Claude process, which the hop releases; the session's next prompt, on whichever target
 * serves the turn, has to tell it so. The engine here is the real interactive one, driven by a hook event over a
 * fake PTY, wired to the gateway's lost-task handling as the server wires it; only the turns it runs are scripted.
 */

useWalkHarness();

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

/** The real engine over a fake PTY holding a Monitor for the session, and the engines map whose `claude` entry kills through it. */
function world(script: (call: Call, n: number, opts: EngineRunOpts) => EngineResult | Promise<EngineResult>) {
  const registry = new HookRegistry();
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
  const real = new InteractiveClaudeEngine(lifecycle, registry);
  real.onLostBackgroundTasks((sessionId, tasks, cause) => handleLostBackgroundTasks(sessionId, tasks, cause));
  const calls: Call[] = [];
  const scriptedEngine = (name: string, extra: Partial<Engine> = {}): Engine => ({
    name,
    async run(opts: EngineRunOpts) {
      const call = { engine: name, profileDir: opts.claudeProfile?.dir ?? null, model: opts.model, resume: opts.resumeSessionId, prompt: opts.prompt };
      calls.push(call);
      return await script(call, calls.length, opts);
    },
    ...extra,
  } as Engine);
  const claude = scriptedEngine("claude", {
    kill: (id: string, reason?: string) => real.kill(id, reason),
    isAlive: (id: string) => real.isAlive(id),
    killAll: () => real.killAll(),
    holdsTurn: (id: string) => real.holdsTurn(id),
  } as Partial<Engine>);
  const engines = new Map<string, Engine>([["claude", claude], ["opencode", scriptedEngine("opencode")]]);
  const arm = (sessionId: string) => {
    lifecycle.adopt(sessionId, fakeHandle() as never);
    (real as unknown as { handleBackgroundMonitorHook(id: string, hook: unknown): void }).handleBackgroundMonitorHook(sessionId, MONITOR);
  };
  return { engines, calls, arm, dispose: () => registry.dispose() };
}

function recordingSurface() {
  const receipts: TurnReceipt[] = [];
  const surface: TurnSurface = {
    started: async () => {}, delta: () => {}, notice: async () => {}, reply: async () => {}, waiting: async () => {},
    settled: async (receipt) => { receipts.push(receipt); },
  };
  return { surface, receipts };
}

async function runOne(id: string, engines: Map<string, Engine>, worker = employee({ persona: "Ships releases." })) {
  reg.insertMessage(id, "user", "now publish them");
  const started = reg.beginSessionAttempt(id)!;
  const { surface, receipts } = recordingSurface();
  await runTurn({
    session: reg.getSession(id)!, attemptToken: started.attemptToken!, prompt: "now publish them", attachments: [], employee: worker, config, engines,
    gatewayBootId: "test-boot", connectorNames: [], channel: "web", user: "operator",
  }, surface);
  return receipts;
}

const owed = (id: string) => (reg.getSession(id)!.transportMeta as Record<string, unknown> | null)?.leftBackgroundTasks as Array<{ id: string; reason: string }> | undefined;
const deliveries = () => (initDb().prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get() as { n: number }).n;

describe("a Monitor held when a usage limit moves the turn along the chain", () => {
  it("is named in the stand-in's first prompt, with no nudge, and is not owed once that turn settled", async () => {
    const { engines, calls, arm, dispose } = world((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    arm(id);

    await runOne(id, engines);

    expect(calls.map(who)).toEqual(["A/opus", "B/sonnet"]);
    // The turn on its own account read nothing of it: the Monitor was alive then.
    expect(calls[0]!.prompt).not.toContain("mon-1");
    expect(calls[1]!.prompt).toMatch(NOTE_LEAD);
    expect(calls[1]!.prompt).toContain("- mon-1 (Monitor): watch the deploy log: `tail -f deploy.log`");
    expect(calls[1]!.prompt).toContain("Re-arm any Monitor you still need");
    expect(deliveries()).toBe(0);
    expect(owed(id)).toBeUndefined();
    dispose();
  });

  it("stays owed through a link that fails, and the next link that serves carries it again", async () => {
    let owedWhenXRan: string[] | undefined;
    const { engines, calls, arm, dispose } = world((call) => {
      if (who(call) === "x-provider/model-x") {
        owedWhenXRan = owed(id)?.map((entry) => entry.id);
        return answer("on X", "x-thread");
      }
      return limited();
    });
    const id = newSession();
    arm(id);

    await runOne(id, engines);

    expect(calls.map(who)).toEqual(["A/opus", "B/sonnet", "x-provider/model-x"]);
    // B did not serve the turn, so what it was told is still owed, and X is told it again.
    expect(calls[1]!.prompt).toMatch(NOTE_LEAD);
    expect(owedWhenXRan).toEqual(["mon-1"]);
    expect(calls[2]!.prompt).toMatch(NOTE_LEAD);
    expect(calls[2]!.prompt).toContain("`tail -f deploy.log`");
    expect(calls[2]!.prompt).toContain("Continue this conversation and respond to the last USER message.");
    expect(deliveries()).toBe(0);
    expect(owed(id)).toBeUndefined();
    dispose();
  });

  it("is cleared when the serving link failed after it began to answer, and stays owed when it failed before any output", async () => {
    const streamedFirst = world((call, _n, opts) => {
      if (who(call) !== "B/sonnet") return limited();
      opts.onStream?.({ type: "text", content: "partial answer" });
      return { sessionId: "b-thread", result: "", error: "connection dropped" };
    });
    const first = newSession({ ref: "web:streamed" });
    streamedFirst.arm(first);
    await runOne(first, streamedFirst.engines);
    expect(streamedFirst.calls[1]!.prompt).toMatch(NOTE_LEAD);
    expect(owed(first)).toBeUndefined();

    // The same failure with nothing said first: the engine may never have read the prompt.
    const silent = world((call) => (who(call) === "B/sonnet" ? { sessionId: "", result: "", error: "connection dropped" } : limited()));
    const second = newSession({ ref: "web:silent" });
    silent.arm(second);
    await runOne(second, silent.engines);
    expect(silent.calls[1]!.prompt).toMatch(NOTE_LEAD);
    expect(owed(second)?.map((entry) => entry.id)).toEqual(["mon-1"]);
    streamedFirst.dispose();
    silent.dispose();
  });

  it("does not count one link's output as the next link's: a link that failed silently after another streamed leaves it owed", async () => {
    const { engines, calls, arm, dispose } = world((call, _n, opts) => {
      if (who(call) === "B/sonnet") {
        opts.onStream?.({ type: "text", content: "partial answer" });
        return limited();
      }
      return who(call) === "x-provider/model-x" ? { sessionId: "", result: "", error: "connection dropped" } : limited();
    });
    const id = newSession({ ref: "web:streamed-then-silent" });
    arm(id);

    await runOne(id, engines);

    expect(calls.map(who)).toEqual(["A/opus", "B/sonnet", "x-provider/model-x"]);
    expect(calls[2]!.prompt).toMatch(NOTE_LEAD);
    expect(owed(id)?.map((entry) => entry.id)).toEqual(["mon-1"]);
    dispose();
  });

  it("does not count one retry's output as the next retry's either", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engines, calls, arm, dispose } = world((_call, n, opts) => {
      if (n < 3) return limited(resetsIn(600));
      if (n === 3) {
        opts.onStream?.({ type: "text", content: "partial answer" });
        return limited(resetsIn(600));
      }
      return { sessionId: "", result: "", error: "connection dropped" };
    });
    const id = newSession({ ref: "web:retry-streamed-then-silent" });
    arm(id);

    const turn = runOne(id, engines, employee({ persona: "Ships releases.", fallback: [CLAUDE_B] }));
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    await turn;

    expect(calls).toHaveLength(4);
    expect(calls[3]!.prompt).toMatch(NOTE_LEAD);
    expect(owed(id)?.map((entry) => entry.id)).toEqual(["mon-1"]);
    dispose();
  });

  it("is kept across a chain that ran out, and carried by the retry that waits out the limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let owedWhenRetried: string[] | undefined;
    const { engines, calls, arm, dispose } = world((_call, n) => {
      if (n < 3) return limited(resetsIn(600));
      owedWhenRetried = owed(id)?.map((entry) => entry.id);
      return answer("after the wait", "a-thread");
    });
    const id = newSession();
    arm(id);

    const turn = runOne(id, engines, employee({ persona: "Ships releases.", fallback: [CLAUDE_B] }));
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await turn;

    expect(calls.map(who)).toEqual(["A/opus", "B/sonnet", "A/opus"]);
    expect(calls[1]!.prompt).toMatch(NOTE_LEAD);
    // The walk gave the session back to where the turn began; the record of what its process held was not part of that.
    expect(owedWhenRetried).toEqual(["mon-1"]);
    expect(calls[2]!.prompt).toMatch(NOTE_LEAD);
    expect(calls[2]!.prompt).toContain("`tail -f deploy.log`");
    expect(calls[2]!.prompt.endsWith("now publish them")).toBe(true);
    expect(deliveries()).toBe(0);
    expect(owed(id)).toBeUndefined();
    expect(reg.getSession(id)!.status).toBe("idle");
    dispose();
  });
});
