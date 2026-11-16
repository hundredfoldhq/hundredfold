import { describe, expect, it } from "vitest";
import { MAX_ARGUMENT_BYTES } from "../../engines/argv-limit.js";
import { CLAUDE_B, DIR_B, answer, claudeProfileFromDir, employee, handleRateLimit, limitedTurn, newSession, reg, scripted, useWalkHarness } from "./fallback-walk-harness.js";

/**
 * What a fallback hop onto a fresh conversation is told to answer. A message from
 * another session reaches the engine as a notification row, and the request a
 * reviewer or child is working on usually arrives that way; a handoff that kept
 * only user and assistant rows read the previous request as the last one and
 * answered it again.
 */

useWalkHarness();

const RELAY_BANNER = "📨 Message from session 11111111-aaaa (requester):\n\nHold: do not start another round.\n\nTo reply: send_to_session.";

function relayFrom(id: string, message: string) {
  reg.insertMessage(id, "notification", `📨 From requester: ${message}`, undefined, undefined, undefined, {
    kind: "agent-relay", fromSessionId: "11111111-aaaa", fromLabel: "requester", hops: 1, maxHops: 5, fullMessage: message,
  });
}

describe("a fresh conversation on another account answers the message that moved the session", () => {
  it("is handed a message from another session as the current message, not the earlier request again", async () => {
    const { engines, calls } = scripted(() => answer("holding", "b-thread"));
    const id = newSession();
    reg.insertMessage(id, "user", "review round three");
    reg.insertMessage(id, "assistant", "Round three summary: two findings, both fixed.");
    relayFrom(id, "Hold: do not start another round.");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines, { prompt: RELAY_BANNER }).opts);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.resume).toBeUndefined();
    expect(calls[0]!.prompt).toContain("ASSISTANT: Round three summary: two findings, both fixed.");
    expect(calls[0]!.prompt.endsWith(`CURRENT MESSAGE:\n${RELAY_BANNER}`)).toBe(true);
    expect(calls[0]!.prompt).not.toMatch(/respond to the last USER message/);
    // Asked once: the relay is the current message, not also a line of the transcript.
    expect(calls[0]!.prompt.match(/do not start another round/g)).toHaveLength(1);
  });

  it("keeps an earlier message from another session in the transcript, labelled as one", async () => {
    const { engines, calls } = scripted(() => answer("ok", "b-thread"));
    const id = newSession();
    relayFrom(id, "Please review the branch.");
    reg.insertMessage(id, "assistant", "Reviewed.");
    reg.insertMessage(id, "user", "carry on");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines, { prompt: "carry on" }).opts);

    expect(calls[0]!.prompt).toContain("MESSAGE FROM ANOTHER SESSION: Please review the branch.");
    expect(calls[0]!.prompt.endsWith("CURRENT MESSAGE:\ncarry on")).toBe(true);
    expect(calls[0]!.prompt.match(/carry on/g)).toHaveLength(1);
  });

  it("carries the prompt even when it was never logged as a message", async () => {
    const { engines, calls } = scripted(() => answer("ok", "b-thread"));
    const id = newSession();
    reg.insertMessage(id, "user", "an earlier question");
    reg.insertMessage(id, "assistant", "an earlier answer");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines, { prompt: "a scheduled prompt" }).opts);

    expect(calls[0]!.prompt.endsWith("CURRENT MESSAGE:\na scheduled prompt")).toBe(true);
  });
});

