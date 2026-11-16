import type { SteerOutcome } from "../shared/types.js";

/**
 * Inputs handed to a running turn instead of waiting for their own, by the
 * queue row they were accepted under.
 *
 * The row still waits in its lane. When its slot comes, the dispatch asks what
 * became of the hand-over: taken in by the turn that has just ended, the row
 * has nothing left to run; taken back out, it runs as a turn of its own.
 */
const steered = new Map<string, Promise<SteerOutcome>>();

/** Remember the hand-over made for this queue row. A rejection counts as taken back. */
export function registerSteeredDelivery(queueItemId: string, outcome: Promise<SteerOutcome>): void {
  steered.set(queueItemId, outcome.catch(() => "withdrawn" as const));
}

/** What became of this row's hand-over, once it is known, and forget it. Undefined when the row was never steered. */
export async function settleSteeredDelivery(queueItemId: string | undefined): Promise<SteerOutcome | undefined> {
  const pending = queueItemId ? steered.get(queueItemId) : undefined;
  if (!queueItemId || !pending) return undefined;
  try {
    return await pending;
  } finally {
    steered.delete(queueItemId);
  }
}
