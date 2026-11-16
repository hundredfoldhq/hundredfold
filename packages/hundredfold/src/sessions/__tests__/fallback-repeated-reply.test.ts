import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_B, answer, config, employee, reg, scripted, limited, useWalkHarness } from "./fallback-walk-harness.js";
import { runRateLimitTurn, type RateLimitTurnArgs } from "../turn/rate-limit-turn.js";
import { REPEATED_REPLY_NOTE } from "../callbacks.js";
import { STRUCTURED_MESSAGE_BODY_MAX_CHARS, type Engine } from "../../shared/types.js";

/**
 * A session that finished a turn whose reply went to its parent, hit its usage
 * limit on the next turn and was moved to another account. The parent must not
 * be sent the reply it already has a second time.
 */

useWalkHarness();

const SUMMARY = "Round three: two findings, both fixed. Verdict: pass.";

afterEach(() => { vi.unstubAllGlobals(); });

/** The gateway, as far as a callback is concerned: accepting the delivery puts it in the parent's transcript. */
function stubGateway(parentId: string) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { message: string; displayMessage?: string; meta?: Record<string, unknown>; callbackDeliveryId?: string };
    if (body.callbackDeliveryId) reg.acceptSessionDelivery(body.callbackDeliveryId, parentId, "web:requester");
    else reg.insertMessage(parentId, "notification", body.displayMessage ?? body.message, undefined, undefined, undefined, body.meta as never);
    return { ok: true, status: 200 } as Response;
  }));
}

function parentAndChild() {
  const parent = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:requester", sessionKey: "web:requester", employee: "requester" });
  const child = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:reviewer", sessionKey: "web:reviewer", employee: "reviewer", model: "opus", parentSessionId: parent.id });
  reg.recordEngineSessionId(child.id, "claude", "a-thread");
  return { parentId: parent.id, childId: child.id };
}

/** What the parent has been told by the child, newest last. */
function toldToParent(parentId: string): string[] {
  return reg.getMessages(parentId)
    .filter((message) => message.role === "notification" && message.meta?.["kind"] === "child-reply")
    .map((message) => String(message.meta!["fullMessage"]));
}

/** The turn of `childId` that hit its limit, handed to the runner as it would be. */
function limitedTurnArgs(childId: string, engines: Map<string, Engine>, prompt: string): RateLimitTurnArgs {
  const started = reg.beginSessionAttempt(childId)!;
  const session = reg.getSession(childId)!;
  const surface = { notice: vi.fn(async () => {}), reply: vi.fn(async () => {}), waiting: vi.fn(async () => {}), delta: vi.fn(), started: vi.fn(async () => {}), settled: vi.fn(async () => {}) };
  return {
    input: { session, employee: employee({ name: "reviewer", fallback: [CLAUDE_B] } as never), attachments: [], attemptToken: started.attemptToken!, prompt, config, engines },
    plan: { engineName: "claude", engineConfig: { model: "opus" }, engine: engines.get("claude")!, model: "opus" },
    surface,
    systemPrompt: "",
    platformContextFingerprint: "fp",
    rateLimit: { resetsAt: Math.floor(Date.now() / 1000) + 3600 },
    originalResult: limited(),
    terminalFields: () => ({}),
  } as unknown as RateLimitTurnArgs;
}

describe("a session that falls back to another account after it delivered a reply", () => {
  it("does not send its parent the same reply again when the first turn there repeats it", async () => {
    const { parentId, childId } = parentAndChild();
    stubGateway(parentId);
    // Round three went out before the limit, as the automatic reply of that turn.
    reg.insertMessage(parentId, "notification", "📩 reviewer replied", undefined, undefined, undefined, { kind: "child-reply", childSessionId: childId, fullMessage: SUMMARY });
    const { engines } = scripted(() => answer(SUMMARY, "b-thread"));
    await runRateLimitTurn(limitedTurnArgs(childId, engines, "Hold: do not start another round."));

    expect(toldToParent(parentId)).toEqual([SUMMARY, REPEATED_REPLY_NOTE]);
  });

  it("sends its parent a reply that is new", async () => {
    const { parentId, childId } = parentAndChild();
    stubGateway(parentId);
    reg.insertMessage(parentId, "notification", "📩 reviewer replied", undefined, undefined, undefined, { kind: "child-reply", childSessionId: childId, fullMessage: SUMMARY });
    const { engines } = scripted(() => answer("Holding. Nothing further until told.", "b-thread"));
    await runRateLimitTurn(limitedTurnArgs(childId, engines, "Hold: do not start another round."));

    expect(toldToParent(parentId)).toEqual([SUMMARY, "Holding. Nothing further until told."]);
  });

  it("treats the same text from its own send_to_session as already delivered", async () => {
    const { parentId, childId } = parentAndChild();
    stubGateway(parentId);
    reg.insertMessage(parentId, "notification", "📨 From reviewer", undefined, undefined, undefined, { kind: "agent-relay", fromSessionId: childId, fullMessage: SUMMARY });
    const { engines } = scripted(() => answer(SUMMARY, "b-thread"));
    await runRateLimitTurn(limitedTurnArgs(childId, engines, "Hold: do not start another round."));

    expect(toldToParent(parentId)).toEqual([REPEATED_REPLY_NOTE]);
  });

  it("compares a long reply as the parent stored it, which clips it", async () => {
    const { parentId, childId } = parentAndChild();
    stubGateway(parentId);
    const long = "R".repeat(20_000);
    reg.insertMessage(parentId, "notification", "📩 reviewer replied", undefined, undefined, undefined, { kind: "child-reply", childSessionId: childId, fullMessage: long.slice(0, STRUCTURED_MESSAGE_BODY_MAX_CHARS) });
    const { engines } = scripted(() => answer(long, "b-thread"));
    await runRateLimitTurn(limitedTurnArgs(childId, engines, "Hold: do not start another round."));

    expect(toldToParent(parentId)).toEqual([long.slice(0, STRUCTURED_MESSAGE_BODY_MAX_CHARS), REPEATED_REPLY_NOTE]);
  });

  it("is only about a reply the parent has: a first reply, and another child's, go through", async () => {
    const { parentId, childId } = parentAndChild();
    stubGateway(parentId);
    reg.insertMessage(parentId, "notification", "📩 other replied", undefined, undefined, undefined, { kind: "child-reply", childSessionId: "some-other-child", fullMessage: SUMMARY });
    const { engines } = scripted(() => answer(SUMMARY, "b-thread"));
    await runRateLimitTurn(limitedTurnArgs(childId, engines, "review round three"));

    expect(toldToParent(parentId)).toEqual([SUMMARY, SUMMARY]);
  });
});

describe("a turn that was not recovered from a usage limit", () => {
  it("relays an identical reply as it always did", async () => {
    const { parentId, childId } = parentAndChild();
    stubGateway(parentId);
    reg.insertMessage(parentId, "notification", "📩 reviewer replied", undefined, undefined, undefined, { kind: "child-reply", childSessionId: childId, fullMessage: "Done." });
    const { notifyParentSessionAndWait } = await import("../callbacks.js");
    const started = reg.beginSessionAttempt(childId)!;
    await notifyParentSessionAndWait({ ...reg.getSession(childId)!, attemptToken: started.attemptToken! }, { result: "Done." });

    expect(toldToParent(parentId)).toEqual(["Done.", "Done."]);
  });
});
