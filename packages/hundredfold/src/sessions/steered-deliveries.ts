import { logger } from "../shared/logger.js";
import type { SteerOutcome } from "../shared/types.js";
import { completePendingQueueItem, getQueueItem } from "./queue-item-registry.js";

/**
 * Inputs handed to a running turn instead of waiting for their own, by the
 * queue row they were accepted under.
 *
 * The row waits in its lane behind that turn. What became of the hand-over
 * settles it:
 * - taken in ("steered"): the row is completed in the store the moment that is
 *   known, so the lane skips it and a restart does not replay it as a turn. The
 *   transcript keeps the message.
 * - taken back out ("withdrawn", or a failed hand-over): the row runs as a turn
 *   of its own, when its slot comes.
 */
const steered = new Map<string, Promise<SteerOutcome>>();

/** How long a slot waits for an outcome that is still unknown once its row is reached. */
export const STEER_SETTLE_TIMEOUT_MS = 30_000;
let settleTimeoutMs = STEER_SETTLE_TIMEOUT_MS;

/** Shorten (or restore, with no argument) the slot's wait, for tests. */
export function setSteerSettleTimeoutForTest(ms: number = STEER_SETTLE_TIMEOUT_MS): void {
  settleTimeoutMs = ms;
}

/** Remember the hand-over made for this queue row. A rejection counts as taken back. */
export function registerSteeredDelivery(queueItemId: string, outcome: Promise<SteerOutcome>): void {
  const settled = outcome.catch(() => "withdrawn" as const);
  steered.set(queueItemId, settled);
  void settled.then((result) => onOutcome(queueItemId, result));
}

/**
 * A row still parked whose input a turn took in is finished at once; a row that
 * can no longer start (cancelled, completed, gone) has nothing left to wait for.
 * One a slot already claimed is left to that slot, and so is a withdrawn one.
 */
function onOutcome(queueItemId: string, outcome: SteerOutcome): void {
  const status = getQueueItem(queueItemId)?.status;
  const finished = outcome === "steered" && status === "pending" && completePendingQueueItem(queueItemId);
  if (finished || (status !== "pending" && status !== "running")) steered.delete(queueItemId);
}

/**
 * What became of this row's hand-over, once it is known, and forget it.
 * Undefined when the row was never steered. An outcome still unknown after the
 * bound is treated as taken back: the row runs, which may answer the input a
 * second time if the turn did take it in, a late answer then being ignored.
 */
export async function settleSteeredDelivery(queueItemId: string | undefined): Promise<SteerOutcome | undefined> {
  const pending = queueItemId ? steered.get(queueItemId) : undefined;
  if (!queueItemId || !pending) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<SteerOutcome>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(`Turn ${queueItemId}: no outcome for the input handed to the running turn after ${settleTimeoutMs} ms; `
            + "running it as a turn of its own, so it may be answered twice");
          resolve("withdrawn");
        }, settleTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    steered.delete(queueItemId);
  }
}
