import { isCompactCommand } from "../shared/skill-commands.js";

/** How one operator message should arrive while a turn is running. */
export type MessageDelivery = "queue" | "now";

/**
 * The caller's explicit choice wins over the global default: `"queue"` never
 * interrupts, `"now"` always does. The legacy `interrupt` boolean maps to the
 * same choice here; anything else falls back to
 * `sessions.interruptOnNewMessage`.
 */
export function resolveMessageDelivery(o: {
  delivery?: unknown;
  interrupt?: unknown;
}): MessageDelivery | undefined {
  if (o.delivery === "queue" || o.delivery === "now") return o.delivery;
  if (o.interrupt === true) return "now";
  if (o.interrupt === false) return "queue";
  return undefined;
}

/**
 * Why a `delivery` field is refused, or undefined when it is absent or valid.
 * A misspelt choice must not fall through to the default, which interrupts.
 */
export function messageDeliveryError(delivery: unknown): string | undefined {
  if (delivery === undefined || delivery === null || delivery === "queue" || delivery === "now") return undefined;
  return 'delivery must be "queue" or "now"';
}

/**
 * Whether a message arriving mid-turn cuts that turn off. An operator message
 * does by default (`sessions.interruptOnNewMessage`); a notification — a child
 * callback, a relay — never does. Nor does `/compact`: it waits for the running
 * turn, since cutting work off to compact it would lose the very turn the
 * summary should include. Nor does anything while the running turn is still
 * auto-compacting a cold session in front of its own message: cut
 * off, that compaction is wasted and the next turn starts it over. Nor does
 * anything while the queue is paused: nothing would drain, so cutting the turn
 * off would only lose its reply.
 * An explicit per-message `delivery` overrides the global default in both
 * directions, subject to those same guards.
 */
export function shouldInterruptRunningTurn(o: {
  isNotification: boolean;
  prompt: string;
  interruptOnNewMessage: boolean | undefined;
  turnRunning: boolean;
  /** The running turn is auto-compacting before its message. */
  autoCompacting?: boolean;
  /** Per-message choice; overrides `interruptOnNewMessage` when set. */
  delivery?: MessageDelivery;
  /** Whether the session's queue is paused; asked only when the answer matters. */
  queuePaused?: () => boolean;
}): boolean {
  if (o.isNotification || !o.turnRunning || o.autoCompacting) return false;
  if (isCompactCommand(o.prompt)) return false;
  if (o.delivery === "queue") return false;
  const wouldInterrupt = o.delivery === "now" || (o.interruptOnNewMessage ?? true);
  return wouldInterrupt && !o.queuePaused?.();
}

/** What an arriving message does to the turn running in its session. */
export type RunningTurnAction = "queue" | "interrupt" | "steer";

/**
 * What to do with a message that arrives while a turn may be running.
 *
 * An unflagged message is exactly {@link shouldInterruptRunningTurn}: it
 * interrupts or it queues, and a notification never does either, never steers.
 *
 * A message the operator asked to be heard (`reachRunningTurn`, read from the
 * durable delivery row, never from a request) is handed to the running turn
 * when the engine can take it, else interrupts like an operator's chat message.
 * Steering ignores `interruptOnNewMessage`: it cuts nothing off. The same
 * guards as above hold it back: no turn running, a running auto-compaction, a
 * compact command and a paused queue all leave it queued behind the turn.
 */
export function runningTurnAction(o: {
  isNotification: boolean;
  prompt: string;
  interruptOnNewMessage: boolean | undefined;
  turnRunning: boolean;
  autoCompacting?: boolean;
  delivery?: MessageDelivery;
  queuePaused?: () => boolean;
  /** The operator's own mention, per the delivery row. */
  reachRunningTurn?: boolean;
  /** Whether the engine can hand a new input to the turn running now. */
  canSteer?: () => boolean;
}): RunningTurnAction {
  if (!o.reachRunningTurn) return shouldInterruptRunningTurn(o) ? "interrupt" : "queue";
  if (!reachableTurnRunning(o)) return "queue";
  if (o.canSteer?.()) return "steer";
  return o.interruptOnNewMessage === false ? "queue" : "interrupt";
}

/** Whether there is a running turn a mention may reach: one that is neither compacting, nor about to compact, nor held by a pause. */
function reachableTurnRunning(o: { prompt: string; turnRunning: boolean; autoCompacting?: boolean; queuePaused?: () => boolean }): boolean {
  return o.turnRunning && !o.autoCompacting && !isCompactCommand(o.prompt) && !o.queuePaused?.();
}
