import { describe, expect, it } from "vitest";
import { ACCOUNT_A, CLAUDE_B, DIR_B, answer, limited, who, claudeProfileFromDir, employee, handleRateLimit, limitedTurn, newSession, reg, scripted, useWalkHarness } from "./fallback-walk-harness.js";
import { claimIncomingTurn, lateralSendDedupeKey } from "../incoming-turn.js";
import { resolveSyncPrompt } from "../turn/preflight.js";

/**
 * A message from another session (send_to_session, a child's callback) is stored
 * in the transcript as a `notification` row that carries only its banner; the
 * engine is sent the full text. A hop to another account or engine rebuilds the
 * conversation from the transcript, so a relayed message has to survive that
 * rebuild: as the turn's own message, and as part of what a thread missed.
 */

useWalkHarness();

const SENDER = "sender-session";

/** The engine-facing text of a relayed message, as the message route builds it. */
function relayPrompt(body: string): string {
  return `📨 Message from session ${SENDER} (reviewer):\n\n${body}\n\nTo reply: send_to_session { sessionId: "${SENDER}" }.`;
}

/** Accept a relayed message for `id` the way the message route does: a queue row, and a banner in the transcript. */
function relay(id: string, body: string, supersedes?: string) {
  return claimIncomingTurn({
    sessionId: id,
    sessionKey: reg.getSession(id)!.sessionKey || reg.getSession(id)!.sourceRef,
    prompt: relayPrompt(body),
    isNotification: true,
    role: "notification",
    content: `📨 From reviewer: ${body.slice(0, 40)}`,
    meta: { kind: "agent-relay", fromSessionId: SENDER, fromLabel: "reviewer", hops: 1, maxHops: 4, fullMessage: body },
    dedupeKey: lateralSendDedupeKey(SENDER, id, body),
    ...(supersedes ? { supersedes: { callerSessionId: SENDER, queueItemId: supersedes } } : {}),
  });
}

describe("a relayed message that is the turn a limit interrupts", () => {
  it("is sent in full to an account with no thread, as the message to answer", async () => {
    const { engines, calls } = scripted(() => answer("on B", "b-thread"));
    const id = newSession();
    reg.insertMessage(id, "user", "review the change");
    reg.insertMessage(id, "assistant", "round one done, waiting for round two");
    const body = "Round two is ready: re-review the head commit, only the delta since round one.";
    relay(id, body);

    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines, { prompt: relayPrompt(body) }).opts);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.resume).toBeUndefined();
    expect(calls[0]!.prompt).toContain("ASSISTANT: round one done, waiting for round two");
    expect(calls[0]!.prompt.endsWith(`CURRENT MESSAGE:\n${relayPrompt(body)}`)).toBe(true);
    // Asked once: the banner the transcript holds for it is not repeated in front of it.
    expect(calls[0]!.prompt.match(/Round two is ready/g)).toHaveLength(1);
    // The hop's own notice, written to the transcript as the hop starts, is the gateway's, not the conversation's.
    expect(calls[0]!.prompt).not.toContain("usage limit reached");
  });

  it("leaves only the replacement when a superseding send replaced an earlier one", async () => {
    const { engines, calls } = scripted(() => answer("on B", "b-thread"));
    const id = newSession();
    reg.insertMessage(id, "user", "plan the migration");
    const first = relay(id, "Decision: keep the old schema for now.");
    const replacement = "Decision: migrate to the new schema today.";
    const second = relay(id, replacement, first.queueItemId);
    expect(second).toMatchObject({ deduplicated: false, superseded: { outcome: "withdrawn" } });

    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines, { prompt: relayPrompt(replacement) }).opts);

    expect(calls[0]!.prompt).not.toContain("keep the old schema");
    expect(calls[0]!.prompt.endsWith(`CURRENT MESSAGE:\n${relayPrompt(replacement)}`)).toBe(true);
    expect(calls[0]!.prompt.match(/migrate to the new schema/g)).toHaveLength(1);
    expect(calls[0]!.prompt).not.toContain("usage limit reached");
  });

  it("keeps an operator's own message asked once, as the transcript's last line already is it", async () => {
    const { engines, calls } = scripted(() => answer("on B", "b-thread"));
    const id = newSession();
    reg.insertMessage(id, "user", "draft the release notes");
    reg.insertMessage(id, "assistant", "drafted on A");
    reg.insertMessage(id, "user", "now publish them");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines).opts);

    expect(calls[0]!.prompt.match(/now publish them/g)).toHaveLength(1);
    expect(calls[0]!.prompt).not.toContain("usage limit reached");
  });

  it("is sent bare on a model hop that resumes the same thread, past the hop's own notice", async () => {
    const { engines, calls } = scripted((call) => (who(call) === "A/sonnet" ? answer("on A sonnet", "a-thread") : limited()));
    const id = newSession();
    const db = (await import("../../shared/db.js")).initDb();
    const insertAt = (role: string, content: string, at: number) => db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(`${role}-${at}`, id, role, content, at);
    insertAt("user", "review the change", Date.now() - 120_000);
    insertAt("assistant", "round one done", Date.now() - 90_000);
    // A's thread answered round one and is up to date to here; what follows is the relayed message and the hop's notice.
    reg.updateSession(id, { engineSessions: { [ACCOUNT_A]: { id: "a-thread", lastSyncedAt: new Date(Date.now() - 60_000).toISOString() } } } as never);
    const body = "Round two is ready: re-review the head commit.";
    relay(id, body);

    await handleRateLimit(limitedTurn(id, employee({ fallback: [{ engine: "claude", profile: "A", model: "sonnet" }] }), engines, { prompt: relayPrompt(body) }).opts);

    expect(calls).toEqual([{ engine: "claude", profileDir: expect.any(String), model: "sonnet", resume: "a-thread", prompt: relayPrompt(body) }]);
  });
});

