import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Stopping an opencode server turn between two tool calls: the engine against
 * fake 1.x and 2.x servers (fixtures/fake-opencode*.mjs), real processes and real
 * HTTP, with a long turn (`TOOLCHAIN`: six calls in a row, each executing 600 ms).
 * The fakes record a call an abort lands in the middle of as `TOOL-CUT-MID-RUN`,
 * which is what a real server leaves half-written.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool, basicAuthHeader } from "../opencode-server.js";
import { ToolBoundary, interruptAtToolBoundary } from "../opencode-tool-boundary.js";
import { SERVER_TURN_TIMING } from "../opencode-server-turn.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HUNDREDFOLD_HOME } from "../../shared/paths.js";
import { clearOpencodeVersionCache } from "../../shared/opencode-bin-version.js";
import { USER_MESSAGE_INTERRUPTION_REASON } from "../../sessions/interruption-reasons.js";
import type { EngineRunOpts, StreamDelta } from "../../shared/types.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const TIMING_DEFAULTS = { ...SERVER_TURN_TIMING };
const MODEL = "opencode-go/deepseek-v4.1-flash";
const WAIT_MS = 3_000;

describe("ToolBoundary", () => {
  it("is idle with no call executing, and tells a waiter at once", () => {
    const boundary = new ToolBoundary();
    const told: boolean[] = [];
    boundary.whenIdle((open) => told.push(open));
    expect(told).toEqual([true]);
  });

  it("holds a waiter until the last of several calls ends", () => {
    const boundary = new ToolBoundary();
    const told: boolean[] = [];
    boundary.start("a");
    boundary.start("b");
    boundary.whenIdle((open) => told.push(open));
    boundary.end("a");
    expect(told).toEqual([]);
    boundary.end("b");
    expect(told).toEqual([true]);
  });

  it("tells a waiter its turn ended first, and never again for a call that follows", () => {
    const boundary = new ToolBoundary();
    const told: boolean[] = [];
    boundary.start("a");
    boundary.whenIdle((open) => told.push(open));
    boundary.close();
    boundary.start("b");
    boundary.end("b");
    expect(told).toEqual([false]);
  });

  it("lets a step's end clear a call that never reported a result", () => {
    const boundary = new ToolBoundary();
    const told: boolean[] = [];
    boundary.start("aborted");
    boundary.whenIdle((open) => told.push(open));
    boundary.clear();
    expect(told).toEqual([true]);
  });
});

describe("interruptAtToolBoundary", () => {
  function turn() {
    const interrupts: string[] = [];
    return { toolBoundary: new ToolBoundary(), interrupts, interrupt: async (reason: string) => { interrupts.push(reason); } };
  }

  it("calls the call off when beforeAbort says the message is no longer waiting", async () => {
    const t = turn();
    expect(await interruptAtToolBoundary(t, "why", { waitMs: 50, beforeAbort: () => false })).toBe("over");
    expect(t.interrupts).toEqual([]);
  });

  it("stays armed past the wait, and fires at the boundary", async () => {
    const t = turn();
    t.toolBoundary.start("write");
    expect(await interruptAtToolBoundary(t, "why", { waitMs: 20 })).toBe("waiting");
    expect(t.interrupts).toEqual([]);
    t.toolBoundary.end("write");
    expect(t.interrupts).toEqual(["why"]);
  });

  it("does not fire for a turn that ended while it waited", async () => {
    const t = turn();
    t.toolBoundary.start("write");
    expect(await interruptAtToolBoundary(t, "why", { waitMs: 20 })).toBe("waiting");
    t.toolBoundary.close();
    expect(t.interrupts).toEqual([]);
  });
});

interface Flavour {
  name: string;
  bin: string;
  /** The fake's request log is keyed `path` on 2.x and `url` on 1.x. */
  cut: (entry: Record<string, string>) => boolean;
  aborts: (entry: Record<string, string>) => boolean;
}

const FLAVOURS: Flavour[] = [
  {
    name: "OpenCode 1.x",
    bin: path.join(FIXTURES, "fake-opencode.mjs"),
    cut: (e) => e.url === "TOOL-CUT-MID-RUN",
    aborts: (e) => e.method === "POST" && /\/abort$/.test(e.url ?? ""),
  },
  {
    name: "OpenCode 2.x",
    bin: path.join(FIXTURES, "fake-opencode-v2.mjs"),
    cut: (e) => e.path === "TOOL-CUT-MID-RUN",
    aborts: (e) => e.method === "POST" && /\/interrupt$/.test(e.path ?? ""),
  },
];

interface Harness {
  pool: OpencodeServerPool;
  engine: OpencodeEngine;
}

let harnesses: Harness[] = [];

