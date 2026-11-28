import { assertBoundCaller, gatewayRequest, HundredfoldMcpToolError, type HundredfoldMcpTool } from "./toolkit.js";

/**
 * Hanging up a spoken conversation. The tool acts on the calling session's own voice call only (the gateway takes
 * the session from the verified caller, there is no id argument), and ends the call, not the chat: the session,
 * its messages and its engine are untouched, and the user can start another call or type. It is on the belt for
 * every session because an engine's manifest is fixed when its server starts, long before a call is opened; with
 * no call open it answers with an error that says so.
 *
 * The description is terse on purpose: this group pays its own way against the fixed manifest token budget
 * (`__tests__/tool-manifest-budget.test.ts`).
 */
const endVoiceCall: HundredfoldMcpTool = {
  name: "end_voice_call",
  description: "Hang up your voice call; the chat stays. Only on a clear request.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args, ctx) => {
    assertBoundCaller(ctx);
    const { status, body } = await gatewayRequest(ctx, "POST", "/api/voice/end", {});
    if (status >= 400) {
      const detail = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : `status ${status}`;
      throw new HundredfoldMcpToolError(`ending the voice call failed (${status}): ${detail}${status === 409 ? " Answer in text instead." : ""}`);
    }
    return { action: "ending", hint: "The call ends once you have finished speaking. Say a short goodbye now and call nothing else." };
  },
};

export function buildVoiceTools(): HundredfoldMcpTool[] {
  return [endVoiceCall];
}
