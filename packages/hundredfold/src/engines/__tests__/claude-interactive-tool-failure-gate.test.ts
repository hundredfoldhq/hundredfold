import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PostToolUseFailure is registered only for a Claude Code that knows the event: an unknown hook
 * event in `--settings` stops an unattended PTY at a "Settings Warning" dialog. This drives a real
 * turn start with stand-in binaries and reads what the engine asked the settings writer for.
 */

const settingsAsked: Array<Record<string, unknown>> = [];
vi.mock("../../shared/claude-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-settings.js")>()),
  writeSessionSettings: (_dir: string, _id: string, opts: Record<string, unknown>) => {
    settingsAsked.push(opts);
    return "/tmp/fake-settings.json";
  },
}));
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    pid: 5000, _exitCode: null, onData() {}, onExit() {}, kill() {}, write() {}, resize() {}, on() {},
  })),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- hundredfold-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41500; }
    stop() {}
  },
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";
import { clearToolFailureHookCacheForTests } from "../../shared/claude-tool-failure-hook.js";

describe("InteractiveClaudeEngine — which sessions register PostToolUseFailure", () => {
  let dir: string;
  let registry: HookRegistry;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    settingsAsked.length = 0;
    clearToolFailureHookCacheForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-failure-gate-"));
    registry = new HookRegistry();
    engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 4 }), registry);
  });
  afterEach(() => {
    registry.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeClaude(name: string, output: string): string {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, `#!/bin/sh\necho '${output}'\n`, { mode: 0o755 });
    return bin;
  }

  /** Start a turn on `bin`, take what the settings writer was asked for, and stop the turn. */
  async function askedFor(id: string, bin: string): Promise<Record<string, unknown>> {
    const turn = engine.run({ sessionId: id, prompt: "hi", cwd: "/tmp", bin } as any);
    for (let i = 0; i < 50 && settingsAsked.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(settingsAsked.length).toBeGreaterThan(0);
    const asked = settingsAsked[0]!;
    engine.kill(id, "Interrupted: test over");
    await turn;
    return asked;
  }

  it("asks for it on a build that knows the event", async () => {
    expect((await askedFor("gate-new", fakeClaude("new", "2.1.330 (Claude Code)"))).toolFailureHook).toBe(true);
  });

  it("does not ask for it on an older build, on one that does not say its version, or on one that cannot be run", async () => {
    expect((await askedFor("gate-old", fakeClaude("old", "2.0.40 (Claude Code)"))).toolFailureHook).toBeUndefined();
    settingsAsked.length = 0;
    expect((await askedFor("gate-silent", fakeClaude("silent", "unknown"))).toolFailureHook).toBeUndefined();
    settingsAsked.length = 0;
    expect((await askedFor("gate-missing", path.join(dir, "missing-claude"))).toolFailureHook).toBeUndefined();
  });
});
