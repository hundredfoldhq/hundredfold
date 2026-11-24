import { describe, expect, it } from "vitest";
import { buildSessionTools } from "../session-tools.js";
import type { HundredfoldMcpContext, HundredfoldMcpTool } from "../toolkit.js";

/** What `send_to_session` forwards of `interrupt`, and what it tells its caller about the interrupt. */

function sendTool(): HundredfoldMcpTool {
  const tool = buildSessionTools().find((t) => t.name === "send_to_session");
  if (!tool) throw new Error("no send_to_session");
  return tool;
}

function gateway(reply: { status: number; body: unknown }) {
  const bodies: unknown[] = [];
  const ctx: HundredfoldMcpContext = {
    gatewayUrl: "http://gateway.test",
    callerSessionId: "sender",
    sessionCapability: "cap-test",
    fetchFn: (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      return { status: reply.status, text: async () => JSON.stringify(reply.body) } as unknown as Response;
    }) as unknown as typeof fetch,
  };
  return { bodies, ctx };
}

type Out = Record<string, unknown> & { hint: string };

describe("send_to_session interrupt", () => {
  it("forwards interrupt only when asked for", async () => {
    const { bodies, ctx } = gateway({ status: 200, body: { status: "queued", queueItemId: "q1", targetRunning: true, queuedFromYou: 1 } });
    await sendTool().handler({ sessionId: "target", message: "hi" }, ctx);
    await sendTool().handler({ sessionId: "target", message: "hi", interrupt: false }, ctx);
    await sendTool().handler({ sessionId: "target", message: "hi", interrupt: true }, ctx);
    expect(bodies).toEqual([{ message: "hi" }, { message: "hi" }, { message: "hi", interrupt: true }]);
  });

  it("reports delivered when the turn was cut, and says nothing it had done is lost", async () => {
    const { ctx } = gateway({ status: 200, body: { status: "queued", queueItemId: "q2", targetRunning: true, queuedFromYou: 1, interrupt: "interrupted" } });
    const out = (await sendTool().handler({ sessionId: "target", message: "stop", interrupt: true }, ctx)) as Out;
    expect(out).toMatchObject({ status: "delivered (interrupted turn)", queueId: "q2", interrupt: "interrupted" });
    expect(out.hint).toMatch(/cut short between tool calls/);
    expect(out.hint).toMatch(/Nothing it had already done is lost/);
  });

  it.each([
    ["waiting", /tool call is still running/],
    ["unsupported", /cannot be cut short/],
    ["held", /compacting or its queue is paused/],
    ["over", /turn ended before/],
  ])("reports queued, with the reason, when the interrupt was %s", async (interrupt, hint) => {
    const { ctx } = gateway({ status: 200, body: { status: "queued", queueItemId: "q3", targetRunning: true, queuedFromYou: 1, interrupt } });
    const out = (await sendTool().handler({ sessionId: "target", message: "stop", interrupt: true }, ctx)) as Out;
    expect(out).toMatchObject({ status: "queued", interrupt });
    expect(out.hint).toMatch(hint);
  });

  it("keeps today's wording for a send that did not ask", async () => {
    const { ctx } = gateway({ status: 200, body: { status: "queued", queueItemId: "q4", targetRunning: true, queuedFromYou: 1 } });
    const out = (await sendTool().handler({ sessionId: "target", message: "later" }, ctx)) as Out;
    expect(out).toMatchObject({ status: "queued", targetRunning: true });
    expect(out).not.toHaveProperty("interrupt");
    expect(out.hint).toMatch(/target is mid-turn and reads this when it ends/);
  });
});
