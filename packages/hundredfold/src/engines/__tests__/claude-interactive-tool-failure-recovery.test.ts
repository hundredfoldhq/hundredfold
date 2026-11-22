import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Lost-Stop recovery after a tool call that failed. Claude Code fires PostToolUseFailure, and no
 * PostToolUse, for a call that fails (a Bash that exits non-zero, a Read of a missing file; verified
 * on 2.1.330). The turn counts a call as running from PreToolUse until one of the two arrives, and
 * recovery of a Stop that never came waits for nothing to be running.
 */

const transcriptFile = { path: "" };
vi.mock("../claude-transcript-path.js", () => ({
  findSessionTranscript: () => transcriptFile.path || undefined,
}));

interface FakePty {
  pid: number;
  _exitCode: number | null;
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
      pid: 4000 + ptys.length,
      _exitCode: null,
      onData() {},
      onExit() {},
      kill() {},
      write() {},
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
    async start() { return 41400; }
    stop() {}
  },
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";

const RECOVERED = "The file does not exist, so I could not read it.";

describe("InteractiveClaudeEngine — lost-Stop recovery after a failed tool call", () => {
  let registry: HookRegistry;
  let engine: InteractiveClaudeEngine;
  let dir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    ptys.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-failed-tool-"));
    transcriptFile.path = path.join(dir, "c1.jsonl");
    registry = new HookRegistry(30_000, 5_000, 2_000);
    engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 4 }), registry);
  });

  afterEach(() => {
    registry.dispose?.();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A turn that ran one tool call whose end hook is `endHook`, and whose Stop was lost. */
  async function turnWithLostStop(id: string, endHook: string | null) {
    let settled: { result?: string; error?: string } | undefined;
    const turn = engine.run({ sessionId: id, prompt: "read the file", cwd: "/tmp" } as any).then((r) => { settled = r; return r; });
    await vi.advanceTimersByTimeAsync(20);
    registry.deliver(id, { hook_event_name: "SessionStart", session_id: "c1" });
    registry.deliver(id, { hook_event_name: "PreToolUse", tool_name: "Read" });
    if (endHook) registry.deliver(id, { hook_event_name: endHook, tool_name: "Read", error: "File does not exist" });
    // No Stop is ever delivered: the model's closing text is only in the transcript.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    fs.writeFileSync(transcriptFile.path, JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: RECOVERED }] },
    }) + "\n");
    await vi.advanceTimersByTimeAsync(60_000);
    return { turn, settled: () => settled };
  }

  it("recovers the answer from the transcript after PostToolUseFailure", async () => {
    const { turn, settled } = await turnWithLostStop("s-failed", "PostToolUseFailure");
    expect(settled()?.result).toBe(RECOVERED);
    expect((await turn).error).toBeUndefined();
  });

  it("recovers the same after a PostToolUse (the same lifecycle)", async () => {
    const { turn, settled } = await turnWithLostStop("s-succeeded", "PostToolUse");
    expect(settled()?.result).toBe(RECOVERED);
    await turn;
  });

  it("holds recovery off while a call has neither ended nor failed", async () => {
    const { settled } = await turnWithLostStop("s-running", null);
    expect(settled()).toBeUndefined();
    engine.kill("s-running", "Interrupted: test over");
  });
});
