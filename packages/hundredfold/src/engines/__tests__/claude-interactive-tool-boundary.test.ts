import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cutting a running claude turn between two tool calls (interruptAtToolBoundary), for a
 * send_to_session that asked to interrupt: Esc only once no call of the turn is running, never
 * Ctrl+B (a running Bash is waited for, not moved to the background), and never over a call.
 *
 * A real HookRegistry is used on purpose, as in the soft-interrupt tests.
 */

interface FakePty {
  pid: number;
  _exitCode: number | null;
  writes: string[];
  dataCbs: Array<(d: string) => void>;
  emit: (d: string) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
}

const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const p: FakePty = {
      pid: 3000 + ptys.length,
      _exitCode: null,
      writes: [],
      dataCbs: [],
      emit(d: string) { for (const cb of p.dataCbs) cb(d); },
      onData(cb: (d: string) => void) { p.dataCbs.push(cb); return { dispose() {} }; },
      onExit() {},
      kill() {},
      write(d: string) { p.writes.push(d); },
      resize() {},
      on() {},
    };
    ptys.push(p);
    return p;
  }),
}));
const sseHandlers: Array<(e: unknown) => void> = vi.hoisted(() => []);
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- hundredfold-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, onEvent: (e: unknown) => void) { sseHandlers.push(onEvent); }
    async start() { return 41300; }
    stop() {}
  },
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";
import { isBoundaryInterruptibleEngine } from "../../shared/types.js";
import { INTERRUPT_SETTLE_MS } from "../claude-soft-interrupt.js";

const CTRL_B = "\x02";
const ESC = "\x1b";
const BASH_ID = "toolu_bash_1";

/** The footer Claude Code draws while a turn runs. */
const RUNNING_FRAME = "\x1b[2J\x1b[H✻ Working… (12s · esc to interrupt)\r\n❯ \r\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt";