describe("a relayed message a thread missed", () => {
  it("is in what a resumed account's thread is told it missed, with its full text", async () => {
    const accountB = `claude:${claudeProfileFromDir(DIR_B).key}`;
    const { engines, calls } = scripted(() => answer("on B", "b-thread"));
    const id = newSession();
    const synced = "2026-10-19T10:00:00.000Z";
    reg.updateSession(id, { engineSessions: { [ACCOUNT_A]: { id: "a-thread" }, [accountB]: { id: "b-thread", lastSyncedAt: synced } } } as never);
    const db = (await import("../../shared/db.js")).initDb();
    const body = "Decision: ship the smaller change first, then the migration.";
    db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)").run(
      "relay-1", id, "notification", "📨 From coordinator: Decision: ship the smaller…", Date.parse("2026-10-19T11:00:00.000Z"),
      JSON.stringify({ kind: "agent-relay", fromSessionId: SENDER, fromLabel: "coordinator", fullMessage: body }),
    );
    db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
      "answer-1", id, "assistant", "understood, starting with the smaller change", Date.parse("2026-10-19T11:30:00.000Z"),
    );
    db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
      "user-1", id, "user", "now publish them", Date.parse("2026-10-19T12:00:00.000Z"),
    );

    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines).opts);

    expect(calls[0]!.resume).toBe("b-thread");
    expect(calls[0]!.prompt).toContain(`MESSAGE FROM ANOTHER SESSION: ${body}`);
    expect(calls[0]!.prompt).toContain("ASSISTANT: understood, starting with the smaller change");
  });

  it("is in the catch-up a session gets when it comes back to its own account", () => {
    const id = newSession();
    const body = "Round two is ready: re-review the head commit.";
    const swappedAt = Date.now() - 60_000;
    const row = reg.getSession(id)!;
    reg.updateSession(id, { transportMeta: { ...(row.transportMeta ?? {}), claudeSyncSince: new Date(swappedAt).toISOString(), claudeSyncAccount: true } } as never);
    relay(id, body);
    reg.insertMessage(id, "assistant", "round two started on the stand-in account");

    const { promptToRun, syncRequested } = resolveSyncPrompt(reg.getSession(id)!, "claude", "carry on");

    expect(syncRequested).toBe(true);
    expect(promptToRun).toContain(`MESSAGE FROM ANOTHER SESSION: ${body}`);
    expect(promptToRun).toContain("ASSISTANT: round two started on the stand-in account");
  });
});
