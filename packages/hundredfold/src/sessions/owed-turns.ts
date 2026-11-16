import { initDb } from "../shared/db.js";
import type { SessionAttemptOutcome } from "../shared/types.js";
import { hasStoppedMark } from "./stopped-marker.js";
import { settledAttemptOutcome, type RestartResumeEvidence } from "./restart-resume-window.js";

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
 * the receipt, so the answer comes from the two places the gateway keeps its
 * promises: a queue row for the session that is `pending` or `running`, and an
 * outbox delivery to the session that is still `pending`. A session the
 * operator stopped is the exception: a stop is a real stop, and nothing but a
 * deliberate start will run it again, so it is never owed.
 *
 * `queue_items` has no index on `session_id` (its index leads with the session
 * key), so the queue lookup is a table scan; the outbox lookup uses the
 * leading column of its identity index. Both are only reached for a bad
 * receipt, which is rare, so nothing pays for this on the common path.
 */
export function gatewayOwesTurn(sessionId: string): boolean {
  if (hasStoppedMark(sessionId)) return false;
  const database = initDb();
  const pendingDelivery = database
    .prepare("SELECT 1 FROM callback_deliveries WHERE target_session_id = ? AND status = 'pending' LIMIT 1")
    .get(sessionId);
  if (pendingDelivery) return true;
  return database
    .prepare("SELECT 1 FROM queue_items WHERE session_id = ? AND status IN ('pending', 'running') LIMIT 1")
    .get(sessionId) !== undefined;
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
