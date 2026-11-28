import type { ApiContext } from "./api.js";
import type { Session } from "../shared/types.js";
import { announceRemovedMessages } from "./announce-withdrawn.js";
import { logger } from "../shared/logger.js";
import { maybeRevertEngineOverride } from "../sessions/manager.js";
import { runtimeSessionSource } from "../sessions/context.js";
import {
  type QueueItem, coalescePendingParentCompletionQueueItems, listAllPendingQueueItems, getSession,
  cancelQueueItem, listReleasableParentCompletionQueuesForSource,
  getSessionDeliveryByQueueItemId, shouldHoldParentCompletionQueueDispatch, updateSession,
} from "../sessions/registry.js";
import { dispatchWebSessionRun } from "./web-session-dispatch.js";
import { isStoppedByUser } from "../sessions/stopped-marker.js";
import { withdrawPendingQueueItemsForStop } from "../sessions/queue-stop.js";
import { staleChildWatchWakeReason } from "../heartbeats/child-watch.js";
import { retireStaleLateralNotice } from "../sessions/lateral-notice-staleness.js";

/** Why a queued wake (a child-watch tick, an undelivered-messages notice) has nothing left to say, else null. A stale notice is retired as it is found. */
function staleQueuedWake(queueItemId: string, session: Session, context: ApiContext): string | null {
  const childWatch = staleChildWatchWakeReason(queueItemId);
  if (childWatch) return childWatch;
  const notice = retireStaleLateralNotice(queueItemId);
  if (!notice) return null;
  announceRemovedMessages(context, session, notice.removedMessageIds);
  return notice.reason;
}

export function resumePendingWebQueueItems(context: ApiContext): void {
  coalescePendingParentCompletionQueueItems();
  const pending = listAllPendingQueueItems();
  if (pending.length === 0) return;

  let resumed = 0;
  for (const item of pending) {
    if (resumePendingQueueItem(item, context)) resumed++;
  }

  if (resumed > 0) {
    logger.info(`Re-dispatched ${resumed} pending web queue item(s) after gateway restart`);
  }
}

/** The session a replayed row may run on: not a deleted one, and not one stopped
 *  on purpose, since a replay is never a deliberate start. */
function replayableSession(sessionId: string) {
  const session = getSession(sessionId);
  return session && !isStoppedByUser(session) ? session : undefined;
}

/** Drop a row nothing may run: every row a stopped session still holds (one that
 *  raced the stop), or the row of a deleted session. Then let any parent batch
 *  held behind it go on. */
function dropUnreplayableRow(item: QueueItem, context: ApiContext): void {
  const session = getSession(item.sessionId);
  if (session) {
    // A notice withdrawn here never ran: its bubble goes, and its claim is released by the next report.
    const { removedNoticeMessageIds } = withdrawPendingQueueItemsForStop(session.id);
    if (removedNoticeMessageIds.length > 0) announceRemovedMessages(context, session, removedNoticeMessageIds);
  } else cancelQueueItem(item.id);
  for (const held of listReleasableParentCompletionQueuesForSource(item.sessionId)) {
    context.sessionManager.getQueue().releaseCallbackDrain(held.sessionKey, held.queueItemId);
  }
}

export function resumePendingQueueItem(item: QueueItem, context: ApiContext): boolean {
  let session = replayableSession(item.sessionId);
  if (!session) {
    dropUnreplayableRow(item, context);
    return false;
  }
  // Ordinary non-web queue ownership remains connector-specific. Callback
  // receipts are the exception: acceptance already committed this internal
  // turn, so startup replay must finish it regardless of the parent's source.
  const callbackDelivery = getSessionDeliveryByQueueItemId(item.id);
  if (runtimeSessionSource(session.source) !== "web" && !callbackDelivery) return false;
  if (callbackDelivery && shouldHoldParentCompletionQueueDispatch(item.id)) {
    context.sessionManager.getQueue().holdForCallbackDrain(item.sessionKey, item.id);
  }
  // Hot-reload calls this too: a row waiting its turn here is owned, not orphaned.
  if (context.sessionManager.getQueue().hasInFlightItem(item.id)) return false;
  // A child-watch wake that went stale while the gateway was down is dropped
  // here, before the session is marked running for a turn that will not happen.
  // A row the live queue already owns is judged when its turn starts instead.
  const staleWake = staleQueuedWake(item.id, session, context);
  if (staleWake) {
    cancelQueueItem(item.id);
    logger.info(`Dropped stale wake ${item.id} for session ${session.id} on replay: ${staleWake}`);
    return false;
  }
  session = maybeRevertEngineOverride(session, undefined, context.getConfig());

  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine) {
    const diagnostic = `Engine "${session.engine}" not available`;
    if (callbackDelivery) {
      // Acceptance committed this exact queue row as part of the callback
      // outbox. Engine availability is transient operational state, not a
      // reason to destroy that accepted intent. Keep the row pending so a
      // later config/engine reload can replay the same durable ID.
      updateSession(session.id, { lastActivity: new Date().toISOString(), lastError: diagnostic });
      logger.warn(`Deferred accepted callback queue ${item.id}: ${diagnostic}`);
    } else {
      cancelQueueItem(item.id);
      updateSession(session.id, { status: "error", lastActivity: new Date().toISOString(), lastError: diagnostic });
    }
    return false;
  }

  // Ensure the session is in a runnable state
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });

  dispatchWebSessionRun(session, item.prompt, engine, context, { queueItemId: item.id });
  return true;
}
