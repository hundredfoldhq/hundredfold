// What a stop does to the messages parked behind a session's turn. Split out of
// `queue-item-registry.ts`, which owns the rows and is at its size limit.
import { initDb } from "../shared/db.js";
import {
  cancelQueueItem, listPendingQueueItemIdsForSession, markRunningQueueItemsCompletedForSession, withdrawPendingQueueItem, type QueueItem,
} from "./queue-item-registry.js";
import { getSessionDeliveryByQueueItemId } from "./registry.js";
import { removeUnrunNoticeBubbles } from "./lateral-notice-staleness.js";

/**
 * Withdraw every message still parked for `sessionId`, bubbles and all, so that
 * nothing started by a later restart, config reload or slot claim can run it.
 * The in-memory lane is only a view of these rows: leaving one `pending` after a
 * stop is what let a replay wake the session again.
 *
 * A row an accepted callback or Todo delivery owns is cancelled too, so that a
 * replay cannot start it, but its message stays in the transcript: it is a
 * report the session was given, not a bubble nobody saw run.
 *
 * The row of the turn being killed is retired as well. It stays `running` until
 * the killed turn's lane settles, and a restart in that window would put it back
 * to `pending` and replay the stopped turn's own prompt.
 *
 * The exception is an undelivered-messages notice: it was never given to the
 * session, so its bubble goes with its row (and its outbox claim is released
 * by the next report, which sees the row cancelled).
 *
 * Returns the rows withdrawn with their bubbles, as read inside the transaction,
 * how many delivery-owned rows were cancelled, and the ids of the notice bubbles removed.
 */
export function withdrawPendingQueueItemsForStop(sessionId: string): { withdrawn: QueueItem[]; cancelledDeliveries: number; removedNoticeMessageIds: string[] } {
  return initDb().transaction(() => {
    const withdrawn: QueueItem[] = [];
    let cancelledDeliveries = 0;
    const removedNoticeMessageIds: string[] = [];
    for (const itemId of listPendingQueueItemIdsForSession(sessionId)) {
      if (getSessionDeliveryByQueueItemId(itemId)) {
        if (cancelQueueItem(itemId)) {
          cancelledDeliveries++;
          removedNoticeMessageIds.push(...removeUnrunNoticeBubbles(itemId));
        }
        continue;
      }
      const item = withdrawPendingQueueItem(itemId);
      if (item) withdrawn.push(item);
    }
    markRunningQueueItemsCompletedForSession(sessionId);
    return { withdrawn, cancelledDeliveries, removedNoticeMessageIds };
  }).immediate();
}
