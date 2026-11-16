import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadMentionHarness, mentionTestHome } from "./todo-mentions-harness.js";

// Which comments ask a mention to reach a running turn: the flag on the durable
// delivery row, on every path that delivers into a live session, and only for
// the operator's own words. Nothing leaves the process: the outbox's hop is
// mocked, so what is read is the row each delivery claims.
mentionTestHome("hundredfold-todo-mention-reach-");

vi.mock("../../sessions/callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/callbacks.js")>();
  return { ...actual, deliverClaimedSessionDelivery: async () => "accepted" as const };
});

let h: Awaited<ReturnType<typeof loadMentionHarness>>;
beforeAll(async () => {
  h = await loadMentionHarness();
});

/** The payloads delivered into the session, oldest first. */
async function payloadsTo(sessionId: string, kind: string) {
  const db = (await import("../../shared/db.js")).initDb();
  return (db.prepare("SELECT payload FROM callback_deliveries WHERE target_session_id = ? AND delivery_kind = ? ORDER BY created_at, rowid").pluck().all(sessionId, kind) as string[])
    .map((payload) => JSON.parse(payload) as { reachRunningTurn?: true; message: string });
}

describe("the flag on a mention's delivery", () => {
  it("is set when the operator mentions the Todo's live employee, and not when an employee does", async () => {
    const item = h.store.createWorkItem({ title: "flagged live path" });
    const worker = h.executing(item.id);
    const other = h.employeeSession("bravo");
    h.store.linkSession(item.id, other.id);

    await h.comment(item.id, "@worker from the operator");
    await h.comment(item.id, "@worker from a colleague", { as: other.id });

    const [fromOperator, fromEmployee] = await payloadsTo(worker.id, "todo-mention");
    expect(fromOperator.reachRunningTurn).toBe(true);
    expect(fromEmployee.reachRunningTurn).toBeUndefined();
    expect(fromEmployee).not.toHaveProperty("reachRunningTurn");
  });

  it("is set on the owner path, where the mention goes to the session that created the Todo", async () => {
    const parent = h.store.createWorkItem({ title: "owner parent", assignee: "alpha", status: "executing" });
    const owner = h.employeeSession("alpha");
    h.store.linkSession(parent.id, owner.id);
    const child = h.store.createWorkItem({ title: "owned child", source: "session", sourceRef: `session:${owner.id}:child` });

    await h.comment(child.id, "@alpha from the operator");

    const [delivered] = await payloadsTo(owner.id, "todo-mention");
    expect(delivered.reachRunningTurn).toBe(true);
  });

  it("is set for the remote MCP connector, which is the operator's own door", async () => {
    const item = h.store.createWorkItem({ title: "flagged remote door" });
    const worker = h.executing(item.id);
    const connector = h.registry.createSession({ engine: "codex", source: "remote-mcp", sourceRef: `remote-mcp:${crypto.randomUUID()}`, connector: "remote-mcp" });
    h.store.linkSession(item.id, connector.id);

    await h.comment(item.id, "@worker via the connector", { as: connector.id });

    expect((await payloadsTo(worker.id, "todo-mention"))[0].reachRunningTurn).toBe(true);
  });

  it("is not set on a reply, which waits its turn", async () => {
    const item = h.store.createWorkItem({ title: "unflagged reply" });
    const worker = h.executing(item.id);
    const first = await h.comment(item.id, "status", { as: worker.id });

    await h.comment(item.id, "thanks, carry on", { parentCommentId: first.id });

    const [reply] = await payloadsTo(worker.id, "todo-reply");
    expect(reply).toBeDefined();
    expect(reply).not.toHaveProperty("reachRunningTurn");
  });

  it("asks the tagged session to carry on with what it was doing", async () => {
    const item = h.store.createWorkItem({ title: "carry on prompt" });
    const worker = h.executing(item.id);

    await h.comment(item.id, "@worker one question");

    expect((await payloadsTo(worker.id, "todo-mention"))[0].message)
      .toContain("If this reached you in the middle of other work, answer it and then carry on with that work.");
  });
});
