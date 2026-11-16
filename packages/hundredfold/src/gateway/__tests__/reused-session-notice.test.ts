import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  createChild,
  createParent,
  eventually,
  makeContext,
  queueModule,
  registry,
  resetCallbackState,
  workItems,
  type ApiContext,
} from "./helpers/callback-harness.js";
import { makeResponse, withRouteBackedFetch } from "./helpers/callback-requests.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  ensureSessionCapability,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
} from "../../mcp/identity.js";
import { runtimeActivity } from "../../sessions/background-work.js";
import { noticeTargetSessionId } from "../../sessions/turn-requester.js";
import { recordNewDelegateSession } from "../../work-items/employee-session-delegation.js";
import type { Engine, EngineRunOpts } from "../../shared/types.js";

/**
 * A session one session spawned and others reuse. Whoever's message a turn
 * answers is who hears the automatic end-of-turn notice, not the spawner. These
 * drive the real route, real SQLite, a real SessionQueue and the real
 * settlement callback; only the engine is a stub.
 */

beforeEach(resetCallbackState);

function toolHeaders(callerSessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: callerSessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(callerSessionId),
  };
}

async function post(context: ApiContext, sessionId: string, body: unknown, headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: `/api/sessions/${sessionId}/message`,
    headers: {
      host: "gateway.test",
      authorization: "Bearer test-token",
      "content-type": "application/json",
      ...headers,
    },
  });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  return captured;
}

/** The automatic "replied" notices `sessionId` holds for `childId`. */
function replyNotices(sessionId: string, childId: string) {
  return registry.getMessages(sessionId).filter((message) => {
    const meta = message.meta as { kind?: string; childSessionId?: string } | undefined;
    return message.role === "notification" && meta?.kind === "child-reply" && meta.childSessionId === childId;
  });
}

/** The explicit relays `sessionId` holds from `fromSessionId`. */
function relays(sessionId: string, fromSessionId: string) {
  return registry.getMessages(sessionId).filter((message) => {
    const meta = message.meta as { kind?: string; fromSessionId?: string } | undefined;
    return meta?.kind === "agent-relay" && meta.fromSessionId === fromSessionId;
  });
}

function settled(sessionId: string, turns: number) {
  const session = registry.getSession(sessionId)!;
  expect(session.status).toBe("idle");
  expect(session.totalTurns).toBeGreaterThanOrEqual(turns);
}

/** An engine that answers every turn, and, for the session named in `replyTo`,
 *  first `send_to_session`s its answer to that session as `reviewerId`. */
function reviewerEngine(context: () => ApiContext, reviewerId: () => string, replyTo: { id?: string }): Engine {
  return {
    name: "stub",
    run: async (opts: EngineRunOpts) => {
      if (opts.sessionId === reviewerId() && replyTo.id) {
        await post(context(), replyTo.id, { message: "verdict: pass" }, toolHeaders(reviewerId()));
      }
      return { sessionId: "stub", result: "review done" };
    },
  };
}

