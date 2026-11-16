import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  api,
  callbacks,
  completeChildAttempt,
  createChild,
  dbModule,
  eventually,
  makeContext,
  queueModule,
  registry,
  workItems,
  type ApiContext,
} from "./helpers/callback-harness.js";
import { makeResponse, withRouteBackedFetch } from "./helpers/callback-requests.js";
import { sessionHeaders } from "./todo-mentions-harness.js";
import { installTodoCommentRouting } from "../todo-comment-routing.js";
import { addComment } from "../../work-items/comments.js";
import { setSteerSettleTimeoutForTest } from "../../sessions/steered-deliveries.js";
import { resumePendingWebQueueItems } from "../callback-queue-recovery.js";
import type { Engine, EngineRunOpts, SteerOutcome } from "../../shared/types.js";

/**
 * An operator's `@employee` mention on a Todo, arriving while the tagged session
 * is mid-turn, against the real routes, outbox, queue and SQLite. Only the
 * engine is fake: its turn stays open until the test lets it end.
 *
 * An engine that can take a new input into the turn running (steer) is handed
 * the mention; for any other the turn runs on, uncut, and the mention moves to
 * the head of its lane, so it is the next thing the session reads, before
 * anything queued earlier. Nothing here ever kills a turn: on claude that ends
 * the whole process, tools, background shells and subagents with it. Nobody
 * else's message, and no relay or callback, ever reaches a running turn.
 */

for (const name of ["alpha", "bravo"]) {
  fs.mkdirSync(path.join(process.env.HUNDREDFOLD_HOME!, "org"), { recursive: true });
  fs.writeFileSync(path.join(process.env.HUNDREDFOLD_HOME!, "org", `${name}.yaml`), [
    `name: ${name}`, `displayName: ${name}`, "department: platform", "rank: employee", "engine: stub", `persona: ${name} for busy-session tests`, "",
  ].join("\n"));
}

beforeAll(() => {
  dbModule.initDb();
});
/** Comments, links and claims reference Todos and sessions, which the shared reset does not clear. */
afterEach(() => setSteerSettleTimeoutForTest());
beforeEach(() => {
  callbacks.__resetCallbackRetrySweepForTest();
  const db = dbModule.initDb();
  const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]);
  db.pragma("foreign_keys = OFF");
  for (const table of ["work_item_comment_meta", "work_item_comments", "work_item_employee_sessions", "work_item_runs", "work_item_events", "work_item_relations",
    "callback_deliveries", "queue_items", "messages", "sessions", "work_items"]) {
    if (existing.has(table)) db.exec(`DELETE FROM ${table}`);
  }
  db.pragma("foreign_keys = ON");
});

const GATEWAY = { host: "gateway.test", authorization: "Bearer test-token", "content-type": "application/json" };

async function call(context: ApiContext, method: string, url: string, body?: unknown, headers: Record<string, string> = GATEWAY) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { host: "gateway.test", "content-type": "application/json", ...headers } });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  return captured;
}

interface FakeEngineOptions {
  /** Takes inputs into a running turn; what became of each is up to the test. */
  steerable?: boolean;
}

/** An engine whose turns end only when released or killed, and that may take a steered input. */
function fakeEngine(options: FakeEngineOptions = {}) {
  const prompts: string[] = [];
  const kills: Array<string | undefined> = [];
  const steers: string[] = [];
  const steerOutcomes: Array<(outcome: SteerOutcome) => void> = [];
  const releases: Array<() => void> = [];
  let alive = 0;
  const engine = {
    name: "stub",
    run: async (opts: EngineRunOpts) => {
      prompts.push(opts.prompt);
      alive++;
      await new Promise<void>((resolve) => { releases.push(resolve); });
      alive--;
      return { sessionId: "stub", result: "acknowledged" };
    },
    kill: (_sessionId: string, reason?: string) => { kills.push(reason); releases.shift()?.(); },
    isAlive: () => alive > 0,
    killAll: () => {},
    ...(options.steerable ? {
      canSteer: () => alive > 0,
      steer: (_sessionId: string, prompt: string) => {
        steers.push(prompt);
        return new Promise<SteerOutcome>((resolve) => { steerOutcomes.push(resolve); });
      },
    } : {}),
  } as unknown as Engine;
  return { engine, prompts, kills, steers, settleSteer: (outcome: SteerOutcome) => steerOutcomes.shift()?.(outcome), releaseNext: () => releases.shift()?.() };
}

