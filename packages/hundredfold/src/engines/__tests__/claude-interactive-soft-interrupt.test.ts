import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Ending a running claude turn softly (softInterrupt) and reporting its foreground work.
 *
 * Verified on claude 2.1.330 (see claude-interactive-soft-interrupt-live.test.ts): Esc alone
 * SIGTERMs a foreground Bash; Ctrl+B moves it to a background task and Esc after that ends the
 * turn with the command still running; Esc fires no Stop hook; and Esc before the model has
 * produced anything puts the turn's prompt back in the composer.
 *
 * A real HookRegistry is used on purpose, as in the steering tests.
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
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- hundredfold-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41300; }
    stop() {}
  },
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";
import { isSoftInterruptibleEngine } from "../../shared/types.js";
import { launchedBackgroundTask } from "../background-tasks.js";
import { BACKGROUND_ACK_MS, BACKGROUND_RETRY_MS, INTERRUPT_SETTLE_MS, viewportShowsTurnRunning, ForegroundCalls, backgroundedByPostToolUse } from "../claude-soft-interrupt.js";

const CTRL_B = "\x02";
const ESC = "\x1b";
const BASH_ID = "toolu_bash_1";

/** The footer Claude Code draws while a turn runs, and the one it draws idle. */
const RUNNING_FRAME = "\x1b[2J\x1b[H✻ Working… (12s · esc to interrupt)\r\n❯ \r\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt";
const IDLE_FRAME = "\x1b[2J\x1b[H  ⎿  Interrupted · What should Claude do instead?\r\n❯ \r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";