describe("a reused spawned session reports to whoever asked", () => {
  async function setUp(replyTo: { id?: string } = {}) {
    const queue = new queueModule.SessionQueue();
    let context!: ApiContext;
    const spawner = createParent("reuse-spawner");
    const reviewer = createChild(spawner.id, "reuse-reviewer");
    const other = createParent("reuse-other");
    context = makeContext(reviewerEngine(() => context, () => reviewer.id, replyTo), queue);
    return { context, spawner, reviewer, other };
  }

  it("sends the notice to the session that sent the message, not the spawner", async () => {
    const { context, spawner, reviewer, other } = await setUp();
    await withRouteBackedFetch(context, {}, async () => {
      const sent = await post(context, reviewer.id, { message: "please review change 2" }, toolHeaders(other.id));
      expect(sent.status).toBe(200);
      await eventually(() => expect(replyNotices(other.id, reviewer.id)).toHaveLength(1));
    });
    expect(replyNotices(spawner.id, reviewer.id)).toHaveLength(0);
    expect(registry.getMessages(spawner.id).filter((message) => message.role === "notification")).toHaveLength(0);
  });

  it("keeps notifying the spawner for a turn the spawner started", async () => {
    const { context, spawner, reviewer, other } = await setUp();
    await withRouteBackedFetch(context, {}, async () => {
      await post(context, reviewer.id, { message: "please review change 2" }, toolHeaders(other.id));
      await eventually(() => expect(replyNotices(other.id, reviewer.id)).toHaveLength(1));
      await eventually(() => settled(reviewer.id, 1));

      const sent = await post(context, reviewer.id, { message: "and the follow-up" }, toolHeaders(spawner.id));
      expect(sent.status).toBe(200);
      await eventually(() => expect(replyNotices(spawner.id, reviewer.id)).toHaveLength(1));
    });
    expect(replyNotices(other.id, reviewer.id)).toHaveLength(1);
  });

  it("does not carry a requester over to a later turn nobody asked for", async () => {
    const { context, spawner, reviewer, other } = await setUp();
    await withRouteBackedFetch(context, {}, async () => {
      await post(context, reviewer.id, { message: "please review change 2" }, toolHeaders(other.id));
      await eventually(() => expect(replyNotices(other.id, reviewer.id)).toHaveLength(1));
      await eventually(() => settled(reviewer.id, 1));
    });
    const next = registry.beginSessionAttempt(reviewer.id)!;
    expect(noticeTargetSessionId(next)).toBe(spawner.id);
  });

  it("gives the sender only the explicit reply when the reviewer replied to it", async () => {
    const replyTo: { id?: string } = {};
    const { context, spawner, reviewer, other } = await setUp(replyTo);
    replyTo.id = other.id;
    await withRouteBackedFetch(context, {}, async () => {
      await post(context, reviewer.id, { message: "please review change 2" }, toolHeaders(other.id));
      await eventually(() => expect(relays(other.id, reviewer.id)).toHaveLength(1));
      await eventually(() => settled(reviewer.id, 1));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(replyNotices(other.id, reviewer.id)).toHaveLength(0);
    expect(replyNotices(spawner.id, reviewer.id)).toHaveLength(0);
  });

  it("still notifies the spawner when its own child is the one asking", async () => {
    const { context, spawner, reviewer } = await setUp();
    const grandchild = createChild(reviewer.id, "reuse-grandchild");
    await withRouteBackedFetch(context, {}, async () => {
      await post(context, reviewer.id, { message: "status from the child" }, toolHeaders(grandchild.id));
      await eventually(() => expect(replyNotices(spawner.id, reviewer.id)).toHaveLength(1));
    });
    expect(replyNotices(grandchild.id, reviewer.id)).toHaveLength(0);
  });

  it("adds no listener: a session that reports to nobody still notifies nobody", async () => {
    const { context, spawner, other } = await setUp();
    await withRouteBackedFetch(context, {}, async () => {
      const sent = await post(context, other.id, { message: "are you free?" }, toolHeaders(spawner.id));
      expect(sent.status).toBe(200);
      await eventually(() => settled(other.id, 1));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(replyNotices(spawner.id, other.id)).toHaveLength(0);
    expect(noticeTargetSessionId(registry.getSession(other.id)!)).toBeNull();
  });

  it("answers the sender, not the delegator, for a Todo session waiting on its own work", async () => {
    // The employee's session on a Todo reports to its delegator, and its reply to
    // a turn it is still working on is normally held. A turn another session
    // asked for is an answer to that session: it goes out to it, and the
    // delegator is not woken.
    const { context, reviewer, other } = await setUp();
    const delegator = createParent("reuse-delegator");
    const item = workItems.createWorkItem({ title: "Reviewed work", status: "executing", source: "delegation" });
    workItems.linkSession(item.id, reviewer.id);
    recordNewDelegateSession(item.id, "worker", reviewer.id, delegator.id);
    runtimeActivity.set(reviewer.id, { activeStreams: 0, lastActivityAt: Date.now(), activeMonitors: 1 });
    try {
      await withRouteBackedFetch(context, {}, async () => {
        await post(context, reviewer.id, { message: "please review change 2" }, toolHeaders(other.id));
        await eventually(() => expect(replyNotices(other.id, reviewer.id)).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    } finally {
      runtimeActivity.delete(reviewer.id);
    }
    expect(replyNotices(delegator.id, reviewer.id)).toHaveLength(0);
  });
});
