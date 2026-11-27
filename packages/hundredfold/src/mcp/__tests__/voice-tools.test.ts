import { describe, expect, it } from "vitest";
import { buildVoiceTools } from "../voice-tools.js";
import { HundredfoldMcpToolError, type HundredfoldMcpContext } from "../toolkit.js";

const [endVoiceCall] = buildVoiceTools();

function stub(status: number, body: unknown, callerSessionId?: string) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return { status, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: HundredfoldMcpContext = { gatewayUrl: "http://gateway.test", fetchFn, callerSessionId, sessionCapability: callerSessionId ? "cap" : undefined };
  return { calls, ctx };
}

describe("end_voice_call", () => {
  it("is one tool with no arguments: it can only ever act on the caller's own call", () => {
    expect(buildVoiceTools().map((t) => t.name)).toEqual(["end_voice_call"]);
    expect(endVoiceCall.inputSchema.properties).toEqual({});
    expect(endVoiceCall.inputSchema.required ?? []).toEqual([]);
  });

  it("posts to the gateway's voice end route and tells the model to say goodbye", async () => {
    const { calls, ctx } = stub(200, { status: "ending" }, "sess-1");
    const result = await endVoiceCall.handler({}, ctx) as { action: string; hint: string };
    expect(calls).toEqual([{ url: "http://gateway.test/api/voice/end", method: "POST", body: {} }]);
    expect(result.action).toBe("ending");
    expect(result.hint).toMatch(/goodbye/i);
  });

  it("fails closed without a bound caller identity, and calls nothing", async () => {
    const { calls, ctx } = stub(200, { status: "ending" });
    await expect(endVoiceCall.handler({}, ctx)).rejects.toBeInstanceOf(HundredfoldMcpToolError);
    expect(calls).toEqual([]);
  });

  it("with no call open, says so and tells the model to answer in text", async () => {
    const { ctx } = stub(409, { error: "No voice call is open on this chat." }, "sess-1");
    await expect(endVoiceCall.handler({}, ctx)).rejects.toThrow(/No voice call is open.*text/s);
  });

  it("passes any other gateway refusal through", async () => {
    const { ctx } = stub(403, { error: "nope" }, "sess-1");
    await expect(endVoiceCall.handler({}, ctx)).rejects.toThrow(/403.*nope/s);
  });
});
