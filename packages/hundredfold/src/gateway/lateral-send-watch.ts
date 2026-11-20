import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import type { SessionDeliveryPayload } from "../shared/types.js";
import { claimSessionDelivery, getQueueItem, getSession } from "../sessions/registry.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import { parseLateralSendKey } from "../sessions/queued-send-supersede.js";
import type { ApiContext } from "./api.js";
import { resumePendingQueueItem } from "./callback-queue-recovery.js";

/**
 * Watching an agent-to-agent message that was accepted but has not run.
 *
 * `send_to_session` answers "queued" the moment the row is stored, and from then
 * on only the target's lane can start it. When a message sits `pending` past a
 * bounded time, one of two things is true, and the sender must not be left
 * guessing which:
 *
 * - **Nothing owns the row.** The process holds no dispatch for it (a dispatch
 *   that was lost, as a restart or a hot-reload can leave one), so it would wait
 *   forever. It is dispatched again, in the order the lane keeps.
 * - **The row is owned but the lane has not reached it** (a long turn, or a
 *   session waiting out a usage limit). The sender is told once, with the
 *   target's state and how to replace or withdraw the message, instead of
 *   waiting on a reply that cannot come.
 *
 * Scope: only a session this gateway runs itself can be dispatched again. A
 * row that is unowned and cannot be (a connector-owned session, as at boot
 * replay) stays pending, and its sender is told so rather than promised a run.
 * A row the re-dispatch had to drop (stopped or deleted target, engine
 * unavailable) is reported as dropped, not as waiting.
 */

/** How long an accepted message may sit before the watch acts on it. */
export const LATERAL_STALL_AFTER_MS = 5 * 60_000;
export const LATERAL_SWEEP_MS = 60_000;
export const LATERAL_STALL_DELIVERY_KIND = "lateral-send-stalled";

/** What became of the row: still owned by the lane, left with nothing to run it, or dropped. */
export type StalledSendState = "queued" | "unowned" | "dropped";

interface PendingSend {
  id: string;
  sessionId: string;
  sessionKey: string;
  dedupeKey: string;
  createdAt: string;
}

/** The agent-to-agent rows that have waited longer than `afterMs`, oldest first. */
function stalledSends(now: number, afterMs: number): PendingSend[] {
  const cutoff = new Date(now - afterMs).toISOString();
  return initDb().prepare(
    `SELECT id, session_id AS sessionId, session_key AS sessionKey, dedupe_key AS dedupeKey, created_at AS createdAt
     FROM queue_items
     WHERE status = 'pending' AND dedupe_key LIKE 'lateral:%' AND created_at <= ?
     ORDER BY created_at ASC, rowid ASC`,
  ).all(cutoff) as PendingSend[];
}

function minutesSince(iso: string, now: number): number {
  return Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));
}

/** What the sender is told: where its message is and what it can do about it. */
export function stalledSendPayload(input: {
  queueItemId: string;
  targetSessionId: string;
  waitedMinutes: number;
  targetStatus: string;
  targetNote?: string | null;
  laneRunning: boolean;
  state?: StalledSendState;
}): SessionDeliveryPayload {
  const { queueItemId, targetSessionId, waitedMinutes, targetStatus, targetNote, laneRunning, state: rowState = "queued" } = input;
  const state = laneRunning
    ? `it is still working through an earlier turn (status ${targetStatus})`
    : `it has no turn running (status ${targetStatus})`;
  const note = targetNote?.trim() ? ` Its last error: ${targetNote.trim().slice(0, 200)}.` : "";
  const head = `Your message ${queueItemId} to session ${targetSessionId} has not been delivered after ${waitedMinutes} minutes: ${state}.${note} `;
  const replace = "To change what the session receives, send again with `supersedes` set to this id, "
    + "or message another employee if the work cannot wait.";
  const tail = rowState === "dropped"
    ? "The message was dropped and will not run: the session cannot run it as it stands. Read the session to see why, then send it again if it is still needed. "
    : rowState === "unowned"
      ? "It is still stored but nothing in this gateway is running it, and it will not run by itself. Read the session to see where it stands. "
        + "Send it again (with `supersedes` set to this id), or message another employee if the work cannot wait."
      : "It is still queued and will run in order once the session reaches it. Read the session to see where it stands. " + replace;
  const message = head + tail;
  return {
    message,
    displayMessage: `Message ${queueItemId.slice(0, 8)} to ${targetSessionId.slice(0, 8)} ${rowState === "dropped" ? "dropped" : "undelivered"} after ${waitedMinutes} min`,
    meta: { kind: LATERAL_STALL_DELIVERY_KIND, queueItemId, targetSessionId, state: rowState },
  };
}