describe("InteractiveClaudeEngine — soft interrupt", () => {
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

  it("is a soft-interruptible engine that keeps foreground work", () => {
    expect(isSoftInterruptibleEngine(engine)).toBe(true);
    expect(engine.softInterruptPreservesForegroundWork).toBe(true);
  });

  describe("foregroundWork", () => {
    it("is null with no turn, and for a session the engine does not know", async () => {
      expect(engine.foregroundWork("s-none")).toBeNull();
      await warmUp("s-idle");
      expect(engine.foregroundWork("s-idle")).toBeNull();
    });

    it("reports a call from its PreToolUse until its PostToolUse, with its start time and description", async () => {
      const { turn } = await runningTurn("s-fg");
      expect(engine.foregroundWork("s-fg")).toBeNull();
      vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
      preBash("s-fg");
      expect(engine.foregroundWork("s-fg")).toEqual({ tool: "Bash", startedAt: Date.parse("2026-01-01T00:00:10.000Z"), description: "Build it", backgroundable: true });
      deliver("s-fg", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: BASH_ID, tool_response: { stdout: "ok" } });
      expect(engine.foregroundWork("s-fg")).toBeNull();
      deliver("s-fg", { hook_event_name: "Stop", last_assistant_message: "done" });
      await turn;
    });

    it("names the call that has run longest, and falls back to the command for a description", async () => {
      const { turn } = await runningTurn("s-two");
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      preBash("s-two", "t1", { command: "make all" });
      vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
      deliver("s-two", { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t2", tool_input: { file_path: "/x" } });
      // The Read cannot be moved to the background, so an interrupt now would abort it: not backgroundable.
      expect(engine.foregroundWork("s-two")).toMatchObject({ tool: "Bash", description: "make all", backgroundable: false });
      deliver("s-two", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" });
      expect(engine.foregroundWork("s-two")).toMatchObject({ tool: "Read", backgroundable: false });
      deliver("s-two", { hook_event_name: "Stop", last_assistant_message: "done" });
      await turn;
    });

    it("ends a call on its failure too: a Bash that exits non-zero fires PostToolUseFailure and no PostToolUse", async () => {
      const { turn } = await runningTurn("s-failed");
      preBash("s-failed");
      expect(engine.foregroundWork("s-failed")).not.toBeNull();
      deliver("s-failed", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: BASH_ID, error: "Exit code 3" });
      expect(engine.foregroundWork("s-failed")).toBeNull();
      deliver("s-failed", { hook_event_name: "Stop", last_assistant_message: "done" });
      await turn;
    });

    it("reports a Bash backgroundable, and an MCP call or a sub-agent not", async () => {
      const { turn } = await runningTurn("s-kinds");
      deliver("s-kinds", { hook_event_name: "PreToolUse", tool_name: "mcp__docs__search", tool_use_id: "m1", tool_input: { query: "x" } });
      expect(engine.foregroundWork("s-kinds")).toMatchObject({ tool: "mcp__docs__search", backgroundable: false });
      deliver("s-kinds", { hook_event_name: "PostToolUse", tool_name: "mcp__docs__search", tool_use_id: "m1" });
      deliver("s-kinds", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "a1", tool_input: { prompt: "x" } });
      expect(engine.foregroundWork("s-kinds")).toMatchObject({ tool: "Agent", backgroundable: false });
      deliver("s-kinds", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "a1" });
      preBash("s-kinds");
      expect(engine.foregroundWork("s-kinds")).toMatchObject({ tool: "Bash", backgroundable: true });
      deliver("s-kinds", { hook_event_name: "Stop", last_assistant_message: "done" });
      await turn;
    });

    it("ignores a sub-agent's own tool calls", async () => {
      const { turn } = await runningTurn("s-sub");
      deliver("s-sub", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "sub1", agent_id: "agent-1", tool_input: { command: "x" } });
      expect(engine.foregroundWork("s-sub")).toBeNull();
      deliver("s-sub", { hook_event_name: "Stop", last_assistant_message: "done" });
      await turn;
    });

    it("is null while the call waits on a permission dialog, and once the turn is over", async () => {
      const { turn } = await runningTurn("s-perm");
      preBash("s-perm");
      deliver("s-perm", { hook_event_name: "Notification", notification_type: "permission_prompt" });
      expect(engine.foregroundWork("s-perm")).toBeNull();
      deliver("s-perm", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: BASH_ID });
      preBash("s-perm", "t9");
      expect(engine.foregroundWork("s-perm")).not.toBeNull();
      deliver("s-perm", { hook_event_name: "Stop", last_assistant_message: "done" });
      await turn;
      expect(engine.foregroundWork("s-perm")).toBeNull();
    });
  });

  describe("softInterrupt", () => {
    it("has nothing to do with no turn running, for a native command, or for an unknown session", async () => {
      expect(await engine.softInterrupt("s-none", "voice")).toEqual({ ended: false, reason: "no_turn" });
      await warmUp("s-idle");
      expect(await engine.softInterrupt("s-idle", "voice")).toEqual({ ended: false, reason: "no_turn" });
      const native = engine.run({ sessionId: "s-idle", prompt: "/usage", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(200);
      expect(await engine.softInterrupt("s-idle", "voice")).toEqual({ ended: false, reason: "no_turn" });
      deliver("s-idle", { hook_event_name: "Stop", last_assistant_message: "first answer" });
      await native;
      expect(keys()).toEqual([]);
    });

    it("moves a running Bash to the background (Ctrl+B), ends the turn (Esc), and reports the task: no release, no kill", async () => {
      const { turn } = await runningTurn("s-soft");
      preBash("s-soft");
      const pty = lifecycle.getWarm("s-soft");
      let outcome: unknown;
      void engine.softInterrupt("s-soft", "voice barge-in").then((o) => { outcome = o; });
      await vi.advanceTimersByTimeAsync(10);
      // Ctrl+B only: Esc waits for the task id, which Claude Code reports once the command is backgrounded.
      expect(keys()).toEqual([CTRL_B]);
      expect(outcome).toBeUndefined();
      backgrounded("s-soft", "bg-42");
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(200);
      expect(outcome).toEqual({ ended: true, backgrounded: [{ taskId: "bg-42", description: "Build it" }] });
      const result = await turn;
      // Esc fires no Stop: the engine settled the turn, softly interrupted, once.
      expect(result.error).toBe("Interrupted: voice barge-in");
      expect(keys().slice(0, 2)).toEqual([CTRL_B, ESC]);
      expect(released).toEqual([]);
      expect(killed).toEqual([]);
      expect(lifecycle.getWarm("s-soft")).toBe(pty);
      expect(ptys[0]!.kill).toBeDefined();
      expect(engine.holdsTurn("s-soft")).toBe(false);
    });

    it("settles the turn once: a late Stop of the interrupted turn changes nothing", async () => {
      const { turn } = await runningTurn("s-once");
      const results: Array<string | undefined> = [];
      void turn.then((r) => results.push(r.error));
      const done = engine.softInterrupt("s-once", "voice");
      await vi.advanceTimersByTimeAsync(300);
      await done;
      expect(results).toEqual(["Interrupted: voice"]);
      deliver("s-once", { hook_event_name: "Stop", last_assistant_message: "late" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(results).toEqual(["Interrupted: voice"]);
      expect(engine.holdsTurn("s-once")).toBe(false);
    });

    it("tracks the command it backgrounded as a background task of the session", async () => {
      const { turn } = await runningTurn("s-track");
      preBash("s-track");
      const done = engine.softInterrupt("s-track", "voice");
      await vi.advanceTimersByTimeAsync(10);
      backgrounded("s-track", "bg-7");
      await vi.advanceTimersByTimeAsync(500);
      await done;
      await turn;
      expect(engine.backgroundTasks("s-track").tasks.map((t) => t.id)).toEqual(["bg-7"]);
    });

    it("presses Ctrl+B again until the command is reported moved: Claude Code ignores it for the first seconds", async () => {
      const { turn } = await runningTurn("s-retry");
      preBash("s-retry");
      const done = engine.softInterrupt("s-retry", "voice");
      await vi.advanceTimersByTimeAsync(BACKGROUND_RETRY_MS * 3 + 100);
      expect(keys()).toEqual([CTRL_B, CTRL_B, CTRL_B, CTRL_B]);
      backgrounded("s-retry", "bg-late");
      await vi.advanceTimersByTimeAsync(500);
      // Reported: no more presses, then Esc.
      expect(keys().filter((k) => k === CTRL_B)).toHaveLength(4);
      expect(keys()[4]).toBe(ESC);
      expect(await done).toEqual({ ended: true, backgrounded: [{ taskId: "bg-late", description: "Build it" }] });
      await turn;
    });

    it("never presses Esc over a command it could not move: unsupported, and the turn keeps running", async () => {
      const { turn } = await runningTurn("s-silent");
      preBash("s-silent");
      let settled = false;
      void turn.then(() => { settled = true; });
      const done = engine.softInterrupt("s-silent", "voice");
      await vi.advanceTimersByTimeAsync(BACKGROUND_ACK_MS + 500);
      expect(await done).toEqual({ ended: false, reason: "unsupported" });
      // Only Ctrl+B was pressed, and repeatedly: no Esc, no composer clear.
      expect(keys().length).toBeGreaterThan(1);
      expect(keys().every((k) => k === CTRL_B)).toBe(true);
      expect(settled).toBe(false);
      expect(engine.holdsTurn("s-silent")).toBe(true);
      // The turn goes on and finishes by itself.
      deliver("s-silent", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: BASH_ID, tool_response: { stdout: "ok" } });
      deliver("s-silent", { hook_event_name: "Stop", last_assistant_message: "finished" });
      expect((await turn).result).toBe("finished");
      expect(released).toEqual([]);
      expect(killed).toEqual([]);
    });

    it("with no tool running presses Esc only, no Ctrl+B", async () => {
      const { turn } = await runningTurn("s-think");
      const done = engine.softInterrupt("s-think", "voice");
      await vi.advanceTimersByTimeAsync(300);
      expect(await done).toEqual({ ended: true, backgrounded: [] });
      expect((await turn).error).toBe("Interrupted: voice");
      expect(keys()[0]).toBe(ESC);
      expect(keys()).not.toContain(CTRL_B);
    });

    it.each([
      ["a non-Bash tool", [{ tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: "/x" } }]],
      ["an MCP call", [{ tool_name: "mcp__docs__search", tool_use_id: "m1", tool_input: { query: "x" } }]],
      ["a sub-agent", [{ tool_name: "Agent", tool_use_id: "a1", tool_input: { prompt: "x" } }]],
      ["a Bash running beside one", [{ tool_name: "Bash", tool_use_id: BASH_ID, tool_input: { command: "make" } }, { tool_name: "Read", tool_use_id: "r2", tool_input: { file_path: "/x" } }]],
    ])("does not abort %s: unsupported, no key pressed, the turn runs on", async (_name, calls) => {
      const { turn } = await runningTurn("s-nobg");
      for (const call of calls) deliver("s-nobg", { hook_event_name: "PreToolUse", ...call });
      expect(engine.foregroundWork("s-nobg")).toMatchObject({ backgroundable: false });
      expect(await engine.softInterrupt("s-nobg", "voice")).toEqual({ ended: false, reason: "unsupported" });
      expect(keys()).toEqual([]);
      expect(engine.holdsTurn("s-nobg")).toBe(true);
      for (const call of calls) deliver("s-nobg", { hook_event_name: "PostToolUse", tool_name: call.tool_name, tool_use_id: call.tool_use_id });
      deliver("s-nobg", { hook_event_name: "Stop", last_assistant_message: "finished" });
      expect((await turn).result).toBe("finished");
      expect(released).toEqual([]);
    });

    it("does not give a command the Bash tool ran as a sub-agent's the Ctrl+B", async () => {
      const { turn } = await runningTurn("s-agent");
      deliver("s-agent", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "a1", agent_id: "ag", tool_input: { command: "x" } });
      const done = engine.softInterrupt("s-agent", "voice");
      await vi.advanceTimersByTimeAsync(300);
      await done;
      expect(keys()).not.toContain(CTRL_B);
      await turn;
    });

    it("waits for the footer to stop saying a turn runs before it settles the turn", async () => {
      const { turn } = await runningTurn("s-footer");
      ptys[0]!.emit(RUNNING_FRAME);
      await vi.advanceTimersByTimeAsync(50);
      let settled = false;
      void turn.then(() => { settled = true; });
      const done = engine.softInterrupt("s-footer", "voice");
      await vi.advanceTimersByTimeAsync(500);
      expect(keys()).toEqual([ESC]);
      expect(settled).toBe(false);
      ptys[0]!.emit(IDLE_FRAME);
      await vi.advanceTimersByTimeAsync(500);
      await done;
      expect(settled).toBe(true);
    });

    it("gives up waiting for the footer after a few seconds, and still settles", async () => {
      const { turn } = await runningTurn("s-stuck");
      ptys[0]!.emit(RUNNING_FRAME);
      await vi.advanceTimersByTimeAsync(50);
      const done = engine.softInterrupt("s-stuck", "voice");
      await vi.advanceTimersByTimeAsync(INTERRUPT_SETTLE_MS + 500);
      expect(await done).toEqual({ ended: true, backgrounded: [] });
      expect((await turn).error).toBe("Interrupted: voice");
    });

    it("empties the composer before the turn settles, so a prompt Esc put back there is not the next turn's prefix", async () => {
      const { turn } = await runningTurn("s-composer", "line one\nline two\nline three");
      const done = engine.softInterrupt("s-composer", "voice");
      await vi.advanceTimersByTimeAsync(300);
      await done;
      await turn;
      const clearAt = writes().findIndex((w) => /^\x15+$/.test(w));
      expect(clearAt).toBeGreaterThan(writes().indexOf(ESC));
      expect(writes()[clearAt]).toBe("\x15".repeat(6));
      // The next turn pastes after the clear, never before it.
      const next = engine.run({ sessionId: "s-composer", prompt: "next prompt", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(300);
      const pasteAt = writes().findIndex((w) => w.includes("next prompt"));
      expect(pasteAt).toBeGreaterThan(clearAt);
      deliver("s-composer", { hook_event_name: "UserPromptSubmit", prompt: "next prompt" });
      deliver("s-composer", { hook_event_name: "Stop", last_assistant_message: "next answer" });
      expect((await next).result).toBe("next answer");
      expect(released).toEqual([]);
    });

    it("two calls at once send one Esc and share one outcome", async () => {
      const { turn } = await runningTurn("s-twice");
      const a = engine.softInterrupt("s-twice", "voice");
      const b = engine.softInterrupt("s-twice", "voice again");
      await vi.advanceTimersByTimeAsync(300);
      expect(await a).toEqual(await b);
      expect(keys().filter((k) => k === ESC)).toHaveLength(1);
      expect((await turn).error).toBe("Interrupted: voice");
      // A third, once it is over, finds no turn.
      expect(await engine.softInterrupt("s-twice", "late")).toEqual({ ended: false, reason: "no_turn" });
    });

    it("does not press Esc when the turn ends on its own while the command is being backgrounded", async () => {
      const { turn } = await runningTurn("s-race");
      preBash("s-race");
      const done = engine.softInterrupt("s-race", "voice");
      await vi.advanceTimersByTimeAsync(10);
      expect(keys()).toEqual([CTRL_B]);
      backgrounded("s-race", "bg-9");
      deliver("s-race", { hook_event_name: "Stop", last_assistant_message: "finished anyway" });
      await vi.advanceTimersByTimeAsync(300);
      expect(await done).toEqual({ ended: true, backgrounded: [{ taskId: "bg-9", description: "Build it" }] });
      expect((await turn).result).toBe("finished anyway");
      expect(keys()).toEqual([CTRL_B]);
    });

    it("leaves a turn whose paste is held behind a background re-run alone: the PTY is running somebody else's turn", async () => {
      await warmUp("s-held");
      // The re-run a finished background task opens, with no gateway turn running.
      deliver("s-held", { hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>" });
      const held = engine.run({ sessionId: "s-held", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(300);
      expect(engine.isTurnRunning("s-held")).toBe(true);
      expect(writes().some((w) => w.includes("second"))).toBe(false);
      // A barge-in now would Esc the re-run and settle a turn that never started.
      expect(await engine.softInterrupt("s-held", "voice")).toEqual({ ended: false, reason: "no_turn" });
      expect(keys()).toEqual([]);
      expect(engine.isTurnRunning("s-held")).toBe(true);
      // The re-run ends, and the held turn pastes and runs as usual.
      deliver("s-held", { hook_event_name: "Stop", last_assistant_message: "background done" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(writes().some((w) => w.includes("second"))).toBe(true);
      deliver("s-held", { hook_event_name: "UserPromptSubmit", prompt: "second" });
      deliver("s-held", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      expect((await held).result).toBe("second answer");
      expect(released).toEqual([]);
    });

    it("leaves a Rewind menu alone", async () => {
      const { turn } = await runningTurn("s-rewind");
      ptys[0]!.emit("   Rewind\r\n\r\n   Restore the code and/or conversation to the point before…\r\n\r\n     Reply with exactly the word READY.\r\n     No code changes\r\n\r\n   ❯ (current)\r\n\r\n   Enter to continue · Esc to cancel");
      await vi.advanceTimersByTimeAsync(50);
      expect(await engine.softInterrupt("s-rewind", "voice")).toEqual({ ended: false, reason: "unsupported" });
      expect(keys()).toEqual([]);
      deliver("s-rewind", { hook_event_name: "Stop", last_assistant_message: "done" });
      await turn;
    });

    it("a command that finishes later wakes the session as a turn of its own: the notification reaches the external-turn sync", async () => {
      const { turn } = await runningTurn("s-wake");
      preBash("s-wake");
      const done = engine.softInterrupt("s-wake", "voice");
      await vi.advanceTimersByTimeAsync(10);
      backgrounded("s-wake", "bg-5");
      await vi.advanceTimersByTimeAsync(500);
      await done;
      await turn;
      // Nothing runs on the gateway side now; Claude Code's wake-up is somebody else's turn.
      deliver("s-wake", { hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-id>bg-5</task-id>\n<status>completed</status>\n</task-notification>" });
      deliver("s-wake", { hook_event_name: "Stop", last_assistant_message: "the build finished" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(unclaimed.map((u) => u.text)).toContain("the build finished");
      expect(released).toEqual([]);
      expect(killed).toEqual([]);
    });
  });

  describe("claude-soft-interrupt helpers", () => {
    it("spots the running footer only while a turn runs", () => {
      expect(viewportShowsTurnRunning(["✻ Working…", "  ⏵⏵ bypass permissions on · esc to interrupt"])).toBe(true);
      expect(viewportShowsTurnRunning(["❯ ", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"])).toBe(false);
    });

    it("tracks anonymous calls (a hook with no tool_use_id) by order", () => {
      const calls = new ForegroundCalls();
      calls.onHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" } } as any, 100);
      calls.onHook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} } as any, 200);
      expect(calls.oldest()).toMatchObject({ tool: "Bash", startedAt: 100 });
      calls.onHook({ hook_event_name: "PostToolUse", tool_name: "Bash" } as any, 300);
      expect(calls.oldest()).toMatchObject({ tool: "Read" });
      calls.clear();
      expect(calls.oldest()).toBeNull();
    });

    it("counts a foreground command the CLI moved to the background as a launched task, and a plain one as none", () => {
      const post = (response: Record<string, unknown>) => ({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "make all", description: "Build" }, tool_response: response }) as any;
      expect(launchedBackgroundTask(post({ backgroundTaskId: "b1", backgroundedByUser: true }), 7)).toMatchObject({ kind: "process", id: "b1", command: "make all", description: "Build", startedAt: 7 });
      expect(launchedBackgroundTask(post({ backgroundTaskId: "b2", backgroundedByTurnAbort: true }), 7)).toMatchObject({ id: "b2" });
      expect(launchedBackgroundTask(post({ backgroundTaskId: "b3", backgroundedToDeliverMessage: true }), 7)).toMatchObject({ id: "b3" });
      // A command that ran in the foreground to its end launched nothing, even with a stray id.
      expect(launchedBackgroundTask(post({ backgroundTaskId: "b4" }), 7)).toBeNull();
      expect(launchedBackgroundTask(post({ stdout: "ok", backgroundedByUser: true }), 7)).toBeNull();
    });

    it("reads a background task from a PostToolUse only when it names one", () => {
      expect(backgroundedByPostToolUse({ hook_event_name: "PostToolUse", tool_response: { stdout: "x" } } as any)).toBeNull();
      expect(backgroundedByPostToolUse({ hook_event_name: "PreToolUse", tool_response: { backgroundTaskId: "b" } } as any)).toBeNull();
      expect(backgroundedByPostToolUse({ hook_event_name: "PostToolUse", agent_id: "a", tool_response: { backgroundTaskId: "b" } } as any)).toBeNull();
      expect(backgroundedByPostToolUse({ hook_event_name: "PostToolUse", tool_use_id: "t", tool_input: { command: "c" }, tool_response: { backgroundTaskId: "b" } } as any))
        .toEqual({ taskId: "b", description: "c", toolUseId: "t" });
    });
  });
});
