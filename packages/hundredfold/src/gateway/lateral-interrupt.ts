import { getQueueItem, getSession } from "../sessions/registry.js";
import { foldParkedLateralSends } from "../sessions/queued-send-supersede.js";
import { USER_MESSAGE_INTERRUPTION_REASON } from "../sessions/interruption-reasons.js";
import { supersedeRunningTurn } from "../sessions/turn/superseded.js";
import { noticeTargetSessionId } from "../sessions/turn-requester.js";
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
 * What the sender is told: the engine's outcome; `held` when the engine could
 * have stopped at a boundary but the target is compacting, its queue is paused or
 * its turn had just ended, so there was nothing to cut; `refused` when the running
 * turn answers to someone other than the sender (see {@link mayCutRunningTurn});
 * `reading` when the message is the one the running turn is already reading.
 */
export type LateralInterruptOutcome = ToolBoundaryOutcome | "held" | "refused" | "reading";

/**
 * Whether `callerSessionId` may cut the turn `target` is running: only when that
 * turn's end-of-turn notice goes to the caller (its parent or delegator, or the
 * session whose message it is answering). A cut turn settles without a notice,
 * and the turn that replaces it answers the interrupting sender, so anyone else
 * cutting it would take the notice away from whoever is waiting on it. A turn
 * nobody is waiting on (an operator's own chat), or that the operator started,
 * cannot be cut by a session at all: its answer is the operator's.
 */
export function mayCutRunningTurn(target: Session, callerSessionId: string): boolean {
  const fresh = getSession(target.id) ?? target;
  // A turn the operator started (in a spawned session's own chat) answers the operator, whoever its notice goes to.
  if (fresh.attemptOperatorTurn === true) return false;
  return noticeTargetSessionId(fresh) === callerSessionId;
}

/**
 * Abort the turn running in `session` at a tool boundary, for the queued row
 * `queueItemId`, sent by `callerSessionId`. The row is asked about again right
 * before the abort: if it was withdrawn, cancelled or already read, the turn is
 * left alone. (The armed abort ends with the turn, so the turn it cuts is the
 * one the sender was allowed to cut.)
 */
export async function interruptForLateralSend(o: {
  context: ApiContext;
  engine: BoundaryInterruptibleEngine;
  session: Session;
  queueItemId: string;
  callerSessionId: string;
  waitMs?: number;
}): Promise<LateralInterruptOutcome> {
  const { context, engine, session, queueItemId, callerSessionId } = o;
  // A duplicate of the message the turn is reading now: there is nothing to cut it for.
  if (getQueueItem(queueItemId)?.status === "running") return "reading";
  if (!mayCutRunningTurn(session, callerSessionId)) return "refused";
  return await engine.interruptAtToolBoundary(session.id, USER_MESSAGE_INTERRUPTION_REASON, {
    waitMs: o.waitMs ?? LATERAL_INTERRUPT_WAIT_MS,
    beforeAbort: () => {
      if (getQueueItem(queueItemId)?.status !== "pending") return false;
      // The turn is going to be cut: what this sender had parked is read with the message, in send order, as one turn.
      // (Folded only now, so a send that does not end up cutting anything keeps today's turn per message.)
      foldParkedLateralSends(session.sessionKey || session.sourceRef || session.id, queueItemId);
      // The cut turn's own answer is no longer wanted: it settles as interrupted, as for any message that cuts a turn.
      supersedeRunningTurn(getSession(session.id) ?? session);
      context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
      return true;
    },
  });
}