/** Tell the sender, once per message: the outbox key makes a second sweep a no-op. */
function reportStalledSend(send: PendingSend, rowState: StalledSendState, context: ApiContext, now: number): boolean {
  const key = parseLateralSendKey(send.dedupeKey);
  const target = getSession(send.sessionId);
  if (!key || !target || !getSession(key.callerSessionId)) return false;
  const { delivery, claimed } = claimSessionDelivery({
    targetSessionId: key.callerSessionId,
    sourceKind: "session",
    sourceId: send.id,
    sourceAttempt: LATERAL_STALL_DELIVERY_KIND,
    sourceOutcome: "stalled",
    sourceVersion: 1,
    deliveryKind: LATERAL_STALL_DELIVERY_KIND,
    payload: stalledSendPayload({
      queueItemId: send.id,
      targetSessionId: send.sessionId,
      waitedMinutes: minutesSince(send.createdAt, now),
      targetStatus: target.status,
      targetNote: target.lastError,
      laneRunning: context.sessionManager.getQueue().isRunning(send.sessionKey),
      state: rowState,
    }),
  });
  if (!claimed) return false;
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(`[lateral-watch] Notice ${delivery.id} to session ${key.callerSessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return true;
}

export interface LateralSweepResult {
  rearmed: string[];
  reported: string[];
}

/** Re-dispatch a row nothing owns. True when it was dispatched again. */
function redispatch(send: PendingSend, context: ApiContext): boolean {
  if (context.sessionManager.getQueue().hasInFlightItem(send.id)) return false;
  const item = getQueueItem(send.id);
  return item?.status === "pending" && resumePendingQueueItem(item, context);
}

/** What the row is now, after the re-dispatch had its chance: the notice says that, not what the row was. */
function stalledState(send: PendingSend, context: ApiContext): StalledSendState | undefined {
  const status = getQueueItem(send.id)?.status;
  if (status === "cancelled") return "dropped";
  if (status !== "pending") return undefined;
  return context.sessionManager.getQueue().hasInFlightItem(send.id) ? "queued" : "unowned";
}

/** One pass: re-dispatch what nothing owns, tell the sender about what is owned but waiting. */
export function sweepLateralSends(context: ApiContext, opts: { now?: number; afterMs?: number } = {}): LateralSweepResult {
  const now = opts.now ?? Date.now();
  const result: LateralSweepResult = { rearmed: [], reported: [] };
  for (const send of stalledSends(now, opts.afterMs ?? LATERAL_STALL_AFTER_MS)) {
    if (redispatch(send, context)) {
      logger.warn(`[lateral-watch] Message ${send.id} to session ${send.sessionId} was pending with no dispatch; dispatched again`);
      result.rearmed.push(send.id);
      continue;
    }
    const rowState = stalledState(send, context);
    if (rowState && reportStalledSend(send, rowState, context, now)) result.reported.push(send.id);
  }
  return result;
}

/** Watch accepted agent-to-agent messages for as long as the gateway runs. */
export function startLateralSendWatch(context: ApiContext): () => void {
  const timer = setInterval(() => {
    try {
      const { rearmed, reported } = sweepLateralSends(context);
      if (rearmed.length + reported.length > 0) {
        logger.info(`[lateral-watch] re-dispatched ${rearmed.length}, reported ${reported.length} undelivered message(s)`);
      }
    } catch (error) {
      logger.warn(`[lateral-watch] Sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, LATERAL_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
