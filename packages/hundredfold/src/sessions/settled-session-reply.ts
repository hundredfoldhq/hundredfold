import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";
import { getWorkItem } from "../work-items/store.js";
import { getSession } from "./registry.js";
import { getQueueItem } from "./queue-item-registry.js";
import { parseMetaColumn } from "./message-row.js";
import { asksOrReportsBlocker } from "./stop-nudge.js";

/**
 * A session whose Todo is over is still the parent of the sessions it spawned,
 * and those get reused: another session sends them work, and one of them may
 * report to the spawner after all. The spawner then wakes for a report about a
 * task that is not its own, and ends its turn with "nothing for me". Relaying
 * that to the session above it wakes that one too, to read that nothing happened.
 *
 * So the reply of such a turn stays in the session's own chat. It is a filter
 * that errs toward relaying: the Todo must be over, the message the turn started
 * from must be a child's report, and a reply that asks something or reports a
 * blocker always goes out.
 *
 * What started the turn is recorded when the turn starts, against its attempt,
 * like the requester of the turn (turn-requester.ts): rows written while the
 * turn runs (tool output, a report that lands mid-turn) cannot change it, and a
 * new turn mints a new token so a stale record never outlives its turn.
 */

const TURN_STARTED_BY_CHILD_REPORT_KEY = "turnStartedByChildReport";

/** Whether every message the queue row runs is a child's report to this session.
 *  A callback's row names its message on the delivery (a completion batch runs
 *  several), any other row on itself. */
function isChildReportQueueItem(queueItemId: string): boolean {
  const db = initDb();
  const messageIds = db.prepare("SELECT message_id FROM callback_deliveries WHERE queue_item_id = ?").pluck().all(queueItemId) as Array<string | null>;
  const own = getQueueItem(queueItemId)?.messageId;
  const ids = [...messageIds, ...(messageIds.length === 0 && own ? [own] : [])];
  if (ids.length === 0 || ids.some((id) => !id)) return false;
  return ids.every((id) => {
    const row = db.prepare("SELECT meta FROM messages WHERE id = ?").get(id) as { meta: unknown } | undefined;
    return parseMetaColumn(row?.meta)?.kind === "child-reply";
  });
}

/** A turn is starting in `session` for `queueItemId`: note it when a child's report started it. Never throws. */
export function recordTurnStartedByChildReport(session: Pick<Session, "id" | "attemptToken">, queueItemId: string | undefined): void {
  if (!queueItemId || !session.attemptToken) return;
  try {
    if (!isChildReportQueueItem(queueItemId)) return;
    initDb().prepare(`
      UPDATE sessions
      SET transport_meta = json_set(COALESCE(transport_meta, '{}'), '$.${TURN_STARTED_BY_CHILD_REPORT_KEY}', ?)
      WHERE id = ?
    `).run(session.attemptToken, session.id);
  } catch (error) {
    logger.warn(`[callbacks] Could not note what started session ${session.id}'s turn: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Todo states in which the session's own task is finished. */
const FINISHED_STATUSES = new Set(["in_review", "done", "cancelled"]);

function taskIsFinished(workItemId: string): boolean {
  const status = getWorkItem(workItemId)?.status;
  return !!status && FINISHED_STATUSES.has(status);
}

function turnStartedByChildReport(sessionId: string, attemptToken: string): boolean {
  return getSession(sessionId)?.transportMeta?.[TURN_STARTED_BY_CHILD_REPORT_KEY] === attemptToken;
}

/** Whether `child`'s task is finished and the turn that just settled started
 *  from a report by one of its own children and said nothing that needs acting on. */
export function isSettledSessionReplyToChildReport(
  child: Pick<Session, "id" | "workItemId" | "attemptToken">,
  reply: string | null | undefined,
): boolean {
  const text = reply?.trim();
  const { workItemId, attemptToken } = child;
  if (!text || !workItemId || !attemptToken || asksOrReportsBlocker(text)) return false;
  try {
    return taskIsFinished(workItemId) && turnStartedByChildReport(child.id, attemptToken);
  } catch (error) {
    // Fail-safe: any doubt relays, which only costs the parent a wake.
    logger.warn(`[callbacks] Could not judge whether session ${child.id}'s reply answers a child's report; relaying it: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
