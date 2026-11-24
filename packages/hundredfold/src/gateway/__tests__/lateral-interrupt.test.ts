import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  createChild,
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
import * as completion from "../../sessions/turn/completion.js";
import { noticeTargetSessionId } from "../../sessions/turn-requester.js";
import type { BoundaryInterruptibleEngine, EngineRunOpts, InterruptibleEngine, ToolBoundaryOutcome } from "../../shared/types.js";

/**
 * A `send_to_session` that asks to interrupt cuts the target's running turn
 * short, between two tool calls, and the target reads it, with what was parked
 * ahead of it, as its next turn. These drive the real route, real SQLite and a
 * real SessionQueue; only the engine is a stub, whose turn blocks until the
 * route's abort ends it, as a real server's does.
 */

beforeEach(resetCallbackState);
afterEach(() => vi.restoreAllMocks());

interface Stub {
  engine: BoundaryInterruptibleEngine;
  prompts: string[];
  /** What each call to `interruptAtToolBoundary` was given. */
  aborts: Array<{ reason: string; waitMs: number }>;
  /** Ends the running turn as the target finishing it on its own. */
  finish: () => void;
  /**
   * For a `waiting` answer: the call in flight reaches its boundary now, while
   * the turn is still running. Asks the armed `beforeAbort` as a real engine
   * does, and returns its answer; the abort itself lands on `finish()`.
   */
  reachBoundary: () => boolean;
}

/** A target mid-turn; `outcome` is what its engine answers a request to stop at a boundary. */
function boundaryEngine(outcome: ToolBoundaryOutcome): Stub {
  const prompts: string[] = [];
  const aborts: Stub["aborts"] = [];
  let armed: (() => boolean) | undefined;
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
      if (outcome === "waiting") armed = opts.beforeAbort ?? (() => true);
      return outcome;
    },
  };
  const reachBoundary = () => {
    if (!armed) throw new Error("no abort is armed");
    const go = armed;
    armed = undefined;
    return go();
  };
  return { engine, prompts, aborts, finish: () => endTurn(), reachBoundary };
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
  // The caller is the target's parent: the session its running turn reports to.
  const caller = createParent(`interrupt-${suffix}-caller`);
  const target = createChild(caller.id, `interrupt-${suffix}-target`);
  // The parent asks for the long turn: an operator-started turn could not be cut (see "who may cut a turn").
  await post(context, target.id, { message: "start a long turn" }, toolHeaders(caller.id));
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
    // Each message was sent, so each keeps its bubble in the transcript (the parent's opening one too).
    expect(registry.getMessages(target.id).filter((m) => m.role === "notification")).toHaveLength(4);
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

