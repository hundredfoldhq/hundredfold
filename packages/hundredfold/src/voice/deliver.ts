/**
 * A spoken message reaches a session the way a typed one does (FR-004): the
 * same durable claim, queue row and dispatch as `POST /api/sessions/:id/message`
 * for a user message, built from the same pieces rather than called over HTTP.
 * The one difference is who decides whether a running turn is cut: here the
 * barge-in policy has already decided, and this module only refuses to carry
 * out a kill the invariant forbids.
 */
import type { ApiContext } from "../gateway/api.js";
import { dispatchWebSessionRun } from "../gateway/web-session-dispatch.js";
import { sessionCommGuards } from "../gateway/session-comm-guards.js";
import { endStopOnDeliberateSend } from "../gateway/session-stop.js";
import { maybeRevertEngineOverride } from "../sessions/manager.js";
import { claimIncomingTurn } from "../sessions/incoming-turn.js";
import { clearDelegationCompletionContract } from "../sessions/delegation-completion-contract.js";
import { compactionInFlight } from "../sessions/compaction-in-flight.js";
import { USER_MESSAGE_INTERRUPTION_REASON } from "../sessions/interruption-reasons.js";
import { enqueueQueueItem } from "../sessions/queue-item-registry.js";
import { mergePendingQueueItems } from "../sessions/queue-merge.js";
import { getSession, updateSession } from "../sessions/registry.js";
import { registerSteeredDelivery } from "../sessions/steered-deliveries.js";
import { supersedeRunningTurn } from "../sessions/turn/superseded.js";
import { isCompactCommand } from "../shared/skill-commands.js";
import { isInterruptibleEngine, isSteerableEngine, type Engine, type Session } from "../shared/types.js";
import { isTerminalSession, TERMINAL_REFUSES_MESSAGES } from "../terminals/session.js";
import { foregroundWorkOf } from "./barge-in-policy.js";
import { withVoiceEnvelope } from "./envelope.js";
import type { VoiceDelivery, VoiceDeliveryMode, VoiceDeliveryResult, VoiceHubDeps } from "./hub-types.js";

/** Whether a turn is running in the session now, as the message route reads it. */
export function turnRunningFor(session: Pick<Session, "status">, engine: Engine, sessionId: string): boolean {
  if (session.status !== "running" || !isInterruptibleEngine(engine)) return false;
  return "isTurnRunning" in engine ? (engine as { isTurnRunning(id: string): boolean }).isTurnRunning(sessionId) : engine.isAlive(sessionId);
}

/**
 * The mode actually carried out. A turn is cut only when nothing long runs in
 * it, nothing is compacting, the message is no command and the queue is not
 * paused (the same guards a typed "send now" has); steering needs an engine
 * that can take the input now. Anything else waits its turn.
 */
function effectiveMode(context: ApiContext, session: Session, engine: Engine, delivery: VoiceDelivery): VoiceDeliveryMode {
  if (delivery.mode === "steer") {
    const compacting = compactionInFlight(session.id) || isCompactCommand(delivery.text);
    return isSteerableEngine(engine) && !compacting && engine.canSteer(session.id) ? "steer" : "queue";
  }
  if (delivery.mode !== "interrupt") return "queue";
  const key = session.sessionKey || session.sourceRef || session.id;
  const mayCut = isInterruptibleEngine(engine)
    && turnRunningFor(session, engine, session.id)
    && foregroundWorkOf(engine, session.id) === null
    && !compactionInFlight(session.id)
    && !isCompactCommand(delivery.text)
    && !context.sessionManager.getQueue().isPaused(key);
  return mayCut ? "interrupt" : "queue";
}

/** What a typed message does to the session's status before it runs. */
function readyForMessage(session: Session): Session {
  if (session.status === "waiting") {
    // A new message on a limit-paused session is an explicit "retry now".
    updateSession(session.id, { status: "idle", lastActivity: new Date().toISOString(), lastError: null });
  } else if (session.status === "interrupted") {
    updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });
  }
  return getSession(session.id) ?? session;
}

export async function deliverVoiceMessage(context: ApiContext, delivery: VoiceDelivery): Promise<VoiceDeliveryResult> {
  const found = getSession(delivery.sessionId);
  if (!found) throw new Error(`session ${delivery.sessionId} not found`);
  if (isTerminalSession(found)) throw new Error(TERMINAL_REFUSES_MESSAGES);
  let session = maybeRevertEngineOverride(found, undefined, context.getConfig());
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine) throw new Error(`engine ${session.engine} is not available`);
  // A genuine message from the operator is a fresh start, not hop N of a relay.
  sessionCommGuards.clearInboundHop(session.id);
  session = clearDelegationCompletionContract(session);

  const mode = effectiveMode(context, session, engine, delivery);
  const sessionKey = session.sessionKey || session.sourceRef || session.id;
  if (mode === "interrupt") supersedeRunningTurn(session);
  const claim = claimIncomingTurn({
    sessionId: session.id, sessionKey, prompt: delivery.text, isNotification: false, role: "user",
    content: delivery.text, meta: delivery.meta,
  });
  if (!claim.messageId) throw new Error("the message could not be recorded");
  endStopOnDeliberateSend(session);
  session = readyForMessage(session);
  if (mode === "interrupt" && isInterruptibleEngine(engine)) {
    engine.kill(session.id, USER_MESSAGE_INTERRUPTION_REASON);
    context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
  }
  context.sessionManager.getQueue().clearCancelled(sessionKey);

  const messageId = claim.messageId;
  const queueItemId = enqueueQueueItem(session.id, sessionKey, delivery.text, {
    messageId,
    dispatch: { attachments: [], speechDerived: false, ...(delivery.envelope ? { voiceEnvelope: delivery.envelope } : {}) },
  });
  if (mode === "interrupt") mergePendingQueueItems(sessionKey, queueItemId);
  context.emit("queue:updated", { sessionId: session.id, sessionKey });

  const enginePrompt = withVoiceEnvelope(delivery.text, delivery.envelope);
  if (mode === "steer" && isSteerableEngine(engine)) {
    registerSteeredDelivery(queueItemId, Promise.resolve().then(() => engine.steer(session.id, enginePrompt)));
  }
  dispatchWebSessionRun(session, enginePrompt, engine, context, { queueItemId, operatorTurn: delivery.operator });
  return { messageId };
}

/** The hub's `deliver` port, bound to the gateway's context. */
export function voiceDeliveryFor(context: ApiContext): VoiceHubDeps["deliver"] {
  return (delivery) => deliverVoiceMessage(context, delivery);
}
