import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import { parseDispatchPayload } from "./queue-dispatch.js";

/** The outbox kind of the notice that tells a sender its messages have not been delivered. */
export const LATERAL_STALL_DELIVERY_KIND = "lateral-send-stalled";

/** Every message id a notice named, waiting or dropped, from its stored payload. */
function reportedIdsOf(payload: string): Set<string> | null {
  try {
    const ids = (JSON.parse(payload) as { meta?: { queueItemIds?: unknown } }).meta?.queueItemIds;
    return Array.isArray(ids) ? new Set(ids.filter((id): id is string => typeof id === "string")) : null;
  } catch {
    return null;
  }
}

/** The message ids a notice reported as still waiting (queued or unowned), from its stored payload. */
function waitingIdsOf(payload: string): { waiting: string[]; dropped: number } | null {
  try {
    const meta = (JSON.parse(payload) as { meta?: { waitingQueueItemIds?: unknown; queueItemIds?: unknown } }).meta;
    const waiting = Array.isArray(meta?.waitingQueueItemIds) ? meta.waitingQueueItemIds.filter((id): id is string => typeof id === "string") : null;
    const all = Array.isArray(meta?.queueItemIds) ? meta.queueItemIds.length : 0;
    return waiting ? { waiting, dropped: all - waiting.length } : null;
  } catch {
    return null;
  }
}

/**
 * Why the undelivered-messages notice parked on queue row `queueItemId` should
 * not run now, else null.
 *
 * The notice is judged when the watch sends it, but its recipient may be in a
 * turn of its own, and by the time the notice's turn comes every message it
 * named may have run or been withdrawn. A turn spent reading "still queued"
 * about messages already delivered is worse than none: the sender acts on it.
 * So the dispatch asks again just before it starts the turn.
 *
 * Only a row that carries nothing but such notices is judged, and only on the
 * messages each reported as waiting: a dropped message stays news, and a row
 * that also carries a child's report or a folded message is never dropped.
 */
