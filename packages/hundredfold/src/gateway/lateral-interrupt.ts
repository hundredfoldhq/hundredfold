import { getQueueItem, getSession } from "../sessions/registry.js";
import { USER_MESSAGE_INTERRUPTION_REASON } from "../sessions/interruption-reasons.js";
import { supersedeRunningTurn } from "../sessions/turn/superseded.js";
import type { BoundaryInterruptibleEngine, Session, ToolBoundaryOutcome } from "../shared/types.js";
import type { ApiContext } from "./api.js";

/**
 * An agent-to-agent send that asked to interrupt: cut the target's running turn
 * short, between two tool calls, so the message is read now and not when the turn
 * ends. Every other agent-to-agent send, and every callback and notice, still
 * waits its turn (see `message-interrupt.ts`).
 *
 * How long the sender waits to learn whether a call in flight let the turn be
 * cut. A call that outlasts it is not cut: the message stays queued and the abort
 * stays armed for the next boundary, so a long call delays the interrupt rather
 * than losing what it was writing.
 */
export const LATERAL_INTERRUPT_WAIT_MS = 4_000;

/**
 * What the sender is told: the engine's outcome, or `held` when the engine could
 * have stopped at a boundary but the target is compacting, its queue is paused or
 * its turn had just ended, so there was nothing to cut.
 */
export type LateralInterruptOutcome = ToolBoundaryOutcome | "held";

/**
 * Abort the turn running in `session` at a tool boundary, for the queued row
 * `queueItemId`. The row is asked about again right before the abort: if it was
 * withdrawn, cancelled or already read, the turn is left alone.
 */
export async function interruptForLateralSend(o: {
  context: ApiContext;
  engine: BoundaryInterruptibleEngine;
  session: Session;
  queueItemId: string;
  waitMs?: number;
}): Promise<ToolBoundaryOutcome> {
  const { context, engine, session, queueItemId } = o;
  return await engine.interruptAtToolBoundary(session.id, USER_MESSAGE_INTERRUPTION_REASON, {
    waitMs: o.waitMs ?? LATERAL_INTERRUPT_WAIT_MS,
    beforeAbort: () => {
      if (getQueueItem(queueItemId)?.status !== "pending") return false;
      // The cut turn's own answer is no longer wanted: it settles as interrupted, as for any message that cuts a turn.
      supersedeRunningTurn(getSession(session.id) ?? session);
      context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
      return true;
    },
  });
}
