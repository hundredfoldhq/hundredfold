/**
 * The hub against the real engine classes' capability detection, not only fakes: what each real engine
 * advertises is what the hub's `ready.backgrounding` and barge-in decisions are made from, and the kill
 * invariant has to hold for engines the hub did not write.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSoftInterruptibleEngine, isSteerableEngine, type Engine } from "../../shared/types.js";
import { foregroundWorkOf, UNREPORTED_WORK } from "../barge-in-policy.js";
import { createHarness } from "./hub-harness.js";
import { settle } from "./fakes.js";
import { InteractiveClaudeEngine } from "../../engines/claude-interactive.js";
import { OpencodeEngine } from "../../engines/opencode.js";
import { CodexEngine } from "../../engines/codex.js";
import { PiEngine } from "../../engines/pi.js";
import { GrokEngine } from "../../engines/grok.js";
import { HermesAcpEngine } from "../../engines/hermes-acp.js";
import { MusecodeEngine } from "../../engines/musecode.js";
import { AntigravityEngine } from "../../engines/antigravity.js";
import { PtyLifecycleManager } from "../../engines/pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";

const registries: HookRegistry[] = [];
afterEach(() => { for (const r of registries.splice(0)) r.dispose(); });

function realClaude(): InteractiveClaudeEngine {
  const registry = new HookRegistry();
  registries.push(registry);
  return new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 2 }), registry);
}

/** Spy on every kill a real engine could be given. */
function spyOnKill(engine: Engine): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  (engine as unknown as { kill: unknown }).kill = spy;
  return spy;
}

describe("real engines' capabilities", () => {
  it("the Claude engine is soft-interruptible and steerable, and keeps long work running", () => {
    const claude = realClaude();
    expect(isSoftInterruptibleEngine(claude)).toBe(true);
    expect(isSteerableEngine(claude)).toBe(true);
    expect(claude.softInterruptPreservesForegroundWork).toBe(true);
    expect(foregroundWorkOf(claude, "no-such-session")).toBeNull();
  });

  it("OpenCode reports foreground work as a plain method, is steerable, and is not soft-interruptible", () => {
    const opencode = new OpencodeEngine();
    expect(typeof (opencode as unknown as { foregroundWork: unknown }).foregroundWork).toBe("function");
    expect(isSteerableEngine(opencode)).toBe(true);
    expect(isSoftInterruptibleEngine(opencode)).toBe(false);
    // No turn: it reports none, which is an answer.
    expect(foregroundWorkOf(opencode, "no-such-session")).toBeNull();
  });

  it.each([
    ["codex", () => new CodexEngine()],
    ["pi", () => new PiEngine()],
    ["grok", () => new GrokEngine()],
    ["hermes", () => new HermesAcpEngine()],
    ["musecode", () => new MusecodeEngine()],
    ["antigravity", () => new AntigravityEngine(new PtyLifecycleManager({ maxLivePtys: 2 }))],
  ] as const)("%s cannot report foreground work, so it is taken to be running long work that cannot be backgrounded", (_name, make) => {
    const engine = make();
    expect(typeof (engine as unknown as { foregroundWork?: unknown }).foregroundWork).toBe("undefined");
    expect(isSoftInterruptibleEngine(engine)).toBe(false);
    expect(foregroundWorkOf(engine, "any")).toBe(UNREPORTED_WORK);
  });
});

describe("the hub on real engines", () => {
  it("Claude: ready says native, and a spoken interruption of a turn with no foreground call ends it softly through the real engine, never a kill", async () => {
    const claude = realClaude();
    const kill = spyOnKill(claude);
    const h = createHarness({ realEngine: claude });
    h.state.turnRunning = true;
    const { socket, attachment } = h.connect();
    expect(socket.ofType("ready")[0].backgrounding).toBe("native");
    await h.say(attachment, "what is two plus two");
    // The real softInterrupt found no turn of its own to end (nothing is spawned here) and said so, never rejecting.
    expect(h.delivered.map((d) => d.mode)).toEqual(["queue"]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("OpenCode: ready says steer; with no steerable turn and nothing reported running, a send-now is the answer", async () => {
    const opencode = new OpencodeEngine();
    const kill = spyOnKill(opencode);
    const h = createHarness({ realEngine: opencode });
    h.state.turnRunning = true;
    const { socket, attachment } = h.connect();
    expect(socket.ofType("ready")[0].backgrounding).toBe("steer");
    await h.say(attachment, "hello");
    expect(h.delivered.map((d) => d.mode)).toEqual(["interrupt"]);
    // The hub asks; the delivery path (deliver.ts) is what kills, and it is tested against the same rule there.
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", () => new CodexEngine()],
    ["pi", () => new PiEngine()],
    ["grok", () => new GrokEngine()],
    ["hermes", () => new HermesAcpEngine()],
    ["musecode", () => new MusecodeEngine()],
    ["antigravity", () => new AntigravityEngine(new PtyLifecycleManager({ maxLivePtys: 2 }))],
  ] as const)("%s: ready says none, and a spoken interruption is held with the holding line and never a kill", async (_name, make) => {
    const engine = make();
    const kill = spyOnKill(engine);
    const h = createHarness({ realEngine: engine });
    h.state.turnRunning = true;
    const { socket, attachment } = h.connect();
    expect(socket.ofType("ready")[0].backgrounding).toBe("none");
    await h.say(attachment, "hello");
    await settle();
    expect(h.delivered.map((d) => d.mode)).toEqual(["queue"]);
    expect(socket.ofType("holding")).toHaveLength(1);
    expect(kill).not.toHaveBeenCalled();
  });
});