export function staleLateralNoticeReason(queueItemId: string | undefined): string | null {
  if (!queueItemId) return null;
  try {
    const ids = waitingIdsOfNoticeRow(queueItemId);
    if (!ids) return null;
    const pending = initDb().prepare(`SELECT COUNT(*) FROM queue_items WHERE status = 'pending' AND id IN (${ids.map(() => "?").join(", ")})`)
      .pluck().get(...ids) as number;
    return pending === 0 ? "every message it reported as waiting has since run or been withdrawn" : null;
  } catch (error) {
    // Never block a turn on a failed look-up: a notice that runs for nothing is the cheaper mistake.
    logger.warn(`[lateral-watch] could not judge queued notice ${queueItemId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Marks a notice's outbox identity as given up: nothing claims it again. */
const RETIRED_SUFFIX = ":retired:";

/**
 * Give up the outbox claim of the notice(s) matching `where`. The claim's
 * identity is the target's state, and one left standing silences the report of
 * a message still stuck behind that same state. The row stays, under an
 * identity nothing claims again. Idempotent.
 */
function retireClaims(where: string, ...params: unknown[]): number {
  return initDb().prepare(
    `UPDATE callback_deliveries SET source_attempt = source_attempt || '${RETIRED_SUFFIX}' || id
     WHERE delivery_kind = ? AND source_attempt NOT LIKE '%${RETIRED_SUFFIX}%' AND ${where}`,
  ).run(LATERAL_STALL_DELIVERY_KIND, ...params).changes;
}

/**
 * Remove the bubbles of the notice(s) parked on `queueItemId`, and return their
 * ids so every view can drop them. A notice that never ran was never given to
 * its sender; left in the transcript it reads exactly like one that was, which
 * is how a dropped notice came to sit beside a delivered one with the same words.
 * The delivery keeps its row and its `messageId`, which no longer names a message.
 */
export function removeUnrunNoticeBubbles(queueItemId: string): string[] {
  const db = initDb();
  return db.transaction(() => {
    const ids = db.prepare("SELECT message_id FROM callback_deliveries WHERE queue_item_id = ? AND delivery_kind = ? AND message_id IS NOT NULL")
      .pluck().all(queueItemId, LATERAL_STALL_DELIVERY_KIND) as string[];
    const drop = db.prepare("DELETE FROM messages WHERE id = ?");
    return ids.filter((id) => drop.run(id).changes > 0);
  }).immediate();
}

/**
 * Drop the notice parked on `queueItemId` if it is stale, and say why; null
 * when it is not. Its outbox claim is retired with it, and its bubble removed
 * (the ids come back for the caller to announce).
 */
export function retireStaleLateralNotice(queueItemId: string | undefined): { reason: string; removedMessageIds: string[] } | null {
  const reason = staleLateralNoticeReason(queueItemId);
  if (!reason || !queueItemId) return null;
  retireClaims("queue_item_id = ?", queueItemId);
  return { reason, removedMessageIds: removeUnrunNoticeBubbles(queueItemId) };
}

/**
 * Release the claims of the notices to `callerSessionId` about `targetSessionId`
 * that closed without running. A notice is claimed per target state, and a claim
 * held by one that never ran would silence that state for good. Two closes
 * release: a notice accepted onto a row that was cancelled (its sender stopped,
 * or the row could not be replayed), and a dead-lettered notice when a message
 * it did not name is now waiting (`waitingIds`, every message the sender has
 * waiting on the target). A notice that ran, or is still pending, keeps its claim.
 * Read at the point of the next report, so every way a notice can close is
 * covered, not only the ones that remember to say so.
 *
 * A dead-lettered notice is not released for the same messages: a sender that
 * keeps refusing its notices must not be handed a fresh one, to be dead-lettered
 * in turn, on every sweep. Only news (a message it was never told about) is
 * worth another try.
 */
export function retireClosedLateralNotices(callerSessionId: string, targetSessionId: string, waitingIds: readonly string[]): number {
  const db = initDb();
  let released = retireClaims(
    `target_session_id = ? AND source_id = ? AND status = 'accepted'
       AND EXISTS (SELECT 1 FROM queue_items WHERE queue_items.id = callback_deliveries.queue_item_id AND queue_items.status = 'cancelled')`,
    callerSessionId, targetSessionId,
  );
  const deadLettered = db.prepare(
    `SELECT id, payload FROM callback_deliveries
     WHERE delivery_kind = ? AND target_session_id = ? AND source_id = ? AND status = 'dead_letter' AND source_attempt NOT LIKE '%${RETIRED_SUFFIX}%'`,
  ).all(LATERAL_STALL_DELIVERY_KIND, callerSessionId, targetSessionId) as Array<{ id: string; payload: string }>;
  for (const row of deadLettered) {
    const told = reportedIdsOf(row.payload);
    // A payload that cannot be read is not released: better silent than a notice on every sweep.
    if (told && waitingIds.some((id) => !told.has(id))) released += retireClaims("id = ?", row.id);
  }
  return released;
}

/** The ids the row's notices reported as waiting, or null when the row is not one to judge: it carries anything else, or a notice with a dropped message. */
function waitingIdsOfNoticeRow(queueItemId: string): string[] | null {
  const db = initDb();
  const deliveries = db.prepare("SELECT delivery_kind AS kind, payload FROM callback_deliveries WHERE queue_item_id = ?")
    .all(queueItemId) as Array<{ kind: string; payload: string }>;
  if (deliveries.length === 0 || deliveries.some((delivery) => delivery.kind !== LATERAL_STALL_DELIVERY_KIND)) return null;
  const row = db.prepare("SELECT dispatch_payload FROM queue_items WHERE id = ?").get(queueItemId) as { dispatch_payload: string | null } | undefined;
  if ((parseDispatchPayload(row?.dispatch_payload ?? null)?.foldedMessageIds?.length ?? 0) > 0) return null;
  const reported = deliveries.map((delivery) => waitingIdsOf(delivery.payload));
  if (reported.some((ids) => !ids || ids.dropped > 0 || ids.waiting.length === 0)) return null;
  return reported.flatMap((entry) => entry!.waiting);
}
