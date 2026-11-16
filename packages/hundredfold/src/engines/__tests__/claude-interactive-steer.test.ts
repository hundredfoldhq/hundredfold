import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * An input handed to a running claude turn with steer().
 *
 * Verified on claude 2.1.325: a message pasted while a turn runs is queued and
 * its UserPromptSubmit fires at once. At the turn's next tool boundary Claude
 * Code folds it into the turn (a `queued_command` transcript entry, one Stop
 * for both). A turn that ends first is followed by the message as a turn of its
 * own: dequeued about 40 ms after the Stop, with a Stop of its own.
 *
 * A real HookRegistry is used on purpose: its tap, buffer replay and
 * unclaimed-Stop handoff are part of what is being tested.
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

import { InteractiveClaudeEngine, TERMINAL_TURN_QUIET_MS, queuedPromptsTakenIn } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";
import { isSteerableEngine } from "../../shared/types.js";

const STEER = "STEER-MSG: also add the single word PINEAPPLE to your final answer.";

/** The queued message folded into a running turn, as claude 2.1.325 writes it. */
const foldedLine = (prompt: string) => JSON.stringify({
  type: "attachment",
  timestamp: new Date().toISOString(),
  attachment: { type: "queued_command", prompt, source_uuid: "00000000-0000-4000-8000-000000000001", delivery_id: "00000000-0000-4000-8000-000000000002" },
}) + "\n";
const enqueuedLine = () => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString() }) + "\n";

/** Claude Code's Esc Esc Rewind menu (the stage-1 list) as drawn. */
const REWIND_MENU_FRAME = [
  "   Rewind",
  "",
  "   Restore the code and/or conversation to the point before…",
  "",
  "     Reply with exactly the word READY.",
  "     No code changes",
  "",
  "   ❯ (current)",
  "",
  "   Enter to continue · Esc to cancel",
].join("\r\n");

