import { initDb } from "../shared/db.js";
import type { SessionAttemptOutcome } from "../shared/types.js";
import { hasStoppedMark } from "./stopped-marker.js";
import { settledAttemptOutcome, type RestartResumeEvidence } from "./restart-resume-window.js";

/** What the in-process session queue says about the rows the database holds. */
export interface LiveSessionQueue {
  /** The queue still has this row in hand, so it will run it without anyone asking. */
  holds(queueItemId: string): boolean;
  /** The operator paused the lane: nothing runs from it until the operator resumes it. */
  isPaused(sessionKey: string): boolean;
}

let liveQueue: LiveSessionQueue | undefined;

/**
 * Register the live queue once the gateway has finished replaying the rows its
 * previous process left. Until then (and in a caller with no queue at all, such
 * as a unit test) the answer falls back to the rows in the database: before the
 * replay a pending row is exactly the turn the boot is about to start, and
 * reading it as stranded would block the Todo for the few seconds before the
 * replay undoes it. Pass `undefined` to unregister.
 */
export function registerLiveSessionQueue(queue: LiveSessionQueue | undefined): void {
  liveQueue = queue;
}

/**
 * Whether the gateway still owes a session a turn that it will run on its own.
 *
 * A session's receipt says how its LAST turn ended. It says nothing about
 * whether another turn is already on its way, and a Todo derives its status
 * from receipts: a `failed` or `interrupted` one that is newest, with nothing
 * running at the moment of a sweep, reads as "the attempt broke" and blocks the
 * Todo. Several ordinary pauses leave exactly that picture for a few seconds
 * to minutes while the work carries straight on:
 *
 * - a self-compaction, where the `/compact` turn can end badly and the resume
 *   turn is still queued, or still being delivered by the outbox;
 * - a gateway or engine restart, where the interrupted turn's queue row is
 *   back to `pending` for the boot replay;
 * - a child's report that has not yet been accepted by its parent's session.
 *
 * Reading those as failures flips the Todo to `blocked` and back, wakes the
 * people watching it, and once it happens enough times the loop breaker routes
 * the Todo to the operator, who then has to release work that never stopped.
 *
 * The state that settles it is whether a turn is owed, not which writer left
 * the receipt. Two promises count:
 *
 * - an outbox delivery to the session that is still `pending`, which the outbox
 *   retries by itself;
 * - a queue row for the session, `pending` or `running`, that the live queue
 *   holds and whose lane is not paused. A row alone is not a promise: a reset
 *   leaves its rows pending in the database after the queue dropped them, a
 *   connector session's rows are not replayed at boot, and a paused lane waits
 *   for a person. Those are real stops and must still block the Todo.
 *
 * A session the operator stopped is never owed: nothing but a deliberate start
 * will run it again.
 *
 * Only a bad receipt reaches this, so the common path pays nothing. The queue
 * rows are read by the lane's key, which `idx_queue_session` leads with.
 */
export function gatewayOwesTurn(sessionId: string): boolean {
  if (hasStoppedMark(sessionId)) return false;
  const database = initDb();
  const pendingDelivery = database
    .prepare("SELECT 1 FROM callback_deliveries WHERE target_session_id = ? AND status = 'pending' LIMIT 1")
    .get(sessionId);
  if (pendingDelivery) return true;
  const owner = database
    .prepare("SELECT session_key AS sessionKey, source_ref AS sourceRef FROM sessions WHERE id = ?")
    .get(sessionId) as { sessionKey: string | null; sourceRef: string | null } | undefined;
  // The lane key every queue writer uses (`session.sessionKey || sourceRef || id`).
  const laneKey = owner?.sessionKey || owner?.sourceRef || sessionId;
  const rows = database
    .prepare("SELECT id FROM queue_items WHERE session_key = ? AND session_id = ? AND status IN ('pending', 'running')")
    .all(laneKey, sessionId) as { id: string }[];
  if (rows.length === 0) return false;
  const queue = liveQueue;
  if (!queue) return true;
  return !queue.isPaused(laneKey) && rows.some((row) => queue.holds(row.id));
}

/**
 * The receipt a Todo should settle on for a session: none while the attempt is
 * still in flight. That is the restart window (`settledAttemptOutcome`) and,
 * for a `failed` or `interrupted` receipt only, a turn the gateway still owes
 * the session (`gatewayOwesTurn`). A clean receipt is final and never costs a
 * query.
 *
 * Every reader that decides a Todo's status or closes its run ledger goes
 * through here, so the two never disagree about whether an attempt is over.
 */
export function settledOutcomeUnlessTurnOwed(
  session: RestartResumeEvidence & { id: string },
  now: number = Date.now(),
): SessionAttemptOutcome | null {
  const outcome = settledAttemptOutcome(session, now);
  if (outcome === null || outcome === "succeeded") return outcome;
  return gatewayOwesTurn(session.id) ? null : outcome;
}