describe("what is folded into the cut turn", () => {
  it("is the interrupting sender's own parked sends only: another session's message keeps its own turn", async () => {
    const { prompts, queue, context, target, caller } = await busyTarget("two-senders");
    const other = createParent("interrupt-two-senders-other");

    await post(context, target.id, { message: "A says: use plan alpha" }, toolHeaders(other.id));
    await post(context, target.id, { message: "B says: first" }, toolHeaders(caller.id));
    await post(context, target.id, { message: "B says: urgent", interrupt: true }, toolHeaders(caller.id));

    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(3);
    });
    expect(prompts[1]).toContain("A says: use plan alpha");
    expect(prompts[1]).not.toContain("B says");
    expect(prompts[2].indexOf("B says: first")).toBeLessThan(prompts[2].indexOf("B says: urgent"));
    expect(prompts[2]).not.toContain("A says");
  });

  it("cannot be taken back once folded: replacing the interrupting send then reads every folded send, and another sender's", async () => {
    // `waiting`, then the boundary arrives while the turn is still running: the fold happens, and before the
    // abort lands the interrupting sender tries to replace its send, which now carries its earlier one too.
    const { prompts, queue, events, context, finish, reachBoundary, target, caller } = await busyTarget("supersede", "waiting");
    const other = createParent("interrupt-supersede-other");

    await post(context, target.id, { message: "A says: use plan alpha" }, toolHeaders(other.id));
    await post(context, target.id, { message: "B says: first" }, toolHeaders(caller.id));
    const urgent = await post(context, target.id, { message: "B says: urgent", interrupt: true }, toolHeaders(caller.id));
    expect(urgent.body).toMatchObject({ interrupt: "waiting" });

    expect(reachBoundary()).toBe(true);
    expect(events).toContainEqual({ event: "session:interrupted", data: expect.objectContaining({ sessionId: target.id }) });
    const replaced = await post(context, target.id, { message: "B says: never mind", supersedes: (urgent.body as { queueItemId: string }).queueItemId }, toolHeaders(caller.id));
    expect(replaced.body).toMatchObject({ superseded: "too-late" });
    finish();

    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts.join("\n")).toContain("B says: never mind");
    });
    const read = prompts.join("\n");
    expect(read).toContain("A says: use plan alpha");
    expect(read).toContain("B says: first");
    expect(read).toContain("B says: urgent");
  });

  it("is not done, and the turn is not cut, when the interrupting send was withdrawn before the boundary", async () => {
    const { prompts, queue, events, context, reachBoundary, finish, target, caller } = await busyTarget("withdrawn", "waiting");

    const urgent = await post(context, target.id, { message: "B says: urgent", interrupt: true }, toolHeaders(caller.id));
    expect(urgent.body).toMatchObject({ interrupt: "waiting" });
    const replaced = await post(context, target.id, { message: "B says: never mind", supersedes: (urgent.body as { queueItemId: string }).queueItemId }, toolHeaders(caller.id));
    expect(replaced.body).toMatchObject({ superseded: "withdrawn" });

    expect(reachBoundary()).toBe(false);
    expect(events.filter((e) => e.event === "session:interrupted")).toHaveLength(0);
    expect(prompts).toHaveLength(1);
    expect(queue.isRunning(target.sessionKey)).toBe(true);
    // The turn runs to its own end and the replacement is read after it, in a turn of its own.
    finish();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(2);
    });
    expect(prompts[1]).toContain("B says: never mind");
    expect(prompts[1]).not.toContain("B says: urgent");
  });

  it("is nothing when the engine cannot cut the turn: one turn per message, as before", async () => {
    const stub = boundaryEngine("unsupported");
    const queue = new queueModule.SessionQueue();
    const context = makeContext(stub.engine, queue, []);
    const caller = createParent("interrupt-no-fold-caller");
    const target = createChild(caller.id, "interrupt-no-fold-target");
    await post(context, target.id, { message: "start a long turn" }, toolHeaders(caller.id));
    await eventually(() => expect(stub.prompts).toHaveLength(1));

    await post(context, target.id, { message: "first" }, toolHeaders(caller.id));
    await post(context, target.id, { message: "second", interrupt: true }, toolHeaders(caller.id));
    stub.finish();

    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(stub.prompts).toHaveLength(3);
    });
    expect(stub.prompts[1]).toContain("first");
    expect(stub.prompts[1]).not.toContain("second");
  });
});

describe("a send that asks to interrupt and repeats a queued message", () => {
  it("acts on the message already queued and reports the interrupt", async () => {
    const { prompts, aborts, queue, context, target, caller } = await busyTarget("duplicate");

    await post(context, target.id, { message: "same words" }, toolHeaders(caller.id));
    const again = await post(context, target.id, { message: "same words", interrupt: true }, toolHeaders(caller.id));

    expect(again.body).toMatchObject({ status: "duplicate", interrupt: "interrupted" });
    expect(aborts).toHaveLength(1);
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(2);
    });
    expect(prompts[1]).toContain("same words");
  });

  it("says why when it could not, rather than staying silent", async () => {
    const { aborts, context, target, caller } = await busyTarget("duplicate-held");
    await post(context, target.id, { message: "same words" }, toolHeaders(caller.id));
    const queueModulePause = (context as unknown as { sessionManager: { getQueue: () => { pauseQueue: (k: string) => void } } }).sessionManager.getQueue();
    queueModulePause.pauseQueue(target.sessionKey);

    const again = await post(context, target.id, { message: "same words", interrupt: true }, toolHeaders(caller.id));

    expect(again.body).toMatchObject({ status: "duplicate", interrupt: "held" });
    expect(aborts).toHaveLength(0);
  });
});