describe("InteractiveClaudeEngine — steering a running turn", () => {
  let registry: HookRegistry;
  let engine: InteractiveClaudeEngine;
  let unclaimed: Array<{ id: string; text: string }>;
  let dir: string;
  let transcript: string;

  beforeEach(() => {
    vi.useFakeTimers();
    ptys.length = 0;
    unclaimed = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-steer-"));
    transcript = path.join(dir, "c1.jsonl");
    fs.writeFileSync(transcript, '{"type":"user","message":{"content":"second"}}\n');
    registry = new HookRegistry(30_000, 5_000, 2_000);
    registry.setUnclaimedHookHandler((id, h) => { unclaimed.push({ id, text: String(h.last_assistant_message ?? "") }); });
    engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 10 }), registry);
  });

  afterEach(() => {
    registry.dispose?.();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A Stop that names the transcript makes run() wait (on real timers) for its answer to be written there.
  const deliver = (id: string, h: Record<string, unknown>) =>
    registry.deliver(id, (h.hook_event_name === "Stop" ? h : { transcript_path: transcript, ...h }) as any);
  const pasted = (text: string) => ptys[0]!.writes.some((w) => w.includes(text));
  const crs = () => ptys[0]!.writes.filter((w) => w === "\r").length;
  /** Ctrl+U writes: what clears the composer. */
  const cleared = () => ptys[0]!.writes.some((w) => /^\x15+$/.test(w));

  async function warmUp(id: string): Promise<void> {
    const turn = engine.run({ sessionId: id, prompt: "first", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    deliver(id, { hook_event_name: "SessionStart", session_id: "c1" });
    deliver(id, { hook_event_name: "Stop", last_assistant_message: "first answer" });
    expect((await turn).result).toBe("first answer");
  }

  /** A gateway turn on the warm PTY, past its own UserPromptSubmit and into a tool. */
  async function runningTurn(id: string, prompt = "second") {
    await warmUp(id);
    const turn = engine.run({ sessionId: id, prompt, cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    deliver(id, { hook_event_name: "UserPromptSubmit", prompt });
    deliver(id, { hook_event_name: "PreToolUse", tool_name: "Bash" });
    return { turn };
  }

  /** Steer, send the CR, and let Claude Code acknowledge it as a queued message. */
  async function steerAcknowledged(id: string, text = STEER) {
    const outcome = engine.steer(id, text);
    await vi.advanceTimersByTimeAsync(400);
    deliver(id, { hook_event_name: "UserPromptSubmit", prompt: ` ${text}` });
    return outcome;
  }

  it("is a steerable engine", () => {
    expect(isSteerableEngine(engine)).toBe(true);
  });

  describe("canSteer", () => {
    it("is false with no turn running, and for a session the engine does not know", async () => {
      expect(engine.canSteer("s-none")).toBe(false);
      await warmUp("s-idle");
      expect(engine.canSteer("s-idle")).toBe(false);
    });

    it("is false until the turn's own prompt has been submitted, true while it runs, false once it ends", async () => {
      await warmUp("s-can");
      const turn = engine.run({ sessionId: "s-can", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(200);
      // Pasted, not yet acknowledged: nothing is running to hand an input to.
      expect(engine.canSteer("s-can")).toBe(false);
      deliver("s-can", { hook_event_name: "UserPromptSubmit", prompt: "second" });
      expect(engine.canSteer("s-can")).toBe(true);
      deliver("s-can", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
      expect(engine.canSteer("s-can")).toBe(false);
    });

    it("is false for a native command", async () => {
      await warmUp("s-native");
      const native = engine.run({ sessionId: "s-native", prompt: "/usage", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(200);
      expect(engine.canSteer("s-native")).toBe(false);
      deliver("s-native", { hook_event_name: "Stop", last_assistant_message: "first answer" });
      await native;
    });

    it("is false while the TUI is blocked on a permission dialog, and once someone typed into the terminal", async () => {
      const { turn } = await runningTurn("s-blocked");
      expect(engine.canSteer("s-blocked")).toBe(true);
      deliver("s-blocked", { hook_event_name: "Notification", notification_type: "permission_prompt" });
      expect(engine.canSteer("s-blocked")).toBe(false);
      deliver("s-blocked", { hook_event_name: "PostToolUse", tool_name: "Bash" });
      expect(engine.canSteer("s-blocked")).toBe(true);
      // An operator message typed into the terminal and queued behind the turn.
      deliver("s-blocked", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
      expect(engine.canSteer("s-blocked")).toBe(false);
      deliver("s-blocked", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
    });

    it("is false once the PTY is gone", async () => {
      const { turn } = await runningTurn("s-gone");
      expect(engine.canSteer("s-gone")).toBe(true);
      engine.kill("s-gone");
      expect(engine.canSteer("s-gone")).toBe(false);
      await turn;
    });
  });

  describe("steer", () => {
    it("with no turn running: withdrawn, and nothing is written to the PTY", async () => {
      await warmUp("s-no-turn");
      const before = ptys[0]!.writes.length;
      expect(await engine.steer("s-no-turn", STEER)).toBe("withdrawn");
      expect(ptys[0]!.writes.length).toBe(before);
    });

    it("pastes the input into the busy TUI and submits it, without interrupting anything", async () => {
      const { turn } = await runningTurn("s-paste");
      const before = ptys[0]!.writes.length;
      void steerAcknowledged("s-paste");
      await vi.advanceTimersByTimeAsync(400);
      const writes = ptys[0]!.writes.slice(before);
      expect(writes[0]).toBe(`\x1b[200~${STEER}\x1b[201~`);
      expect(writes).toContain("\r");
      // No Esc, no Ctrl+C, no signal: the running turn is not cut off.
      expect(writes.some((w) => /[\x03\x1b](?!\[200~|\[201~)/.test(w.replace(/\x1b\[20[01]~/g, "")))).toBe(false);
      deliver("s-paste", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
    });

    it("folded at a tool boundary: steered while the turn still runs, one Stop, no second turn to wait for", async () => {
      const { turn } = await runningTurn("s-fold");
      const outcome = steerAcknowledged("s-fold");
      let settled: string | undefined;
      void outcome.then((o) => { settled = o; });
      await vi.advanceTimersByTimeAsync(1_000);
      // Queued, not yet read by the model: the hand-over is still open.
      expect(settled).toBeUndefined();
      fs.appendFileSync(transcript, enqueuedLine() + foldedLine(STEER));
      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBe("steered");
      expect(engine.isTurnRunning("s-fold")).toBe(true);
      // The one Stop carries the answer to both.
      deliver("s-fold", { hook_event_name: "PostToolUse", tool_name: "Bash" });
      deliver("s-fold", { hook_event_name: "Stop", last_assistant_message: "second answer PINEAPPLE" });
      expect((await turn).result).toBe("second answer PINEAPPLE");
      // Nothing is typed into the terminal behind it: the next turn pastes at once.
      const next = engine.run({ sessionId: "s-fold", prompt: "third", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(300);
      expect(pasted("third")).toBe(true);
      deliver("s-fold", { hook_event_name: "UserPromptSubmit", prompt: "third" });
      deliver("s-fold", { hook_event_name: "Stop", last_assistant_message: "third answer" });
      await next;
      expect(unclaimed).toEqual([]);
    });

    it("a queued entry alone is not taken in: the turn must have folded it", async () => {
      const { turn } = await runningTurn("s-queued-only");
      let settled: string | undefined;
      void steerAcknowledged("s-queued-only").then((o) => { settled = o; });
      await vi.advanceTimersByTimeAsync(400);
      fs.appendFileSync(transcript, enqueuedLine());
      // A queued_command for some other message does not count either.
      fs.appendFileSync(transcript, foldedLine("a different message"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBeUndefined();
      deliver("s-queued-only", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
      await vi.advanceTimersByTimeAsync(10);
    });

    it("a multi-line input is matched through the <pasted_content> wrapper Claude Code records it in", async () => {
      const { turn } = await runningTurn("s-multi");
      const text = "/notacommand STEER-C: also add PAPAYA\n  `inline code`\n```js\nconst x = 1;\n```\n@file !bang trailing   ";
      // As claude 2.1.325 records a message of four or more lines sent mid-turn: in the
      // UserPromptSubmit and the transcript alike, with an id of its own.
      const wrapped = `<pasted_content id="844f">\n${text}\n</pasted_content id="844f">`;
      let settled: string | undefined;
      const outcome = engine.steer("s-multi", text);
      void outcome.then((o) => { settled = o; });
      await vi.advanceTimersByTimeAsync(400);
      deliver("s-multi", { hook_event_name: "UserPromptSubmit", prompt: wrapped });
      // It was acknowledged: no terminal turn is held for it.
      deliver("s-multi", { hook_event_name: "PostToolUse", tool_name: "Bash" });
      fs.appendFileSync(transcript, enqueuedLine() + foldedLine(wrapped));
      await vi.advanceTimersByTimeAsync(600);
      expect(settled).toBe("steered");
      deliver("s-multi", { hook_event_name: "Stop", last_assistant_message: "second answer PAPAYA" });
      expect((await turn).result).toBe("second answer PAPAYA");
      const next = engine.run({ sessionId: "s-multi", prompt: "third", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(300);
      expect(pasted("third")).toBe(true);
      deliver("s-multi", { hook_event_name: "UserPromptSubmit", prompt: "third" });
      deliver("s-multi", { hook_event_name: "Stop", last_assistant_message: "third answer" });
      await next;
    });

    it("two inputs sent at once that Claude Code merges into one message are both taken in", async () => {
      const { turn } = await runningTurn("s-merged");
      const results: string[] = [];
      void engine.steer("s-merged", "STEER-A: also add MANGO").then((o) => results.push(`a:${o}`));
      void engine.steer("s-merged", "STEER-B: also add KIWI").then((o) => results.push(`b:${o}`));
      await vi.advanceTimersByTimeAsync(400);
      // The composer held both pastes when it was submitted: one message.
      deliver("s-merged", { hook_event_name: "UserPromptSubmit", prompt: "STEER-A: also add MANGOSTEER-B: also add KIWI" });
      fs.appendFileSync(transcript, foldedLine("STEER-A: also add MANGOSTEER-B: also add KIWI"));
      await vi.advanceTimersByTimeAsync(600);
      expect(results.sort()).toEqual(["a:steered", "b:steered"]);
      deliver("s-merged", { hook_event_name: "Stop", last_assistant_message: "second answer MANGO KIWI" });
      await turn;
      // The one prompt was recognised as both inputs: nothing typed into the terminal is waited for.
      const next = engine.run({ sessionId: "s-merged", prompt: "third", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(300);
      expect(pasted("third")).toBe(true);
      deliver("s-merged", { hook_event_name: "UserPromptSubmit", prompt: "third" });
      deliver("s-merged", { hook_event_name: "Stop", last_assistant_message: "third answer" });
      await next;
    });

    it("an input identical to an earlier one is not taken in by the earlier one's entry", async () => {
      const { turn } = await runningTurn("s-same");
      // Another input stays outstanding, so the transcript watch outlives the first.
      void steerAcknowledged("s-same", "a different input, still queued");
      await vi.advanceTimersByTimeAsync(400);
      let first: string | undefined;
      void steerAcknowledged("s-same").then((o) => { first = o; });
      await vi.advanceTimersByTimeAsync(400);
      fs.appendFileSync(transcript, foldedLine(STEER));
      await vi.advanceTimersByTimeAsync(600);
      expect(first).toBe("steered");
      // The same text again: the first's entry is not its own.
      let second: string | undefined;
      void steerAcknowledged("s-same").then((o) => { second = o; });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(second).toBeUndefined();
      fs.appendFileSync(transcript, foldedLine(STEER));
      await vi.advanceTimersByTimeAsync(600);
      expect(second).toBe("steered");
      deliver("s-same", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
      await vi.advanceTimersByTimeAsync(5_000);
    });

    it("an input with nothing in it is withdrawn without being pasted", async () => {
      await runningTurn("s-blank");
      const before = ptys[0]!.writes.length;
      const outcome = engine.steer("s-blank", "  \n ");
      await vi.advanceTimersByTimeAsync(500);
      expect(await outcome).toBe("withdrawn");
      expect(ptys[0]!.writes.length).toBe(before);
      engine.kill("s-blank");
    });

    it("the turn ends before taking it: steered (it can no longer be taken back), and the session is held for the turn Claude Code runs it as", async () => {
      const { turn } = await runningTurn("s-unfolded");
      const outcome = steerAcknowledged("s-unfolded");
      await vi.advanceTimersByTimeAsync(400);
      deliver("s-unfolded", { hook_event_name: "PostToolUse", tool_name: "Bash" });
      deliver("s-unfolded", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      // The gateway turn keeps its own answer; the steered input's answer is the next Stop.
      expect((await turn).result).toBe("second answer");
      expect(await outcome).toBe("steered");

      // The steered input is running as Claude Code's next turn: a new gateway
      // turn must not be pasted behind it.
      const next = engine.run({ sessionId: "s-unfolded", prompt: "third", cwd: "/tmp", resumeSessionId: "c1" } as any);
      ptys[0]!.emit("✻");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pasted("third")).toBe(false);

      // Its Stop is unclaimed and reaches the external-turn sync, like any turn typed into the terminal.
      deliver("s-unfolded", { hook_event_name: "Stop", last_assistant_message: "PINEAPPLE" });
      await vi.advanceTimersByTimeAsync(TERMINAL_TURN_QUIET_MS);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(unclaimed).toEqual([{ id: "s-unfolded", text: "PINEAPPLE" }]);
      expect(pasted("third")).toBe(true);
      deliver("s-unfolded", { hook_event_name: "UserPromptSubmit", prompt: "third" });
      deliver("s-unfolded", { hook_event_name: "Stop", last_assistant_message: "third answer" });
      expect((await next).result).toBe("third answer");
    });

    it("Claude Code never takes the paste: after the CR retries it is withdrawn and the composer is cleared", async () => {
      const { turn } = await runningTurn("s-swallowed");
      const crsBefore = crs();
      const outcome = engine.steer("s-swallowed", STEER);
      // No UserPromptSubmit ever arrives, and nothing is busy (no tool running).
      deliver("s-swallowed", { hook_event_name: "PostToolUse", tool_name: "Bash" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await outcome).toBe("withdrawn");
      expect(crs() - crsBefore).toBeGreaterThan(1); // retried
      expect(cleared()).toBe(true);
      // The turn it was meant for was not cut off.
      expect(engine.isTurnRunning("s-swallowed")).toBe(true);
      deliver("s-swallowed", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      expect((await turn).result).toBe("second answer");
    });

    it("the turn ends before the submit CR was even written: the paste is cleared, never submitted", async () => {
      const { turn } = await runningTurn("s-early-end");
      const crsBefore = crs();
      const outcome = engine.steer("s-early-end", STEER);
      // The screen read resolves, the paste is written; the turn ends in the 150ms before the CR.
      await vi.advanceTimersByTimeAsync(50);
      expect(pasted(STEER)).toBe(true);
      deliver("s-early-end", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
      expect(await outcome).toBe("withdrawn");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(crs()).toBe(crsBefore);
      expect(cleared()).toBe(true);
    });

    it("the turn ends with the submit written but not yet acknowledged: a late acknowledgement is steered, not answered twice", async () => {
      const { turn } = await runningTurn("s-late-ack");
      const crsBefore = crs();
      const outcome = engine.steer("s-late-ack", STEER);
      await vi.advanceTimersByTimeAsync(300);
      expect(crs()).toBe(crsBefore + 1);
      deliver("s-late-ack", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
      await vi.advanceTimersByTimeAsync(300);
      deliver("s-late-ack", { hook_event_name: "UserPromptSubmit", prompt: ` ${STEER}` });
      expect(await outcome).toBe("steered");
      expect(cleared()).toBe(false);
    });

    it("the turn ends with the submit written and never acknowledged: withdrawn once the grace window passes", async () => {
      const { turn } = await runningTurn("s-never-ack");
      const outcome = engine.steer("s-never-ack", STEER);
      await vi.advanceTimersByTimeAsync(300);
      deliver("s-never-ack", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toBe("withdrawn");
      expect(cleared()).toBe(true);
    });

    it("the grace window's clear leaves the composer alone once the next turn has begun pasting into it", async () => {
      const { turn } = await runningTurn("s-owner");
      const outcome = engine.steer("s-owner", STEER);
      await vi.advanceTimersByTimeAsync(300);
      deliver("s-owner", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
      // The next gateway turn pastes its prompt inside the window, before its own CR.
      const next = engine.run({ sessionId: "s-owner", prompt: "third", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(100);
      const writesBefore = ptys[0]!.writes.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toBe("withdrawn");
      expect(ptys[0]!.writes.slice(writesBefore).some((w) => /^\x15+$/.test(w))).toBe(false);
      engine.kill("s-owner");
      await next;
    });

    it("the PTY dies with the input queued: withdrawn, it was never delivered", async () => {
      const { turn } = await runningTurn("s-killed");
      const outcome = steerAcknowledged("s-killed");
      await vi.advanceTimersByTimeAsync(400);
      engine.kill("s-killed");
      await turn;
      expect(await outcome).toBe("withdrawn");
    });

    it("a dialog on the screen (the Rewind menu): withdrawn, nothing pasted", async () => {
      const { turn } = await runningTurn("s-rewind");
      ptys[0]!.emit(REWIND_MENU_FRAME);
      const before = ptys[0]!.writes.length;
      const outcome = engine.steer("s-rewind", STEER);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await outcome).toBe("withdrawn");
      expect(ptys[0]!.writes.length).toBe(before);
      deliver("s-rewind", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
    });

    it("two inputs in one turn are each settled by their own entry", async () => {
      const { turn } = await runningTurn("s-two");
      const results: string[] = [];
      void steerAcknowledged("s-two", "first steer").then((o) => results.push(`first:${o}`));
      await vi.advanceTimersByTimeAsync(400);
      void steerAcknowledged("s-two", "second steer").then((o) => results.push(`second:${o}`));
      await vi.advanceTimersByTimeAsync(400);
      fs.appendFileSync(transcript, foldedLine("second steer"));
      await vi.advanceTimersByTimeAsync(600);
      expect(results).toEqual(["second:steered"]);
      fs.appendFileSync(transcript, foldedLine("first steer"));
      await vi.advanceTimersByTimeAsync(600);
      expect(results).toEqual(["second:steered", "first:steered"]);
      deliver("s-two", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      await turn;
    });
  });

  describe("existing turn handling is unchanged", () => {
    it("stop (kill) interrupts a turn that has no steer exactly as before", async () => {
      const { turn } = await runningTurn("s-stop");
      engine.kill("s-stop", "Interrupted: stopped");
      const r = await turn;
      expect(r.error).toMatch(/Interrupted/);
      expect(engine.hasWarmPty("s-stop")).toBe(false);
    });

    it("a prompt typed into the terminal while a turn runs still holds the next gateway turn", async () => {
      const { turn } = await runningTurn("s-typed");
      deliver("s-typed", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
      deliver("s-typed", { hook_event_name: "Stop", last_assistant_message: "second answer" });
      expect((await turn).result).toBe("second answer");
      const next = engine.run({ sessionId: "s-typed", prompt: "third", cwd: "/tmp", resumeSessionId: "c1" } as any);
      ptys[0]!.emit("✻");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pasted("third")).toBe(false);
      engine.kill("s-typed");
      await next;
    });
  });
});

describe("queuedPromptsTakenIn", () => {
  it("reads the prompts folded into a turn, whitespace-collapsed, and nothing else", () => {
    const text = [
      enqueuedLine().trim(),
      JSON.stringify({ type: "attachment", attachment: { type: "date", date: "2026-11-16" } }),
      foldedLine("  STEER   one\nline ").trim(),
      JSON.stringify({ type: "user", message: { content: "a queued_command mentioned in prose" } }),
      "not json but mentions \"queued_command\"",
      JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
    ].join("\n");
    expect(queuedPromptsTakenIn(text)).toEqual(["STEER one line"]);
  });

  it("reads a wrapped multi-line message without its tags", () => {
    const wrapped = '<pasted_content id="844f">\nL1 a\nL2 b\nL3 c\nL4 d\n</pasted_content id="844f">';
    expect(queuedPromptsTakenIn(foldedLine(wrapped))).toEqual(["L1 a L2 b L3 c L4 d"]);
  });

  it("matches the real 2.1.325 transcript shape", () => {
    const real = '{"parentUuid":"b3","isSidechain":false,"attachment":{"type":"queued_command","prompt":"STEER-MSG: also add the single word PINEAPPLE to your final answer.","source_uuid":"00000000-0000-4000-8000-000000000001","delivery_id":"00000000-0000-4000-8000-000000000002"},"type":"attachment","uuid":"1c","timestamp":"2026-11-16T13:26:14.790Z"}\n';
    expect(queuedPromptsTakenIn(real)).toEqual(["STEER-MSG: also add the single word PINEAPPLE to your final answer."]);
  });
});
