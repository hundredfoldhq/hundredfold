import { initDb } from "../shared/db.js";
import { getSession } from "./registry.js";
import { getQueueItem } from "./queue-item-registry.js";
import { reportingParentSessionId, reportsUpTo } from "../work-items/employee-session-delegation.js";
import type { Session } from "../shared/types.js";

/**
 * Who a session's end-of-turn notice goes to when another session asked for the
 * turn.
 *
 * A spawned session answers to the session that spawned it, but it is also
 * reused: other sessions `send_to_session` it for unrelated work. The reply to
 * such a turn is owed to whoever sent the message, and waking the spawner for it
 * costs the spawner a full engine turn to learn nothing. So when a turn starts
 * from a message another session sent, the sender is recorded against that
 * attempt, and the turn's notices go there instead of to the spawner.
 *
 * Recorded per attempt, like the "reported to parent" marker: a new turn mints a
 * new token, so a stale record never outlives its turn and nothing has to clear it.
 */

const TURN_REQUESTER_KEY = "turnRequester";

type NoticeSession = Pick<Session, "id" | "employee" | "workItemId" | "parentSessionId" | "attemptToken" | "transportMeta">;

/** The session whose message the turn starting from `queueItemId` answers, if a
 *  session sent it. Reads the sender off the relay the queue item will run. */
function senderOfQueuedMessage(queueItemId: string): string | undefined {
  const messageId = getQueueItem(queueItemId)?.messageId;
  if (!messageId) return undefined;
  const row = initDb().prepare("SELECT meta FROM messages WHERE id = ?").get(messageId) as { meta: string | null } | undefined;
  if (!row?.meta) return undefined;
  try {
    const meta = JSON.parse(row.meta) as { kind?: unknown; fromSessionId?: unknown };
    return meta.kind === "agent-relay" && typeof meta.fromSessionId === "string" && meta.fromSessionId ? meta.fromSessionId : undefined;
  } catch {
    return undefined;
  }
}

/** A turn is starting in `session` for `queueItemId`. If a session sent the
 *  message it runs, that session is who the turn's notices go to. */
export function recordTurnRequester(session: Pick<Session, "id" | "attemptToken">, queueItemId: string | undefined): void {
  if (!queueItemId || !session.attemptToken) return;
  const requester = senderOfQueuedMessage(queueItemId);
  if (!requester) return;
  initDb().prepare(`
    UPDATE sessions
    SET transport_meta = json_set(COALESCE(transport_meta, '{}'), '$.${TURN_REQUESTER_KEY}', json(?))
    WHERE id = ?
  `).run(JSON.stringify({ attempt: session.attemptToken, sessionId: requester }), session.id);
}

function requesterOfAttempt(session: NoticeSession): string | undefined {
  // The record is read fresh, but judged against the attempt of the session as
  // given: a notice for a turn that has ended must not pick up a newer turn's.
  const fresh = getSession(session.id) ?? session;
  const record = fresh.transportMeta?.[TURN_REQUESTER_KEY] as { attempt?: unknown; sessionId?: unknown } | null | undefined;
  if (!record || record.attempt !== (session.attemptToken ?? fresh.attemptToken)) return undefined;
  return typeof record.sessionId === "string" ? record.sessionId : undefined;
}

/**
 * The session this session's current turn reports to: whoever sent the message
 * the turn answers, when that is a live session off to the side, otherwise the
 * session it reports to anyway (`reportingParentSessionId`). Null means nobody
 * is waiting on it, and a session that reports to nobody keeps it so.
 *
 * A requester that is the session itself, or that reports back up to it (its own
 * child asking something of it), is not one to report to: those turns keep
 * reporting to the usual parent.
 */
export function noticeTargetSessionId(session: NoticeSession): string | null {
  const parent = reportingParentSessionId(session);
  // A session nobody is waiting on stays that way: the requester replaces who
  // hears about a turn, it never adds a listener (two peers answering each other
  // would otherwise wake one another for ever).
  if (!parent) return parent;
  const requester = requesterOfAttempt(session);
  if (!requester || requester === parent) return parent;
  if (requester === session.id || !getSession(requester) || reportsUpTo(requester, session.id)) return parent;
  return requester;
}

/** The same session with its notices pointed where they now go. */
export function withNoticeTarget<T extends NoticeSession>(session: T): T {
  const parentSessionId = noticeTargetSessionId(session);
  return parentSessionId === (session.parentSessionId ?? null) ? session : { ...session, parentSessionId };
}
