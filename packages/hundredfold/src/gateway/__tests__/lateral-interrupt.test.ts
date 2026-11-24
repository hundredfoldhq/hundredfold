import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  createParent,
  dbModule,
  eventually,
  makeContext,
  queueModule,
  registry,
  resetCallbackState,
  type ApiContext,
} from "./helpers/callback-harness.js";
import { makeResponse } from "./helpers/callback-requests.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import { USER_MESSAGE_INTERRUPTION_REASON } from "../../sessions/interruption-reasons.js";
import type { BoundaryInterruptibleEngine, EngineRunOpts, InterruptibleEngine, ToolBoundaryOutcome } from "../../shared/types.js";

/**
 * A `send_to_session` that asks to interrupt cuts the target's running turn
 * short, between two tool calls, and the target reads it, with what was parked
 * ahead of it, as its next turn. These drive the real route, real SQLite and a
 * real SessionQueue; only the engine is a stub, whose turn blocks until the
 * route's abort ends it, as a real server's does.
 */

beforeEach(resetCallbackState);

interface Stub {
  engine: BoundaryInterruptibleEngine;
  prompts: string[];
  /** What each call to `interruptAtToolBoundary` was given. */
  aborts: Array<{ reason: string; waitMs: number }>;
  /** Ends the running turn as the target finishing it on its own. */
  finish: () => void;
}

/** A target mid-turn; `outcome` is what its engine answers a request to stop at a boundary. */
function boundaryEngine(outcome: ToolBoundaryOutcome): Stub {
  const prompts: string[] = [];
  const aborts: Stub["aborts"] = [];
  let endTurn!: () => void;
  const running = new Promise<void>((resolve) => { endTurn = resolve; });
  const engine: BoundaryInterruptibleEngine = {
    name: "stub",
    run: async (opts: EngineRunOpts) => {
      prompts.push(opts.prompt);
      if (prompts.length === 1) await running;
      return { sessionId: "stub", result: "acknowledged" };
    },
    isAlive: () => prompts.length === 1,
    kill: () => endTurn(),
    killAll: () => undefined,
    killIdle: () => undefined,
    interruptAtToolBoundary: async (_id, reason, opts) => {
      aborts.push({ reason, waitMs: opts.waitMs });
      if (outcome === "interrupted") {
        if (opts.beforeAbort && !opts.beforeAbort()) return "over";
        endTurn();
      }
      return outcome;
    },
  };
  return { engine, prompts, aborts, finish: () => endTurn() };
}

async function post(context: ApiContext, sessionId: string, body: unknown, headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: `/api/sessions/${sessionId}/message`,
    headers: { host: "gateway.test", authorization: "Bearer test-token", "content-type": "application/json", ...headers },
  });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  return captured;
}

function toolHeaders(callerSessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: callerSessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(callerSessionId),
  };
}

function queueRows(sessionId: string): Array<{ id: string; status: string }> {
  return dbModule.initDb()
    .prepare("SELECT id, status FROM queue_items WHERE session_id = ? ORDER BY position ASC, created_at ASC, rowid ASC")
    .all(sessionId) as Array<{ id: string; status: string }>;
}

async function busyTarget(suffix: string, outcome: ToolBoundaryOutcome = "interrupted") {
  const stub = boundaryEngine(outcome);
  const events: Array<{ event: string; data: unknown }> = [];
  const queue = new queueModule.SessionQueue();
  const context = makeContext(stub.engine, queue, events);
  const target = createParent(`interrupt-${suffix}-target`);
  const caller = createParent(`interrupt-${suffix}-caller`);
  await post(context, target.id, { message: "start a long turn" });
  await eventually(() => expect(stub.prompts).toHaveLength(1));
  return { ...stub, queue, context, events, target, caller };
}

