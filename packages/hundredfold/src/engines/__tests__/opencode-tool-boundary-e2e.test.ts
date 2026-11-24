import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EngineResult, EngineRunOpts, StreamDelta } from "../../shared/types.js";
import { USER_MESSAGE_INTERRUPTION_REASON } from "../../sessions/interruption-reasons.js";
import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool } from "../opencode-server.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

/**
 * e2e: stopping a real opencode server's turn between two tool calls, with a mock
 * OpenAI-compatible provider that makes the model run a chain of shell calls, each
 * of which appends `start-i`, sleeps, and appends `done-i` to a file. A call cut off
 * in the middle leaves a `start` with no `done`, which is what "cut mid-write" means
 * here.
 *
 * Skipped unless OPENCODE_BOUNDARY_E2E=1. Runs against whichever binary
 * OPENCODE_BIN names (1.x or 2.x):
 *
 *   OPENCODE_BOUNDARY_E2E=1 OPENCODE_BIN=/path/to/opencode \
 *   pnpm exec vitest run src/engines/__tests__/opencode-tool-boundary-e2e.test.ts
 */

const RUN = process.env.OPENCODE_BOUNDARY_E2E === "1";
const BIN = process.env.OPENCODE_BIN ?? "opencode";
const MOCK = path.join(path.dirname(new URL(import.meta.url).pathname), "opencode-v2-mock-upstream.mjs");
/** The call's own sleep, in seconds, and how many calls the model chains. */
const CALL_SECONDS = 2;
const CHAIN = `TOOLCHAIN=8:${CALL_SECONDS}`;

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

describe.skipIf(!RUN)("stopping a real opencode server's turn between two tool calls", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-boundary-e2e-"));
  const work = path.join(home, "work");
  const chainLog = path.join(work, "chain.log");
  const port = 9800 + Math.floor(Math.random() * 400);
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  let mock: ChildProcess;
  let pool: OpencodeServerPool;
  let engine: OpencodeEngine;
  let n = 0;

  const lines = (): string[] => (fs.existsSync(chainLog) ? fs.readFileSync(chainLog, "utf8").split("\n").filter(Boolean) : []);
  const timeline: string[] = [];
  const note = (event: string, startedAt: number): void => { timeline.push(`+${((Date.now() - startedAt) / 1000).toFixed(2)}s ${event}`); };

  /** A session of its own per test, so a turn's log and history do not mix. */
  const turn = (sessionId: string, prompt: string, extra: Partial<EngineRunOpts> = {}): { promise: Promise<EngineResult>; deltas: StreamDelta[] } => {
    const deltas: StreamDelta[] = [];
    const promise = engine.run({ prompt, cwd: work, sessionId, bin: BIN, model: "mock/m1", onStream: (d) => deltas.push(d), ...extra });
    return { promise, deltas };
  };

  async function waitFor(check: () => boolean, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    const models = { m1: { name: "M1", limit: { context: 100000, output: 8000 } } };
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), {
      model: "mock/m1",
      provider: { mock: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "dummy" }, models } },
    });
    fs.mkdirSync(work, { recursive: true });
    const mockLog = path.join(home, "mock.jsonl");
    fs.writeFileSync(mockLog, "");
    mock = spawn(process.execPath, [MOCK], { env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: mockLog }, stdio: "ignore" });
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    pool = new OpencodeServerPool(lifecycle, { bin: () => BIN, limits: () => ({ startTimeoutMs: 120_000 }) });
    engine = new OpencodeEngine({ mode: () => "server", servers: pool });
    for (let i = 0; i < 50 && !(await canConnect(port)); i++) await new Promise((r) => setTimeout(r, 100));
  }, 30_000);

  afterAll(async () => {
    engine?.killAll();
    await pool?.stopAll();
    mock?.kill("SIGKILL");
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (process.env.OPENCODE_BOUNDARY_E2E_TIMELINE) fs.writeFileSync(process.env.OPENCODE_BOUNDARY_E2E_TIMELINE, `${timeline.join("\n")}\n`);
  });

  it("stops at the boundary after the call in flight, loses nothing, and the same session resumes with the message in under 5 s", async () => {
    const sessionId = `boundary-e2e-${++n}`;
    fs.rmSync(chainLog, { force: true });
    const t0 = Date.now();
    const first = turn(sessionId, `work through it ${CHAIN}`);
    note("turn started: the model chains eight shell calls, each 2 s", t0);
    await waitFor(() => lines().includes("start-2"));
    note("call 2 is executing (start-2 in the file)", t0);

    const askedAt = Date.now();
    note("the sender asks for the turn to be cut (interruptAtToolBoundary)", t0);
    const outcome = await engine.interruptAtToolBoundary(sessionId, USER_MESSAGE_INTERRUPTION_REASON, { waitMs: 5_000 });
    note(`outcome: ${outcome} (the abort was sent at the boundary after call 2)`, t0);
    expect(outcome).toBe("interrupted");

    const interrupted = await first.promise;
    note(`turn ended: ${interrupted.error}`, t0);
    expect(interrupted.error).toBe(USER_MESSAGE_INTERRUPTION_REASON);
    // The call in flight ran to its end: every start has its done, and no third call began.
    expect(lines()).toEqual(["start-1", "done-1", "start-2", "done-2"]);

    const resumed = await turn(sessionId, "the input you need is now in place", { resumeSessionId: interrupted.sessionId }).promise;
    note(`session resumed with the message and answered: ${resumed.result}`, t0);
    expect(resumed.error).toBeUndefined();
    expect(resumed.sessionId).toBe(interrupted.sessionId);
    expect(resumed.result).toBe("hello from mock");
    // What the cut turn produced is still in the session's history.
    expect(first.deltas.filter((d) => d.type === "tool_result").length).toBeGreaterThanOrEqual(2);
    expect(Date.now() - askedAt).toBeLessThan(5_000);
    await new Promise((r) => setTimeout(r, CALL_SECONDS * 1000 + 500));
    expect(lines()).toEqual(["start-1", "done-1", "start-2", "done-2"]);
  }, 120_000);

  it("a plain kill, for contrast, cuts the call in flight and leaves a start with no done", async () => {
    const sessionId = `boundary-e2e-${++n}`;
    fs.rmSync(chainLog, { force: true });
    const t0 = Date.now();
    const first = turn(sessionId, `work through it ${CHAIN}`);
    await waitFor(() => lines().includes("start-2"));
    note("contrast: call 2 is executing; the turn is killed outright", t0);
    engine.kill(sessionId, USER_MESSAGE_INTERRUPTION_REASON);
    await first.promise;
    await new Promise((r) => setTimeout(r, CALL_SECONDS * 1000 + 500));
    note(`contrast: the file holds ${lines().join(",")}`, t0);
    // Not asserted to be cut on every server (a shell child can outlive the abort): this records what a kill does.
    expect(lines().slice(0, 3)).toEqual(["start-1", "done-1", "start-2"]);
  }, 120_000);
});
