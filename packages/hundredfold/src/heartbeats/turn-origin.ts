import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";

/**
 * Turns a heartbeat started, and the reply that says such a turn found nothing.
 *
 * A heartbeat wakes a session to look at something. Most of the time nothing
 * has moved, and the session says so. That reply is the session's own business:
 * relayed to the session it reports to, it wakes that one as well, every tick,
 * to read "no change". A session cannot end a turn with no text, so it marks the
 * quiet result instead, by replying with {@link HEARTBEAT_NO_CHANGE_REPLY}, and
 * the gateway keeps that reply in the session's own chat.
 *
 * The token counts only on a turn a heartbeat started, so the same word in an
 * answer to a person or to the parent is relayed as usual.
 */
export const HEARTBEAT_NO_CHANGE_REPLY = "NO_CHANGE";

const META_KEY = "heartbeatTurnAttempt";
const NO_CHANGE = new RegExp(`^[\\s*_\`"'>.-]*${HEARTBEAT_NO_CHANGE_REPLY}\\b`);

/** Whether a queue row is a heartbeat tick and nothing else. */
export function isHeartbeatQueueItem(queueItemId: string | undefined): boolean {
  if (!queueItemId) return false;
  const kinds = initDb()
    .prepare("SELECT delivery_kind FROM callback_deliveries WHERE queue_item_id = ?")
    .pluck()
    .all(queueItemId) as string[];
  return kinds.length > 0 && kinds.every((kind) => kind === "heartbeat");
}

/** Record that the attempt now starting runs a heartbeat tick. Per attempt, so
 *  the next turn, with its own token, is not one. Never throws. */
export function markHeartbeatTurn(sessionId: string, attemptToken: string): void {
  try {
    initDb().prepare(`
      UPDATE sessions SET transport_meta = json_set(COALESCE(transport_meta, '{}'), '$.${META_KEY}', ?)
      WHERE id = ?
    `).run(attemptToken, sessionId);
  } catch (error) {
    logger.warn(`[heartbeats] could not mark session ${sessionId}'s turn as a heartbeat turn: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Whether `session`'s current attempt is a turn a heartbeat started. */
export function isHeartbeatTurn(session: Pick<Session, "attemptToken" | "transportMeta">): boolean {
  return !!session.attemptToken && session.transportMeta?.[META_KEY] === session.attemptToken;
}

/** Whether `text` is the no-change reply: the token leads it, bare or in light markdown. */
export function isNoChangeReply(text: string | null | undefined): boolean {
  return NO_CHANGE.test(text ?? "");
}