describe("a send that asks to interrupt", () => {
  it("cuts the turn at a boundary and tells the sender; the target reads what was parked, then the message, as one turn", async () => {
    const { prompts, aborts, queue, context, events, target, caller } = await busyTarget("one-turn");

    await post(context, target.id, { message: "first correction" }, toolHeaders(caller.id));
    await post(context, target.id, { message: "second correction" }, toolHeaders(caller.id));
    const urgent = await post(context, target.id, { message: "stop, do X instead", interrupt: true }, toolHeaders(caller.id));

    expect(urgent.status).toBe(200);
    expect(urgent.body).toMatchObject({ status: "queued", targetRunning: true, interrupt: "interrupted", queuedFromYou: 1 });
    expect(aborts).toHaveLength(1);
    expect(aborts[0].reason).toBe(USER_MESSAGE_INTERRUPTION_REASON);
    expect(aborts[0].waitMs).toBeLessThanOrEqual(5_000);
    expect(events).toContainEqual({ event: "session:interrupted", data: expect.objectContaining({ sessionId: target.id }) });

    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(2);
    });
    // One turn, in send order; nothing is read twice.
    const resumed = prompts[1];
    expect(resumed.indexOf("first correction")).toBeGreaterThan(-1);
    expect(resumed.indexOf("first correction")).toBeLessThan(resumed.indexOf("second correction"));
    expect(resumed.indexOf("second correction")).toBeLessThan(resumed.indexOf("stop, do X instead"));
    const statuses = queueRows(target.id).map((row) => row.status);
    expect(statuses.filter((status) => status === "cancelled")).toHaveLength(2);
    expect(statuses.filter((status) => status === "completed")).toHaveLength(2);
    // Each message was sent, so each keeps its bubble in the transcript.
    expect(registry.getMessages(target.id).filter((m) => m.role === "notification")).toHaveLength(3);
  });

  it("leaves the turn alone, and the message queued, when the target's queue is paused", async () => {
    const { prompts, aborts, queue, context, target, caller } = await busyTarget("paused");
    queue.pauseQueue(target.sessionKey);

    const urgent = await post(context, target.id, { message: "stop, do X instead", interrupt: true }, toolHeaders(caller.id));

    expect(urgent.body).toMatchObject({ status: "queued", targetRunning: true, interrupt: "held" });
    expect(aborts).toHaveLength(0);
    expect(prompts).toHaveLength(1);
  });

  it("says `waiting` when a call in flight outlasts the wait, and the message stays queued behind the turn", async () => {
    const { prompts, aborts, queue, context, finish, target, caller } = await busyTarget("waiting", "waiting");

    const urgent = await post(context, target.id, { message: "stop, do X instead", interrupt: true }, toolHeaders(caller.id));

    expect(urgent.body).toMatchObject({ status: "queued", interrupt: "waiting" });
    expect(aborts).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    finish();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(2);
    });
    expect(prompts[1]).toContain("stop, do X instead");
  });

  it("is refused for a value that is not true or false", async () => {
    const { aborts, context, target, caller } = await busyTarget("bad-value");

    const refused = await post(context, target.id, { message: "stop", interrupt: "now" }, toolHeaders(caller.id));

    expect(refused.status).toBe(400);
    expect(aborts).toHaveLength(0);
  });
});

describe("a send that does not ask to interrupt", () => {
  it("queues behind the running turn exactly as before, whatever the engine could do", async () => {
    const { prompts, aborts, queue, context, finish, target, caller } = await busyTarget("plain");

    const plain = await post(context, target.id, { message: "when you get a moment" }, toolHeaders(caller.id));
    const falsy = await post(context, target.id, { message: "or this", interrupt: false }, toolHeaders(caller.id));

    expect(plain.body).toMatchObject({ status: "queued", targetRunning: true, queuedFromYou: 1 });
    expect(plain.body).not.toHaveProperty("interrupt");
    expect(falsy.body).not.toHaveProperty("interrupt");
    expect(aborts).toHaveLength(0);
    expect(prompts).toHaveLength(1);
    finish();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(3);
    });
    // One turn each, in order: nothing was folded.
    expect(prompts[1]).toContain("when you get a moment");
    expect(prompts[2]).toContain("or this");
  });

  it("is not made to interrupt by a notice that names `interrupt` in its body without a session behind it", async () => {
    const { aborts, context, target } = await busyTarget("notice");

    await post(context, target.id, { message: "child finished", role: "notification", interrupt: true });

    expect(aborts).toHaveLength(0);
  });
});

describe("an engine that cannot stop at a boundary", () => {
  it("leaves the message queued and says so", async () => {
    const prompts: string[] = [];
    let endTurn!: () => void;
    const running = new Promise<void>((resolve) => { endTurn = resolve; });
    const plain: InterruptibleEngine = {
      name: "stub",
      run: async (opts: EngineRunOpts) => {
        prompts.push(opts.prompt);
        if (prompts.length === 1) await running;
        return { sessionId: "stub", result: "acknowledged" };
      },
      isAlive: () => prompts.length === 1,
      kill: () => endTurn(),
      killAll: () => undefined,
      killIdle: () => undefined,
    };
    const context = makeContext(plain, new queueModule.SessionQueue(), []);
    const target = createParent("interrupt-plain-engine-target");
    const caller = createParent("interrupt-plain-engine-caller");
    await post(context, target.id, { message: "start a long turn" });
    await eventually(() => expect(prompts).toHaveLength(1));

    const urgent = await post(context, target.id, { message: "stop, do X instead", interrupt: true }, toolHeaders(caller.id));

    expect(urgent.body).toMatchObject({ status: "queued", targetRunning: true, interrupt: "unsupported" });
    expect(prompts).toHaveLength(1);
    endTurn();
  });
});