/** A Todo whose employee has a session mid-turn: the turn is running and the lane is busy. */
async function busyTodo(options: FakeEngineOptions & { config?: Record<string, unknown> } = {}) {
  const fake = fakeEngine(options);
  const queue = new queueModule.SessionQueue();
  const events: Array<{ event: string; data: unknown }> = [];
  const context = makeContext(fake.engine, queue, events);
  Object.assign((context as unknown as { config: Record<string, unknown> }).config, { sessions: options.config ?? {} });
  const item = workItems.createWorkItem({ title: "busy design review", assignee: "alpha", status: "executing" });
  const session = registry.createSession({ engine: "stub", source: "web", sourceRef: `web:busy:${item.id}`, sessionKey: `web:busy:${item.id}`, connector: "web", employee: "alpha", prompt: "work the Todo" });
  workItems.linkSession(item.id, session.id);
  installTodoCommentRouting(context);
  await call(context, "POST", `/api/sessions/${session.id}/message`, { message: "long running turn" });
  await eventually(() => expect(fake.prompts).toEqual(["long running turn"]));
  const operatorComment = (body: string, extra: Record<string, unknown> = {}) =>
    call(context, "POST", `/api/work-items/${item.id}/comments`, { body, ...extra });
  const commentAs = (sessionId: string, body: string, extra: Record<string, unknown> = {}) =>
    call(context, "POST", `/api/work-items/${item.id}/comments`, { body, ...extra }, { host: "gateway.test", ...sessionHeaders(sessionId) });
  /** The pending rows' prompts in lane order, which is what runs next. */
  const laneOrder = () => (dbModule.initDb().prepare("SELECT prompt FROM queue_items WHERE session_key = ? AND status = 'pending' ORDER BY position ASC, created_at ASC, rowid ASC").pluck().all(session.sessionKey) as string[]);
  const pendingPrompts = () => registry.listPendingQueueItemIdsForSession(session.id).map((id) => registry.getQueueItem(id)!.prompt);
  const settled = () => eventually(() => {
    expect(queue.isRunning(session.sessionKey)).toBe(false);
    expect(queue.getPendingCount(session.sessionKey)).toBe(0);
  });
  return { ...fake, context, queue, events, item, session, operatorComment, commentAs, pendingPrompts, laneOrder, settled };
}