describe("who may cut a turn", () => {
  it("is refused for a sibling: the turn stays the parent's, and the parent still gets its notice", async () => {
    const settled: Array<{ outcome: string; notifies: boolean; noticeTo: string | null }> = [];
    const settle = completion.settleTurn;
    vi.spyOn(completion, "settleTurn").mockImplementation(async (input) => {
      settled.push({ outcome: input.outcome, notifies: input.notifyParent !== false, noticeTo: noticeTargetSessionId(registry.getSession(input.sessionId)!) });
      return await settle(input);
    });
    const { prompts, aborts, queue, events, context, finish, target, caller } = await busyTarget("sibling");
    const sibling = createChild(caller.id, "interrupt-sibling-other");

    const urgent = await post(context, target.id, { message: "sibling says: stop", interrupt: true }, toolHeaders(sibling.id));

    expect(urgent.body).toMatchObject({ status: "queued", targetRunning: true, interrupt: "refused" });
    expect(aborts).toHaveLength(0);
    expect(events.filter((e) => e.event === "session:interrupted")).toHaveLength(0);
    expect(prompts).toHaveLength(1);
    finish();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(2);
    });
    // The parent's turn ran to its end, and its notice went to the parent.
    expect(settled[0]).toEqual({ outcome: "succeeded", notifies: true, noticeTo: caller.id });
  });

  it("is refused for a child cutting its parent's turn", async () => {
    const { aborts, context, target } = await busyTarget("upward");
    const grandchild = createChild(target.id, "interrupt-upward-child");

    const urgent = await post(context, target.id, { message: "child says: stop", interrupt: true }, toolHeaders(grandchild.id));

    expect(urgent.body).toMatchObject({ interrupt: "refused" });
    expect(aborts).toHaveLength(0);
  });

  it("is refused for any session when the turn reports to nobody", async () => {
    const stub = boundaryEngine("interrupted");
    const context = makeContext(stub.engine, new queueModule.SessionQueue(), []);
    const target = createParent("interrupt-top-target");
    const peer = createParent("interrupt-top-peer");
    await post(context, target.id, { message: "start a long turn" });
    await eventually(() => expect(stub.prompts).toHaveLength(1));

    const urgent = await post(context, target.id, { message: "peer says: stop", interrupt: true }, toolHeaders(peer.id));

    expect(urgent.body).toMatchObject({ interrupt: "refused" });
    expect(stub.aborts).toHaveLength(0);
    stub.finish();
  });

  it("is refused for the parent when the operator started the turn in the child's chat", async () => {
    const stub = boundaryEngine("interrupted");
    const events: Array<{ event: string; data: unknown }> = [];
    const context = makeContext(stub.engine, new queueModule.SessionQueue(), events);
    const caller = createParent("interrupt-operator-turn-caller");
    const target = createChild(caller.id, "interrupt-operator-turn-target");
    await post(context, target.id, { message: "operator asks something" });
    await eventually(() => expect(stub.prompts).toHaveLength(1));

    const urgent = await post(context, target.id, { message: "parent says: stop", interrupt: true }, toolHeaders(caller.id));

    expect(urgent.body).toMatchObject({ interrupt: "refused" });
    expect(stub.aborts).toHaveLength(0);
    expect(events.filter((e) => e.event === "session:interrupted")).toHaveLength(0);
    stub.finish();
  });

  it("says `reading`, and cuts nothing, for a repeat of the message the running turn is reading", async () => {
    const stub = boundaryEngine("interrupted");
    const context = makeContext(stub.engine, new queueModule.SessionQueue(), []);
    const caller = createParent("interrupt-reading-caller");
    const target = createChild(caller.id, "interrupt-reading-target");
    await post(context, target.id, { message: "same words" }, toolHeaders(caller.id));
    await eventually(() => expect(stub.prompts).toHaveLength(1));

    const again = await post(context, target.id, { message: "same words", interrupt: true }, toolHeaders(caller.id));

    expect(again.body).toMatchObject({ status: "duplicate", interrupt: "reading" });
    expect(stub.aborts).toHaveLength(0);
    stub.finish();
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