describe("InteractiveClaudeEngine — interrupt at a tool boundary", () => {
  let registry: HookRegistry;
  let lifecycle: PtyLifecycleManager;
  let engine: InteractiveClaudeEngine;
  let unclaimed: Array<{ id: string; text: string }>;
  let released: string[];
  let killed: string[];
  let dir: string;
  let transcript: string;

  beforeEach(() => {
    vi.useFakeTimers();
    ptys.length = 0;
    sseHandlers.length = 0;
    unclaimed = [];
    released = [];
    killed = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-soft-"));
    transcript = path.join(dir, "c1.jsonl");
    fs.writeFileSync(transcript, '{"type":"user","message":{"content":"second"}}\n');
    registry = new HookRegistry(30_000, 5_000, 2_000);
    registry.setUnclaimedHookHandler((id, h) => { unclaimed.push({ id, text: String(h.last_assistant_message ?? h.prompt ?? "") }); });
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    const release = lifecycle.releaseSession.bind(lifecycle);
    vi.spyOn(lifecycle, "releaseSession").mockImplementation((id: string) => { released.push(id); release(id); });
    engine = new InteractiveClaudeEngine(lifecycle, registry);
    const kill = engine.kill.bind(engine);
    vi.spyOn(engine, "kill").mockImplementation((id: string, why?: string) => { killed.push(id); kill(id, why); });
  });

  afterEach(() => {
    registry.dispose?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deliver = (id: string, h: Record<string, unknown>) =>
    registry.deliver(id, (h.hook_event_name === "Stop" ? h : { transcript_path: transcript, ...h }) as any);
  const writes = () => ptys[0]!.writes;
  /** The keys written to the PTY that are not pastes: Ctrl+B, Esc, Ctrl+U runs. */
  const keys = () => writes().filter((w) => w === CTRL_B || w === ESC || /^\x15+$/.test(w));

  async function warmUp(id: string): Promise<void> {
    const turn = engine.run({ sessionId: id, prompt: "first", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    deliver(id, { hook_event_name: "SessionStart", session_id: "c1" });
    deliver(id, { hook_event_name: "Stop", last_assistant_message: "first answer" });
    expect((await turn).result).toBe("first answer");
  }

  /** A gateway turn on the warm PTY whose own prompt has been submitted. */
  async function runningTurn(id: string, prompt = "second") {
    await warmUp(id);
    const turn = engine.run({ sessionId: id, prompt, cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    deliver(id, { hook_event_name: "UserPromptSubmit", prompt });
    return { turn };
  }

  const preBash = (id: string, toolUseId = BASH_ID, input: Record<string, unknown> = { command: "node build.js", description: "Build it" }) =>
    deliver(id, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: toolUseId, tool_input: input });
  /** What Claude Code answers when Ctrl+B moves a running command to the background. */
  const backgrounded = (id: string, taskId = "bg1", toolUseId = BASH_ID, input: Record<string, unknown> = { command: "node build.js", description: "Build it" }) =>
    deliver(id, {
      hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: toolUseId, tool_input: input,
      tool_response: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: taskId, backgroundedByUser: true },
    });


  const WAIT = { waitMs: 4_000 };
  /** The model streams some text of the turn: from here on Esc keeps what it wrote. */
  const streamText = (text = "Working on it") =>
    sseHandlers[sseHandlers.length - 1]!({ type: "content_block_delta", delta: { type: "text_delta", text } });
  const postBash = (id: string, toolUseId = BASH_ID) =>
    deliver(id, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: toolUseId, tool_response: { stdout: "ok" } });
  const stop = (id: string, text = "finished") => deliver(id, { hook_event_name: "Stop", last_assistant_message: text });

  it("is a boundary-interruptible engine", () => {
    expect(isBoundaryInterruptibleEngine(engine)).toBe(true);
  });

  it("has nothing to cut with no turn running", async () => {
    expect(await engine.interruptAtToolBoundary("s-none", "new message", WAIT)).toBe("over");
    await warmUp("s-idle");
    expect(await engine.interruptAtToolBoundary("s-idle", "new message", WAIT)).toBe("over");
    expect(keys()).toEqual([]);
  });

  it("cuts a turn that is only generating at once: Esc, the turn settles interrupted, the process stays", async () => {
    const { turn } = await runningTurn("s-gen");
    streamText();
    const before = vi.fn(() => true);
    const outcome = await engine.interruptAtToolBoundary("s-gen", "Interrupted: new message received", { ...WAIT, beforeAbort: before });
    expect(outcome).toBe("interrupted");
    expect(before).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect((await turn).error).toBe("Interrupted: new message received");
    expect(keys()[0]).toBe(ESC);
    expect(keys()).not.toContain(CTRL_B);
    expect(released).toEqual([]);
    expect(killed).toEqual([]);
    expect(engine.holdsTurn("s-gen")).toBe(false);
  });

  it("does not press anything while a Bash runs, and cuts the turn the moment it ends: never Ctrl+B, never Esc over the command", async () => {
    const { turn } = await runningTurn("s-bash");
    preBash("s-bash");
    let outcome: unknown;
    void engine.interruptAtToolBoundary("s-bash", "new message", { waitMs: 100_000 }).then((o) => { outcome = o; });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(keys()).toEqual([]);
    expect(outcome).toBeUndefined();
    postBash("s-bash");
    await vi.advanceTimersByTimeAsync(10);
    expect(outcome).toBe("interrupted");
    // Esc was written when the command's PostToolUse came in, and nothing before it.
    expect(keys()[0]).toBe(ESC);
    expect(keys()).not.toContain(CTRL_B);
    await vi.advanceTimersByTimeAsync(300);
    expect((await turn).error).toBe("Interrupted: new message");
  });

  it.each([
    ["a Bash", { tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "make" } }],
    ["a non-Bash tool", { tool_name: "Read", tool_use_id: "c1", tool_input: { file_path: "/x" } }],
    ["an MCP call", { tool_name: "mcp__docs__search", tool_use_id: "c1", tool_input: { query: "x" } }],
    ["a sub-agent the turn waits on", { tool_name: "Agent", tool_use_id: "c1", tool_input: { prompt: "x" } }],
  ])("answers waiting while %s runs past the wait, and still cuts the turn at its end", async (_name, call) => {
    const { turn } = await runningTurn("s-wait");
    deliver("s-wait", { hook_event_name: "PreToolUse", ...call });
    const before = vi.fn(() => true);
    const outcome = engine.interruptAtToolBoundary("s-wait", "new message", { waitMs: 4_000, beforeAbort: before });
    await vi.advanceTimersByTimeAsync(4_100);
    expect(await outcome).toBe("waiting");
    expect(keys()).toEqual([]);
    expect(before).not.toHaveBeenCalled();
    // The call ends later: the armed cut goes ahead.
    await vi.advanceTimersByTimeAsync(20_000);
    deliver("s-wait", { hook_event_name: "PostToolUse", tool_name: call.tool_name, tool_use_id: call.tool_use_id });
    await vi.advanceTimersByTimeAsync(300);
    expect(before).toHaveBeenCalledTimes(1);
    expect(keys()[0]).toBe(ESC);
    expect(keys()).not.toContain(CTRL_B);
    expect((await turn).error).toBe("Interrupted: new message");
  });

  it("waits for every call when several run at once", async () => {
    const { turn } = await runningTurn("s-many");
    preBash("s-many", "t1");
    deliver("s-many", { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t2", tool_input: { file_path: "/x" } });
    void engine.interruptAtToolBoundary("s-many", "new message", WAIT);
    postBash("s-many", "t1");
    await vi.advanceTimersByTimeAsync(200);
    expect(keys()).toEqual([]);
    deliver("s-many", { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "t2" });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()[0]).toBe(ESC);
    await turn;
  });

  it("ends a call on its failure too", async () => {
    const { turn } = await runningTurn("s-failed");
    preBash("s-failed");
    void engine.interruptAtToolBoundary("s-failed", "new message", WAIT);
    deliver("s-failed", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: BASH_ID, error: "Exit code 3" });
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()[0]).toBe(ESC);
    await turn;
  });

  it("leaves background work running: a backgrounded Bash and a background sub-agent are not calls in flight", async () => {
    const { turn } = await runningTurn("s-bg");
    preBash("s-bg");
    backgrounded("s-bg", "bg-1");
    deliver("s-bg", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "a1", tool_input: { prompt: "x", run_in_background: true } });
    deliver("s-bg", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "a1", tool_response: { status: "async_launched" } });
    // The sub-agent's own calls are not the turn's.
    deliver("s-bg", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "sub1", agent_id: "ag", tool_input: { command: "x" } });
    expect(await engine.interruptAtToolBoundary("s-bg", "new message", WAIT)).toBe("interrupted");
    await vi.advanceTimersByTimeAsync(300);
    await turn;
    expect(keys()).not.toContain(CTRL_B);
    expect(killed).toEqual([]);
    expect(released).toEqual([]);
    expect(engine.backgroundTasks("s-bg").tasks.map((t) => t.id)).toEqual(["bg-1"]);
  });

  it("calls the cut off when beforeAbort says the message is no longer waiting: no key, the turn runs on", async () => {
    const { turn } = await runningTurn("s-off");
    preBash("s-off");
    const outcome = engine.interruptAtToolBoundary("s-off", "new message", { ...WAIT, beforeAbort: () => false });
    postBash("s-off");
    expect(await outcome).toBe("over");
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual([]);
    expect(engine.holdsTurn("s-off")).toBe(true);
    stop("s-off");
    expect((await turn).result).toBe("finished");
  });

  it("does not cut a turn that has written nothing yet: Esc would take its prompt out of the conversation", async () => {
    const { turn } = await runningTurn("s-early");
    const before = vi.fn(() => true);
    const outcome = engine.interruptAtToolBoundary("s-early", "new message", { waitMs: 4_000, beforeAbort: before });
    await vi.advanceTimersByTimeAsync(4_100);
    expect(await outcome).toBe("waiting");
    expect(keys()).toEqual([]);
    expect(before).not.toHaveBeenCalled();
    // Thinking is not output, nor is a sub-agent's call.
    sseHandlers[sseHandlers.length - 1]!({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } });
    deliver("s-early", { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "sub", agent_id: "ag", tool_input: { file_path: "/x" } });
    deliver("s-early", { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "sub", agent_id: "ag" });
    await vi.advanceTimersByTimeAsync(500);
    expect(keys()).toEqual([]);
    // The first text the model writes opens the boundary, and the armed cut goes ahead.
    streamText();
    await vi.advanceTimersByTimeAsync(300);
    expect(before).toHaveBeenCalledTimes(1);
    expect(keys()[0]).toBe(ESC);
    expect((await turn).error).toBe("Interrupted: new message");
  });

  it("does not cut a cold-started turn before the CLI has said anything: its prompt is in argv, so it counts as submitted from the first tick", async () => {
    const turn = engine.run({ sessionId: "s-cold", prompt: "first", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(300);
    const outcome = engine.interruptAtToolBoundary("s-cold", "new message", { waitMs: 100_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(keys()).toEqual([]);
    expect(engine.holdsTurn("s-cold")).toBe(true);
    deliver("s-cold", { hook_event_name: "SessionStart", session_id: "c1" });
    deliver("s-cold", { hook_event_name: "Stop", last_assistant_message: "first answer" });
    expect((await turn).result).toBe("first answer");
    expect(await outcome).toBe("over");
    expect(keys()).toEqual([]);
  });

  it("answers over, and drops the watcher, when the turn ends while the cut still waits for its first output", async () => {
    const { turn } = await runningTurn("s-endwait");
    const outcome = engine.interruptAtToolBoundary("s-endwait", "new message", { waitMs: 100_000 });
    // Ended by the engine, not by a Stop hook: no hook reaches the watcher, only the turn's teardown does.
    engine.kill("s-endwait", "Interrupted: stopped");
    await turn;
    // Answered by the turn's end, not by the 100 s wait.
    expect(await outcome).toBe("over");
    expect(keys()).toEqual([]);
  });

  it("answers over when the turn ends before a boundary, and presses nothing", async () => {
    const { turn } = await runningTurn("s-ended");
    preBash("s-ended");
    const outcome = engine.interruptAtToolBoundary("s-ended", "new message", { waitMs: 100_000 });
    postBash("s-ended");
    // A call that never reported its end, then the turn's Stop: the foreground is cleared with the turn.
    preBash("s-ended", "t2");
    stop("s-ended");
    await turn;
    expect(await outcome).toBe("over");
    expect(keys()).toEqual([]);
  });

  it("does not cut while a permission dialog waits on a call, and does once it is answered", async () => {
    const { turn } = await runningTurn("s-perm");
    deliver("s-perm", { hook_event_name: "Notification", notification_type: "permission_prompt" });
    void engine.interruptAtToolBoundary("s-perm", "new message", WAIT);
    await vi.advanceTimersByTimeAsync(500);
    expect(keys()).toEqual([]);
    preBash("s-perm");
    postBash("s-perm");
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()[0]).toBe(ESC);
    await turn;
  });

  it("cuts nothing when a call starts while the screen is read: waits for the next boundary", async () => {
    const { turn } = await runningTurn("s-gap");
    streamText();
    const outcome = engine.interruptAtToolBoundary("s-gap", "new message", { waitMs: 100_000 });
    // The check ran synchronously and is now reading the screen; a call starts meanwhile.
    preBash("s-gap");
    await vi.advanceTimersByTimeAsync(300);
    expect(keys()).toEqual([]);
    postBash("s-gap");
    await vi.advanceTimersByTimeAsync(300);
    expect(await outcome).toBe("interrupted");
    expect(keys()[0]).toBe(ESC);
    await turn;
  });

  it("is unsupported for a Claude-native command, and presses nothing", async () => {
    await warmUp("s-native");
    const native = engine.run({ sessionId: "s-native", prompt: "/usage", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    expect(await engine.interruptAtToolBoundary("s-native", "new message", WAIT)).toBe("unsupported");
    deliver("s-native", { hook_event_name: "Stop", last_assistant_message: "first answer" });
    await native;
    expect(keys()).toEqual([]);
  });

  it("cuts one turn once: a second request while it ends finds the turn over", async () => {
    const { turn } = await runningTurn("s-twice");
    streamText();
    const a = engine.interruptAtToolBoundary("s-twice", "new message", WAIT);
    const b = engine.interruptAtToolBoundary("s-twice", "new message", WAIT);
    expect(await a).toBe("interrupted");
    expect(await b).toBe("over");
    await vi.advanceTimersByTimeAsync(300);
    await turn;
    expect(keys().filter((k) => k === ESC)).toHaveLength(1);
  });

  it("settles the cut turn once, empties the composer, and the next turn starts clean", async () => {
    const { turn } = await runningTurn("s-next", "line one\nline two");
    streamText();
    expect(await engine.interruptAtToolBoundary("s-next", "new message", WAIT)).toBe("interrupted");
    await vi.advanceTimersByTimeAsync(300);
    expect((await turn).error).toBe("Interrupted: new message");
    const clearAt = writes().findIndex((w) => /^\x15+$/.test(w));
    expect(clearAt).toBeGreaterThan(writes().indexOf(ESC));
    const next = engine.run({ sessionId: "s-next", prompt: "folded", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(300);
    expect(writes().findIndex((w) => w.includes("folded"))).toBeGreaterThan(clearAt);
    deliver("s-next", { hook_event_name: "UserPromptSubmit", prompt: "folded" });
    stop("s-next", "next answer");
    expect((await next).result).toBe("next answer");
    expect(released).toEqual([]);
  });

  it("gives up waiting for the footer after a few seconds, and still settles", async () => {
    const { turn } = await runningTurn("s-stuck");
    streamText();
    ptys[0]!.emit(RUNNING_FRAME);
    await vi.advanceTimersByTimeAsync(50);
    expect(await engine.interruptAtToolBoundary("s-stuck", "new message", WAIT)).toBe("interrupted");
    await vi.advanceTimersByTimeAsync(INTERRUPT_SETTLE_MS + 500);
    expect((await turn).error).toBe("Interrupted: new message");
  });

  it("does not start a voice soft interrupt's turn twice: a soft interrupt in flight makes it over", async () => {
    const { turn } = await runningTurn("s-soft");
    streamText();
    const soft = engine.softInterrupt("s-soft", "voice");
    expect(await engine.interruptAtToolBoundary("s-soft", "new message", WAIT)).toBe("over");
    await vi.advanceTimersByTimeAsync(300);
    await soft;
    await turn;
    expect(keys().filter((k) => k === ESC)).toHaveLength(1);
  });
});
