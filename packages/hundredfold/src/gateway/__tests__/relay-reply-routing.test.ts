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
import type { Engine, EngineRunOpts } from "../../shared/types.js";

/**
 * A reviewer one delegated child spawned and other sessions reuse. A reply to a
 * turn another session asked for goes to that session; the spawner, whose own
 * task is over, is not woken, and so its own parent is not woken either. The
 * real route, SQLite, SessionQueue and settlement callback run; only the engine
 * is a stub.
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

function notificationsFor(sessionId: string) {
  return registry.getMessages(sessionId).filter((message) => message.role === "notification");
}

function childReplies(sessionId: string, childId: string) {
  return notificationsFor(sessionId).filter((message) => {
    const meta = message.meta as { kind?: string; childSessionId?: string } | undefined;
    return meta?.kind === "child-reply" && meta.childSessionId === childId;
  });
}

describe("a reused reviewer's replies reach the session that asked", () => {
  async function setUp() {
    const ran: string[] = [];
    let gate: Promise<void> | undefined;
    const engine: Engine = {
      name: "stub",
      run: async (opts: EngineRunOpts) => {
        ran.push(opts.sessionId ?? "");
        if (opts.sessionId === reviewer.id && gate) await gate;
        return { sessionId: "stub", result: opts.sessionId === reviewer.id ? "status: my pass stands" : "Nothing for me in this relay" };
      },
    };
    const orchestrator = createParent("relay-orchestrator");
    const spawner = createChild(orchestrator.id, "relay-spawner");
    const reviewer = createChild(spawner.id, "relay-reviewer");
    const askerOne = createParent("relay-asker-one");
    const askerTwo = createParent("relay-asker-two");
    const context = makeContext(engine, new queueModule.SessionQueue());
    return {
      context, orchestrator, spawner, reviewer, askerOne, askerTwo, ran,
      holdReviewer(): () => void {
        let release!: () => void;
        gate = new Promise<void>((resolve) => { release = resolve; });
        return () => { gate = undefined; release(); };
      },
    };
  }

  it("delivers the reply to the sender and wakes neither the spawner nor its parent", async () => {
    const { context, orchestrator, spawner, reviewer, askerOne, ran } = await setUp();
    await withRouteBackedFetch(context, {}, async () => {
      expect((await post(context, reviewer.id, { message: "please review change 7" }, toolHeaders(askerOne.id))).status).toBe(200);
      await eventually(() => expect(childReplies(askerOne.id, reviewer.id)).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(notificationsFor(spawner.id)).toHaveLength(0);
    expect(notificationsFor(orchestrator.id)).toHaveLength(0);
    expect(ran.filter((id) => id === spawner.id || id === orchestrator.id)).toHaveLength(0);
  });

  it("answers each of several senders whose messages queue behind a running turn", async () => {
    const { context, orchestrator, spawner, reviewer, askerOne, askerTwo, ran, holdReviewer } = await setUp();
    const release = holdReviewer();
    await withRouteBackedFetch(context, {}, async () => {
      await post(context, reviewer.id, { message: "please review change 7" }, toolHeaders(askerOne.id));
      await eventually(() => expect(ran).toContain(reviewer.id));
      await post(context, reviewer.id, { message: "and change 8" }, toolHeaders(askerTwo.id));
      release();
      await eventually(() => expect(childReplies(askerOne.id, reviewer.id)).toHaveLength(1));
      await eventually(() => expect(childReplies(askerTwo.id, reviewer.id)).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(notificationsFor(spawner.id)).toHaveLength(0);
    expect(notificationsFor(orchestrator.id)).toHaveLength(0);
    expect(ran.filter((id) => id === spawner.id || id === orchestrator.id)).toHaveLength(0);
  });

  describe("when the spawner is woken anyway", () => {
    /** The spawner asks its reviewer, so the reviewer's reply is a child report the spawner wakes for. */
    async function spawnerWokenByReviewer(todoStatus: "in_review" | "executing", spawnerReply: string) {
      const orchestrator = createParent("wake-orchestrator");
      const spawner = createChild(orchestrator.id, "wake-spawner");
      const reviewer = createChild(spawner.id, "wake-reviewer");
      const item = workItems.createWorkItem({ title: "Spawner's task", status: todoStatus, source: "delegation" });
      workItems.linkSession(item.id, spawner.id);
      const ran: string[] = [];
      const engine: Engine = {
        name: "stub",
        run: async (opts: EngineRunOpts) => {
          ran.push(opts.sessionId ?? "");
          return { sessionId: "stub", result: opts.sessionId === reviewer.id ? "my pass stands" : spawnerReply };
        },
      };
      const context = makeContext(engine, new queueModule.SessionQueue());
      await withRouteBackedFetch(context, {}, async () => {
        await post(context, reviewer.id, { message: "status of change 7?" }, toolHeaders(spawner.id));
        await eventually(() => expect(ran).toContain(spawner.id));
        await eventually(() => expect(registry.getSession(spawner.id)!.status).toBe("idle"));
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      return { orchestrator, spawner, ran };
    }

    it("keeps a finished spawner's 'nothing for me' from its own parent", async () => {
      const { orchestrator, spawner, ran } = await spawnerWokenByReviewer("in_review", "Nothing for me in this relay");
      expect(ran).toContain(spawner.id);
      expect(childReplies(orchestrator.id, spawner.id)).toHaveLength(0);
      expect(ran).not.toContain(orchestrator.id);
    });

    it("still tells the parent when the spawner's task is open", async () => {
      const { orchestrator, spawner } = await spawnerWokenByReviewer("executing", "Nothing for me in this relay");
      expect(childReplies(orchestrator.id, spawner.id)).toHaveLength(1);
    });

    it("still tells the parent when a finished spawner has something to ask", async () => {
      const { orchestrator, spawner } = await spawnerWokenByReviewer("in_review", "The reviewer found a bug: should I reopen the task?");
      expect(childReplies(orchestrator.id, spawner.id)).toHaveLength(1);
    });
  });
});
