import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadMentionHarness, mentionTestHome, sessionHeaders } from "./todo-mentions-harness.js";

// A session that holds a Todo's live claim can hand the Todo on with a
// delegation: the claim moves to the delegate. A claim held by any other
// session still refuses the delegation.
mentionTestHome("hundredfold-todo-delegation-own-claim-");

vi.mock("../../sessions/callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/callbacks.js")>();
  return { ...actual, deliverClaimedSessionDelivery: async () => "accepted" as const };
});

let h: Awaited<ReturnType<typeof loadMentionHarness>>;
beforeAll(async () => {
  h = await loadMentionHarness();
});

function delegateAs(callerId: string, todoId: string, employee: string, extra: Record<string, unknown> = {}) {
  return h.call("POST", "/api/delegations", { workItemId: todoId, employee, task: `Take ${todoId} over.`, ...extra }, sessionHeaders(callerId));
}

describe("a session handing on the Todo it holds", () => {
  it("transfers its claim to the delegate instead of being refused", async () => {
    const item = h.store.createWorkItem({ title: "producer hands up", assignee: "worker", status: "executing" });
    const caller = h.executing(item.id);

    const res = await delegateAs(caller.id, item.id, "alpha");

    expect(res.status).toBe(201);
    expect(res.body.sessionId).not.toBe(caller.id);
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(res.body.sessionId);
    expect(h.store.getWorkItem(item.id)?.assignee).toBe("alpha");
    expect(h.registry.getSession(res.body.sessionId)).toMatchObject({ workItemId: item.id, employee: "alpha", parentSessionId: caller.id });
    // The caller is a finished executor on the Todo, not a second claim holder.
    expect(h.registry.getSession(caller.id)).toMatchObject({ workItemRole: "execute" });
  });

  it("transfers it with freshSession too", async () => {
    const item = h.store.createWorkItem({ title: "producer hands up, fresh", assignee: "worker", status: "executing" });
    const caller = h.executing(item.id);

    const res = await delegateAs(caller.id, item.id, "alpha", { freshSession: true });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("replacedSessionId");
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(res.body.sessionId);
  });

  it("transfers it into the delegate's live session on the Todo", async () => {
    const item = h.store.createWorkItem({ title: "hands up into a live session", assignee: "worker", status: "executing" });
    const caller = h.executing(item.id);
    await h.comment(item.id, "@alpha thoughts?");
    const [mentioned] = h.sessionsOf(item.id, "alpha");
    h.registry.updateSession(mentioned.id, { status: "idle" });

    const res = await delegateAs(caller.id, item.id, "alpha");

    expect(res).toMatchObject({ status: 200, body: { sessionId: mentioned.id, reused: true } });
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(mentioned.id);
  });

  it("transfers it when freshSession replaces a live session the caller spawned", async () => {
    const item = h.store.createWorkItem({ title: "hands up, replacing a child", assignee: "worker", status: "executing" });
    const caller = h.executing(item.id);
    const child = h.registry.createSession({
      engine: "codex", source: "web", sourceRef: `child:${crypto.randomUUID()}`, employee: "alpha", connector: "web", parentSessionId: caller.id,
    });
    h.store.linkSession(item.id, child.id);
    h.registry.updateSession(child.id, { status: "idle" });

    const res = await delegateAs(caller.id, item.id, "alpha", { freshSession: true });

    expect(res).toMatchObject({ status: 201, body: { replacedSessionId: child.id } });
    expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(res.body.sessionId);
  });

  it("keeps its claim when the delegation fails after the claim was taken", async () => {
    const item = h.store.createWorkItem({ title: "hand-off falls through", assignee: "worker", status: "executing" });
    const caller = h.executing(item.id);
    const before = h.claims.getWorkItemClaim(item.id)!;

    // `offline` runs on an engine the gateway has no instance of: refused after the claim step.
    const res = await delegateAs(caller.id, item.id, "offline");

    expect(res.status).toBe(502);
    expect(h.store.getWorkItem(item.id)?.assignee).toBe("worker");
    expect(h.claims.getWorkItemClaim(item.id)).toMatchObject({ owner: before.owner, sessionId: caller.id });
  });

  it("leaves a claim it holds on another Todo alone", async () => {
    const mine = h.store.createWorkItem({ title: "the one I hold", assignee: "worker", status: "executing" });
    const other = h.store.createWorkItem({ title: "someone else holds this", assignee: "worker", status: "executing" });
    const caller = h.executing(mine.id);
    const holder = h.executing(other.id, "bravo");

    const res = await delegateAs(caller.id, other.id, "alpha");

    expect(res.status).toBe(409);
    expect(h.claims.getWorkItemClaim(mine.id)?.sessionId).toBe(caller.id);
    expect(h.claims.getWorkItemClaim(other.id)?.sessionId).toBe(holder.id);
  });
});

describe("a session that does not hold the Todo's claim", () => {
  it("is still refused while another live session holds it, with or without freshSession", async () => {
    for (const freshSession of [false, true]) {
      const item = h.store.createWorkItem({ title: `held by somebody else (${freshSession})`, assignee: "worker", status: "executing" });
      const holder = h.executing(item.id);
      const caller = h.employeeSession("org-root");

      const res = await delegateAs(caller.id, item.id, "alpha", { freshSession });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(h.claims.getWorkItemClaim(item.id)?.sessionId).toBe(holder.id);
      expect(h.sessionsOf(item.id, "alpha")).toHaveLength(0);
    }
  });
});
