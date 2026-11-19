import { initDb } from "../shared/db.js";
import { claimSessionDelivery } from "../sessions/registry.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import { clipSessionMessage } from "../gateway/session-comm-guards.js";
import { logger } from "../shared/logger.js";
import type { Heartbeat } from "./types.js";

/**
 * Whether an earlier tick of `heartbeatId` is still waiting: its delivery not yet
 * accepted by the session, or accepted into a queue row that has not started.
 * The fire being delivered now is left out, so a retry of it is never mistaken
 * for a newer one.
 */
function hasUndeliveredWake(heartbeatId: string, currentAttempt: string): boolean {
  return initDb().prepare(`
    SELECT 1
    FROM callback_deliveries d
    LEFT JOIN queue_items q ON q.id = d.queue_item_id
    WHERE d.source_kind = 'heartbeat' AND d.delivery_kind = 'heartbeat'
      AND d.source_id = ? AND d.source_attempt <> ?
      AND (d.status = 'pending' OR (d.status = 'accepted' AND q.status = 'pending'))
    LIMIT 1
  `).get(heartbeatId, currentAttempt) !== undefined;
}

/**
 * Push one heartbeat tick into its owning session through the durable session
 * outbox — the same path parent callbacks use, so heartbeats inherit its retry,
 * dead-lettering and once-only semantics rather than adding a second way to put
 * text into a session.
 *
 * `sourceId` + `sourceAttempt` key the outbox's composite identity index on
 * (heartbeat, fire number), so a tick re-attempted after a failed delivery is a
 * no-op instead of a duplicate wake.
 *
 * The engine-facing `message` is the stored text with nothing composed around
 * it: a heartbeat says what its session told it to say. Only the human-facing
 * banner is clipped, exactly as parent callbacks do.
 */
export function deliverHeartbeat(heartbeat: Heartbeat, fireCount: number): void {
  const sourceAttempt = `fire-${fireCount}`;
  // A session that cannot run (engine out of usage, down) takes no wakes off its
  // queue, so an hourly heartbeat would stack one per interval and replay them
  // all as separate turns once it resumes. The message is the same every time, so
  // one waiting wake says it all: this fire folds into it and books as delivered.
  if (hasUndeliveredWake(heartbeat.id, sourceAttempt)) {
    logger.info(`[heartbeats] Heartbeat ${heartbeat.id} fire ${fireCount} folded into its wake still waiting in session ${heartbeat.ownerSessionId}`);
    return;
  }
  const { delivery } = claimSessionDelivery({
    targetSessionId: heartbeat.ownerSessionId,
    sourceKind: "heartbeat",
    sourceId: heartbeat.id,
    sourceAttempt,
    sourceOutcome: "fired",
    sourceVersion: 1,
    deliveryKind: "heartbeat",
    payload: {
      message: heartbeat.message,
      displayMessage: `⏰ ${clipSessionMessage(heartbeat.message)}`,
    },
  });
  if (delivery.status === "accepted") return;
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(
      `[heartbeats] Failed to deliver heartbeat ${heartbeat.id} to session ${heartbeat.ownerSessionId}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