describe("what a hop's transcript costs", () => {
  it("stays under the command-line argument limit when the history is large messages from other sessions", async () => {
    const { engines, calls } = scripted(() => answer("ok", "b-thread"));
    const id = newSession();
    for (let i = 0; i < 12; i++) relayFrom(id, `brief ${i} ${"x".repeat(11_000)}`);
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines, { prompt: "carry on" }).opts);

    expect(Buffer.byteLength(calls[0]!.prompt)).toBeLessThan(MAX_ARGUMENT_BYTES / 2);
    // The newest are kept, clipped, and the current message is still last.
    expect(calls[0]!.prompt).toContain("brief 11 ");
    expect(calls[0]!.prompt).not.toContain("brief 0 ");
    expect(calls[0]!.prompt.endsWith("CURRENT MESSAGE:\ncarry on")).toBe(true);
  });

  it("is bounded for a resumed thread's catch-up too", async () => {
    const accountB = `claude:${claudeProfileFromDir(DIR_B).key}`;
    const { engines, calls } = scripted(() => answer("ok", "b-thread"));
    const id = newSession();
    reg.updateSession(id, { engineSessions: { [accountB]: { id: "b-thread", lastSyncedAt: "2020-01-01T00:00:00.000Z" } } } as never);
    for (let i = 0; i < 20; i++) relayFrom(id, `brief ${i} ${"y".repeat(11_000)}`);
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines, { prompt: "carry on" }).opts);

    expect(calls[0]!.resume).toBe("b-thread");
    expect(Buffer.byteLength(calls[0]!.prompt)).toBeLessThan(MAX_ARGUMENT_BYTES / 2);
    expect(calls[0]!.prompt.endsWith("CURRENT MESSAGE:\ncarry on")).toBe(true);
  });
});

describe("which message is the current one", () => {
  it("does not mistake an earlier short message for a prompt that merely contains it", async () => {
    const { engines, calls } = scripted(() => answer("ok", "b-thread"));
    const id = newSession();
    relayFrom(id, "ok");
    reg.insertMessage(id, "assistant", "noted");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines, { prompt: "ok, now run the scheduled check" }).opts);

    expect(calls[0]!.prompt).toContain("MESSAGE FROM ANOTHER SESSION: ok\n");
    expect(calls[0]!.prompt.endsWith("CURRENT MESSAGE:\nok, now run the scheduled check")).toBe(true);
  });

  it("recognises a long reply from a child as the current message when the prompt clips it", async () => {
    const { engines, calls } = scripted(() => answer("ok", "b-thread"));
    const id = newSession();
    const full = `${"R".repeat(12_000)}`;
    reg.insertMessage(id, "assistant", "earlier");
    reg.insertMessage(id, "notification", "📩 reviewer replied", undefined, undefined, undefined, { kind: "child-reply", childSessionId: "child-9", fullMessage: full });
    const prompt = `📩 Employee "reviewer" replied in child session child-9.\n\nReply:\n${full.slice(0, 4_000)}…\n\nTo follow up: send_to_session`;
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines, { prompt }).opts);

    expect(calls[0]!.prompt).not.toContain("MESSAGE FROM ANOTHER SESSION");
    expect(calls[0]!.prompt.endsWith(`CURRENT MESSAGE:\n${prompt}`)).toBe(true);
  });
});

describe("a resumed thread on another account is told of a message from another session it missed", () => {
  it("puts the missed relay in the catch-up transcript", async () => {
    const accountB = `claude:${claudeProfileFromDir(DIR_B).key}`;
    const { engines, calls } = scripted(() => answer("ok", "b-thread"));
    const id = newSession();
    const synced = "2026-10-19T10:00:00.000Z";
    reg.updateSession(id, { engineSessions: { [accountB]: { id: "b-thread", lastSyncedAt: synced } } } as never);
    const db = (await import("../../shared/db.js")).initDb();
    db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)")
      .run("relay-missed", id, "notification", "📨 From requester: an earlier brief", Date.parse("2026-10-19T11:00:00.000Z"), JSON.stringify({ kind: "agent-relay", fromSessionId: "11111111-aaaa", fullMessage: "an earlier brief" }));
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines, { prompt: "carry on" }).opts);

    expect(calls[0]!.resume).toBe("b-thread");
    expect(calls[0]!.prompt).toContain("MESSAGE FROM ANOTHER SESSION: an earlier brief");
    expect(calls[0]!.prompt.endsWith("CURRENT MESSAGE:\ncarry on")).toBe(true);
  });
});