/** Let any hand-over or interruption a mistaken policy would make happen. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 60));

const mentionRowId = () => dbModule.initDb().prepare("SELECT queue_item_id FROM callback_deliveries WHERE delivery_kind = 'todo-mention'").pluck().get() as string;

describe("an operator's mention into a busy session", () => {
  it("(a) never kills a turn that cannot be steered, and runs the mention right after it, before a child callback queued earlier", async () => {
    const busy = await busyTodo();
    await withRouteBackedFetch(busy.context, {}, async () => {
      const child = createChild(busy.session.id, "busy-callback-child");
      callbacks.notifyParentSession(completeChildAttempt(child.id), { result: "child finished its part" });
      await eventually(() => expect(busy.pendingPrompts().some((prompt) => prompt.includes("child finished its part"))).toBe(true));

      expect((await busy.operatorComment("@alpha please look at the failing check")).status).toBe(201);

      await eventually(() => expect(busy.pendingPrompts()).toHaveLength(2));
      await quiet();
      // Nothing was cut off or interrupted: the turn is still the one it was.
      expect(busy.kills).toEqual([]);
      expect(busy.steers).toEqual([]);
      expect(busy.events.filter((event) => event.event === "session:interrupted")).toEqual([]);
      expect(busy.prompts).toEqual(["long running turn"]);
      // The mention heads the lane, ahead of the earlier callback.
      expect(busy.laneOrder()[0]).toContain("please look at the failing check");
      expect(busy.laneOrder()[1]).toContain("child finished its part");

      busy.releaseNext();
      await eventually(() => expect(busy.prompts).toHaveLength(2));
      expect(busy.prompts[1]).toContain("please look at the failing check");
      busy.releaseNext();
      await eventually(() => expect(busy.prompts).toHaveLength(3));
      expect(busy.prompts[2]).toContain("child finished its part");
      busy.releaseNext();
      await busy.settled();
      expect(busy.kills).toEqual([]);
      expect(registry.getMessages(busy.session.id).filter((message) => message.role === "assistant")).toHaveLength(3);
    });
  });

  it("(a) two operator mentions in a row kill nothing, and run in the order they were sent, ahead of an earlier child callback", async () => {
    const busy = await busyTodo();
    await withRouteBackedFetch(busy.context, {}, async () => {
      callbacks.notifyParentSession(completeChildAttempt(createChild(busy.session.id, "busy-two-mentions-child").id), { result: "child finished its part" });
      await eventually(() => expect(busy.pendingPrompts().some((prompt) => prompt.includes("child finished its part"))).toBe(true));
      await busy.operatorComment("@alpha first request");
      await eventually(() => expect(busy.pendingPrompts()).toHaveLength(2));
      await busy.operatorComment("@alpha second request");
      await eventually(() => expect(busy.pendingPrompts()).toHaveLength(3));
      await quiet();
      expect(busy.kills).toEqual([]);
      expect(busy.prompts).toEqual(["long running turn"]);
      const lane = busy.laneOrder();
      expect(lane[0]).toContain("first request");
      expect(lane[1]).toContain("second request");
      expect(lane[2]).toContain("child finished its part");

      busy.releaseNext();
      await eventually(() => expect(busy.prompts).toHaveLength(2));
      busy.releaseNext();
      await eventually(() => expect(busy.prompts).toHaveLength(3));
      busy.releaseNext();
      await eventually(() => expect(busy.prompts).toHaveLength(4));
      expect(busy.prompts[1]).toContain("first request");
      expect(busy.prompts[2]).toContain("second request");
      expect(busy.prompts[3]).toContain("child finished its part");
      busy.releaseNext();
      await busy.settled();
      expect(busy.kills).toEqual([]);
      expect(busy.events.filter((event) => event.event === "session:interrupted")).toEqual([]);
    });
  });

  for (const interruptOnNewMessage of [true, false]) {
    it(`(a) interruptOnNewMessage ${interruptOnNewMessage} makes no difference to a mention: promoted, nothing killed`, async () => {
      const busy = await busyTodo({ config: { interruptOnNewMessage } });
      await withRouteBackedFetch(busy.context, {}, async () => {
        await busy.operatorComment("@alpha please look at the failing check");
        await eventually(() => expect(busy.pendingPrompts()).toHaveLength(1));
        await quiet();
        expect(busy.kills).toEqual([]);
        expect(busy.events.filter((event) => event.event === "session:interrupted")).toEqual([]);
        expect(busy.prompts).toEqual(["long running turn"]);
        busy.releaseNext();
        await eventually(() => expect(busy.prompts).toHaveLength(2));
        expect(busy.prompts[1]).toContain("please look at the failing check");
        busy.releaseNext();
        await busy.settled();
      });
    });
  }

  it("(a) a mention while a /compact turn runs never steers into it, and kills nothing", async () => {
    const busy = await busyTodo({ steerable: true });
    // The stub engine has no compaction path, so the running turn's row is relabelled as the compact command it stands for.
    dbModule.initDb().prepare("UPDATE queue_items SET prompt = '/compact' WHERE session_id = ? AND status = 'running'").run(busy.session.id);
    await withRouteBackedFetch(busy.context, {}, async () => {
      await busy.operatorComment("@alpha please look at the failing check");
      await eventually(() => expect(busy.pendingPrompts()).toHaveLength(1));
      await quiet();
      expect(busy.steers).toEqual([]);
      expect(busy.kills).toEqual([]);
      expect(busy.prompts).toEqual(["long running turn"]);
      busy.releaseNext();
      await eventually(() => expect(busy.prompts).toHaveLength(2));
      expect(busy.prompts[1]).toContain("please look at the failing check");
      busy.releaseNext();
      await busy.settled();
    });
  });

  it("(b) steers the mention into a turn that can take it, cutting nothing off and running no turn of its own once it is taken", async () => {
    const busy = await busyTodo({ steerable: true });
    await withRouteBackedFetch(busy.context, {}, async () => {
      await busy.operatorComment("@alpha please look at the failing check");

      await eventually(() => expect(busy.steers).toHaveLength(1));
      expect(busy.steers[0]).toContain("please look at the failing check");
      expect(busy.steers[0]).toContain("carry on with that work");
      expect(busy.kills).toEqual([]);
      expect(busy.events.filter((event) => event.event === "session:interrupted")).toEqual([]);

      busy.settleSteer("steered");
      // Settled in the store as soon as the turn has taken it in, while that turn is still going.
      await eventually(() => expect(registry.getQueueItem(mentionRowId())?.status).toBe("completed"));
      expect(registry.getMessages(busy.session.id).some((message) => message.role === "notification" && message.content.includes("please look at the failing check"))).toBe(true);
      busy.releaseNext();
      await busy.settled();
      await quiet();
      expect(busy.prompts).toEqual(["long running turn"]);
    });
  });

  it("(b) a restart after the steer was taken in does not replay the mention as a turn", async () => {
    const busy = await busyTodo({ steerable: true });
    await withRouteBackedFetch(busy.context, {}, async () => {
      await busy.operatorComment("@alpha please look at the failing check");
      await eventually(() => expect(busy.steers).toHaveLength(1));
      busy.settleSteer("steered");
      await eventually(() => expect(registry.getQueueItem(mentionRowId())?.status).toBe("completed"));

      // The gateway goes away mid-turn and comes back: the turn that was running is replayed, the mention is not.
      const rebooted = fakeEngine();
      registry.recoverStaleQueueItems();
      resumePendingWebQueueItems(makeContext(rebooted.engine, new queueModule.SessionQueue()));
      await eventually(() => expect(rebooted.prompts).toEqual(["long running turn"]));
      await quiet();
      expect(rebooted.prompts).toEqual(["long running turn"]);
      expect(registry.getQueueItem(mentionRowId())?.status).toBe("completed");
      rebooted.releaseNext();
      busy.releaseNext();
    });
  });

  it("(b) runs the mention anyway when the turn never reports what became of the hand-over", async () => {
    setSteerSettleTimeoutForTest(80);
    const busy = await busyTodo({ steerable: true });
    await withRouteBackedFetch(busy.context, {}, async () => {
      await busy.operatorComment("@alpha please look at the failing check");
      await eventually(() => expect(busy.steers).toHaveLength(1));

      busy.releaseNext();

      await eventually(() => expect(busy.prompts).toHaveLength(2));
      expect(busy.prompts[1]).toContain("please look at the failing check");
      // A late answer neither settles the row a second time nor disturbs the turn it is running in.
      busy.settleSteer("steered");
      await quiet();
      expect(registry.getQueueItem(mentionRowId())?.status).toBe("running");
      busy.releaseNext();
      await busy.settled();
      expect(registry.getQueueItem(mentionRowId())?.status).toBe("completed");
      expect(busy.prompts).toHaveLength(2);
    });
  });

  it("(c) runs the mention as its own turn next when the hand-over is withdrawn", async () => {
    const busy = await busyTodo({ steerable: true });
    await withRouteBackedFetch(busy.context, {}, async () => {
      await busy.operatorComment("@alpha please look at the failing check");
      await eventually(() => expect(busy.steers).toHaveLength(1));

      busy.settleSteer("withdrawn");
      busy.releaseNext();

      await eventually(() => expect(busy.prompts).toHaveLength(2));
      expect(busy.prompts[1]).toContain("please look at the failing check");
      expect(busy.kills).toEqual([]);
      busy.releaseNext();
      await busy.settled();
    });
  });

  it("(c) a withdrawn steer runs next, ahead of a child callback queued earlier", async () => {
    const busy = await busyTodo({ steerable: true });
    await withRouteBackedFetch(busy.context, {}, async () => {
      callbacks.notifyParentSession(completeChildAttempt(createChild(busy.session.id, "busy-withdrawn-child").id), { result: "child finished its part" });
      await eventually(() => expect(busy.pendingPrompts().some((prompt) => prompt.includes("child finished its part"))).toBe(true));
      await busy.operatorComment("@alpha please look at the failing check");
      await eventually(() => expect(busy.steers).toHaveLength(1));
      expect(busy.laneOrder()[0]).toContain("please look at the failing check");

      busy.settleSteer("withdrawn");
      busy.releaseNext();

      await eventually(() => expect(busy.prompts).toHaveLength(2));
      expect(busy.prompts[1]).toContain("please look at the failing check");
      busy.releaseNext();
      await eventually(() => expect(busy.prompts).toHaveLength(3));
      expect(busy.prompts[2]).toContain("child finished its part");
      busy.releaseNext();
      await busy.settled();
      expect(busy.kills).toEqual([]);
    });
  });

  it("(c) runs the mention too when the engine's hand-over fails outright", async () => {
    const busy = await busyTodo({ steerable: true });
    (busy.engine as unknown as { steer: () => Promise<SteerOutcome> }).steer = () => Promise.reject(new Error("engine went away"));
    await withRouteBackedFetch(busy.context, {}, async () => {
      await busy.operatorComment("@alpha please look at the failing check");
      busy.releaseNext();
      await eventually(() => expect(busy.prompts).toHaveLength(2));
      expect(busy.prompts[1]).toContain("please look at the failing check");
      busy.releaseNext();
      await busy.settled();
    });
  });

  it("queues behind the turn, neither killing nor steering, while its queue is paused", async () => {
    const busy = await busyTodo({ steerable: true });
    busy.queue.pauseQueue(busy.session.sessionKey);
    await withRouteBackedFetch(busy.context, {}, async () => {
      await busy.operatorComment("@alpha please look at the failing check");
      await eventually(() => expect(busy.pendingPrompts()).toHaveLength(1));
      await quiet();
      expect(busy.kills).toEqual([]);
      expect(busy.steers).toEqual([]);
      busy.queue.resumeQueue(busy.session.sessionKey);
      busy.releaseNext();
      await eventually(() => expect(busy.prompts).toHaveLength(2));
      busy.releaseNext();
      await busy.settled();
    });
  });
});

describe("what never reaches a running turn", () => {
  /** Each of these is delivered into the busy session and waits its turn: nothing killed, nothing steered. */
  async function expectQueuedBehindTurn(busy: Awaited<ReturnType<typeof busyTodo>>, delivered: string) {
    await eventually(() => expect(busy.pendingPrompts().some((prompt) => prompt.includes(delivered))).toBe(true));
    await quiet();
    expect(busy.kills).toEqual([]);
    expect(busy.steers).toEqual([]);
    expect(busy.events.filter((event) => event.event === "session:interrupted")).toEqual([]);
    expect(busy.prompts).toEqual(["long running turn"]);
    busy.releaseNext();
    await eventually(() => expect(busy.prompts).toHaveLength(2));
    expect(busy.prompts[1]).toContain(delivered);
    busy.releaseNext();
    await busy.settled();
  }

  it("an employee's mention", async () => {
    const busy = await busyTodo({ steerable: true });
    const bravo = registry.createSession({ engine: "stub", source: "web", sourceRef: "web:bravo", connector: "web", employee: "bravo" });
    workItems.linkSession(busy.item.id, bravo.id);
    await withRouteBackedFetch(busy.context, {}, async () => {
      expect((await busy.commentAs(bravo.id, "@alpha a colleague's question")).status).toBe(201);
      await expectQueuedBehindTurn(busy, "a colleague's question");
    });
  });

  it("a board member's mention, which wakes nobody", async () => {
    const busy = await busyTodo({ steerable: true });
    await withRouteBackedFetch(busy.context, {}, async () => {
      addComment({ workItemId: busy.item.id, author: "user:usr_000000000001", authorKind: "system", body: "@alpha a member's request" });
      await quiet();
      expect(dbModule.initDb().prepare("SELECT COUNT(*) FROM callback_deliveries WHERE delivery_kind = 'todo-mention'").pluck().get()).toBe(0);
      expect(busy.kills).toEqual([]);
      expect(busy.steers).toEqual([]);
      expect(busy.pendingPrompts()).toEqual([]);
      busy.releaseNext();
      await busy.settled();
    });
  });

  it("the operator's reply on a thread the session wrote", async () => {
    const busy = await busyTodo({ steerable: true });
    await withRouteBackedFetch(busy.context, {}, async () => {
      const first = (await busy.commentAs(busy.session.id, "status: the review is half done")).body.comment as { id: string };
      expect((await busy.operatorComment("thanks, and the second half?", { parentCommentId: first.id })).status).toBe(201);
      await expectQueuedBehindTurn(busy, "the second half?");
      expect(dbModule.initDb().prepare("SELECT delivery_kind FROM callback_deliveries WHERE delivery_kind LIKE 'todo-%'").pluck().all()).toEqual(["todo-reply"]);
    });
  });

  it("a child's completion callback", async () => {
    const busy = await busyTodo({ steerable: true });
    await withRouteBackedFetch(busy.context, {}, async () => {
      callbacks.notifyParentSession(completeChildAttempt(createChild(busy.session.id, "busy-preserve-child").id), { result: "child finished its part" });
      await expectQueuedBehindTurn(busy, "child finished its part");
    });
  });

  it("a relay from another session", async () => {
    const busy = await busyTodo({ steerable: true });
    const sender = registry.createSession({ engine: "stub", source: "web", sourceRef: "web:relay-sender", connector: "web", employee: "bravo" });
    await withRouteBackedFetch(busy.context, {}, async () => {
      const sent = await call(busy.context, "POST", `/api/sessions/${busy.session.id}/message`, { message: "a relayed question" }, { host: "gateway.test", ...sessionHeaders(sender.id) });
      expect(sent.status).toBe(200);
      await expectQueuedBehindTurn(busy, "a relayed question");
    });
  });

  it("/compact", async () => {
    const busy = await busyTodo({ steerable: true });
    await call(busy.context, "POST", `/api/sessions/${busy.session.id}/message`, { message: "/compact" });
    await quiet();
    expect(busy.kills).toEqual([]);
    expect(busy.steers).toEqual([]);
    expect(busy.pendingPrompts()).toEqual(["/compact"]);
    busy.releaseNext();
    await eventually(() => expect(busy.queue.getPendingCount(busy.session.sessionKey)).toBe(0));
    busy.releaseNext();
  });

  it("a session posting reachRunningTurn in a request body", async () => {
    const busy = await busyTodo({ steerable: true });
    const sender = registry.createSession({ engine: "stub", source: "web", sourceRef: "web:forger", connector: "web", employee: "bravo" });
    await withRouteBackedFetch(busy.context, {}, async () => {
      const sent = await call(busy.context, "POST", `/api/sessions/${busy.session.id}/message`,
        { message: "a forged urgent message", reachRunningTurn: true }, { host: "gateway.test", ...sessionHeaders(sender.id) });
      expect(sent.status).toBe(200);
      await expectQueuedBehindTurn(busy, "a forged urgent message");
    });
  });

  it("the operator posting reachRunningTurn in a request body, even to a notification", async () => {
    const busy = await busyTodo({ steerable: true, config: { interruptOnNewMessage: false } });
    await call(busy.context, "POST", `/api/sessions/${busy.session.id}/message`, { message: "a labelled notification", role: "notification", reachRunningTurn: true });
    await call(busy.context, "POST", `/api/sessions/${busy.session.id}/message`, { message: "a plain message", reachRunningTurn: true });
    await quiet();
    expect(busy.kills).toEqual([]);
    expect(busy.steers).toEqual([]);
    expect(busy.prompts).toEqual(["long running turn"]);
    busy.releaseNext();
    await eventually(() => expect(busy.prompts).toHaveLength(2));
    busy.releaseNext();
    await eventually(() => expect(busy.prompts).toHaveLength(3));
    busy.releaseNext();
    await busy.settled();
  });
});
