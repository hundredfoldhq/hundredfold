import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import { parseDispatchPayload } from "./queue-dispatch.js";

/** The outbox kind of the notice that tells a sender its messages have not been delivered. */
export const LATERAL_STALL_DELIVERY_KIND = "lateral-send-stalled";

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

/**
 * Drop the notice parked on `queueItemId` if it is stale, and say why; null
 * when it is not. Its outbox claim is retired with it: the claim's identity is
 * the target's state, and a claim left standing would silence the report of a
 * message still stuck behind that same state (one sent in place of a
 * withdrawn one, say). The row stays, under an identity nothing claims again.
 */
export function retireStaleLateralNotice(queueItemId: string | undefined): string | null {
  const reason = staleLateralNoticeReason(queueItemId);
  if (!reason) return null;
  initDb().prepare("UPDATE callback_deliveries SET source_attempt = source_attempt || ':retired:' || id WHERE queue_item_id = ? AND delivery_kind = ?")
    .run(queueItemId, LATERAL_STALL_DELIVERY_KIND);
  return reason;
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