function harness(bin: string): Harness {
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
  const pool = new OpencodeServerPool(lifecycle, { limits: () => ({}), bin: () => bin });
  const h = { pool, engine: new OpencodeEngine({ mode: () => "server", servers: pool }) };
  harnesses.push(h);
  return h;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = await check(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function requestLog(h: Harness): Promise<Array<Record<string, string>>> {
  const server = h.pool.get("sess-1")!;
  const res = await fetch(`${server.apiUrl}/test/log`, { headers: { authorization: basicAuthHeader(server.password) } });
  return (await res.json()) as Array<Record<string, string>>;
}

beforeEach(() => {
  for (const name of ["FAKE_OPENCODE_VERSION", "FAKE_V2_VERSION", "FAKE_V2_LOG", "FAKE_OPENCODE_SERVE_LOG"]) delete process.env[name];
  clearOpencodeVersionCache();
  Object.assign(SERVER_TURN_TIMING, TIMING_DEFAULTS, { statusPollMs: 30_000, closeWaitMs: 1_000 });
});

afterEach(async () => {
  for (const h of harnesses) {
    h.engine.killAll();
    void h.pool.stopAll();
  }
  for (const h of harnesses) await waitFor(() => h.pool.size() === 0).catch(() => {});
  harnesses = [];
});

describe.each(FLAVOURS)("a long turn on $name", { timeout: 30_000 }, (flavour) => {
  const opts = (over: Partial<EngineRunOpts> = {}): EngineRunOpts =>
    ({ prompt: "work through it TOOLCHAIN", cwd: HUNDREDFOLD_HOME, sessionId: "sess-1", bin: flavour.bin, model: MODEL, ...over });

  /** A turn whose second call is executing: the first has reported its result, and the model's turnaround (200 ms) is past. */
  async function midChain(h: Harness) {
    const deltas: StreamDelta[] = [];
    const turn = h.engine.run(opts({ onStream: (d) => deltas.push(d) }));
    await waitFor(() => deltas.some((d) => d.type === "tool_result"));
    await new Promise((r) => setTimeout(r, 350));
    return { turn, deltas };
  }

  it("is stopped between two calls, never inside one, and the session carries on with the message", async () => {
    const h = harness(flavour.bin);
    const { turn, deltas } = await midChain(h);
    const askedAt = Date.now();
    expect(await h.engine.interruptAtToolBoundary("sess-1", USER_MESSAGE_INTERRUPTION_REASON, { waitMs: WAIT_MS })).toBe("interrupted");
    const first = await turn;
    expect(first.error).toBe(USER_MESSAGE_INTERRUPTION_REASON);

    const log = await requestLog(h);
    expect(log.some(flavour.aborts)).toBe(true);
    expect(log.some(flavour.cut)).toBe(false);
    // What the first calls produced is in the transcript; the abort waited for the call in flight to report.
    expect(deltas.filter((d) => d.type === "tool_result").length).toBeGreaterThanOrEqual(2);
    // The abort waits for the call in flight, then for the server to settle (1.5 s of quiet).
    expect(Date.now() - askedAt).toBeLessThan(3_000);

    // The same session goes on, with the message as its next turn, well inside the budget.
    const second = await h.engine.run(opts({ prompt: "the input you need is now in place", resumeSessionId: first.sessionId }));
    expect(second.error).toBeUndefined();
    expect(second.sessionId).toBe(first.sessionId);
    expect(Date.now() - askedAt).toBeLessThan(5_000);
  });

  it("is cut mid-call by a plain kill: the fake would have recorded it (the check above is not vacuous)", async () => {
    const h = harness(flavour.bin);
    const { turn } = await midChain(h);
    h.engine.kill("sess-1", USER_MESSAGE_INTERRUPTION_REASON);
    await turn;
    expect((await requestLog(h)).some(flavour.cut)).toBe(true);
  });

  it("answers `waiting` when the call outlasts the wait, and still stops at its end", async () => {
    const h = harness(flavour.bin);
    const { turn } = await midChain(h);
    expect(await h.engine.interruptAtToolBoundary("sess-1", USER_MESSAGE_INTERRUPTION_REASON, { waitMs: 10 })).toBe("waiting");
    const result = await turn;
    expect(result.error).toBe(USER_MESSAGE_INTERRUPTION_REASON);
    expect((await requestLog(h)).some(flavour.cut)).toBe(false);
  });

  it("is left running when the message is withdrawn before the boundary", async () => {
    const h = harness(flavour.bin);
    const { turn } = await midChain(h);
    expect(await h.engine.interruptAtToolBoundary("sess-1", USER_MESSAGE_INTERRUPTION_REASON, { waitMs: WAIT_MS, beforeAbort: () => false })).toBe("over");
    const result = await turn;
    expect(result.error).toBeUndefined();
    expect((await requestLog(h)).some(flavour.aborts)).toBe(false);
  });
});

describe("a turn with no call executing", () => {
  it.each(FLAVOURS)("is stopped at once on $name", async (flavour) => {
    const h = harness(flavour.bin);
    const turn = h.engine.run({ prompt: "think it over SLOW", cwd: HUNDREDFOLD_HOME, sessionId: "sess-1", bin: flavour.bin, model: MODEL });
    await waitFor(() => h.engine.isAlive("sess-1"));
    await new Promise((r) => setTimeout(r, 250));
    expect(await h.engine.interruptAtToolBoundary("sess-1", USER_MESSAGE_INTERRUPTION_REASON, { waitMs: WAIT_MS })).toBe("interrupted");
    expect((await turn).error).toBe(USER_MESSAGE_INTERRUPTION_REASON);
  });

  it("is `unsupported` for a session with no server turn (a plain run, or nothing running)", async () => {
    const engine = new OpencodeEngine({ mode: () => "run" });
    expect(await engine.interruptAtToolBoundary("nobody", USER_MESSAGE_INTERRUPTION_REASON, { waitMs: 10 })).toBe("unsupported");
  });
});
