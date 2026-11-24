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
 * summary should include. Nor does anything while a compaction is under way or
 * queued for the session (an auto-compaction in front of its own message, or a
 * `/compact` turn, an operator's or the session's own): cut off, the compaction
 * is wasted and the context never shrinks, and the message waits behind it. Nor does
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
  /** A compaction is running for the session or queued to run next: see `compactionInFlight`. */
  compacting?: boolean;
  /** Per-message choice; overrides `interruptOnNewMessage` when set. */
  delivery?: MessageDelivery;
  /** Whether the session's queue is paused; asked only when the answer matters. */
  queuePaused?: () => boolean;
}): boolean {
  if (o.isNotification || !o.turnRunning || o.compacting) return false;
  if (isCompactCommand(o.prompt)) return false;
  if (o.delivery === "queue") return false;
  const wouldInterrupt = o.delivery === "now" || (o.interruptOnNewMessage ?? true);
  return wouldInterrupt && !o.queuePaused?.();
}

/** What an arriving message does to the turn running in its session. */
export type RunningTurnAction = "queue" | "interrupt" | "steer" | "promote";

/**
 * What to do with a message that arrives while a turn may be running.
 *
 * An unflagged message is exactly {@link shouldInterruptRunningTurn}: it
 * interrupts or it queues, and a notification never does either, never steers.
 *
 * A message the operator asked to be heard (`reachRunningTurn`, read from the
 * durable delivery row, never from a request) never cuts a turn off: on claude
 * an interrupt ends the whole process, with its tool call, background shells
 * and subagents. It is handed to the running turn when the engine can take it
 * (`"steer"`), else moved to the head of its lane (`"promote"`) to be the next
 * thing the session reads. Neither looks at `interruptOnNewMessage`. The same
 * guards as above hold it back: no turn running, a compaction under way or queued, a
 * compact command and a paused queue all leave it queued behind the turn.
 */
export function runningTurnAction(o: {
  isNotification: boolean;
  prompt: string;
  interruptOnNewMessage: boolean | undefined;
  turnRunning: boolean;
  compacting?: boolean;
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
  return "promote";
}

/** Whether there is a running turn a mention may reach: one that is neither compacting, nor about to compact, nor held by a pause. */
function reachableTurnRunning(o: { prompt: string; turnRunning: boolean; compacting?: boolean; queuePaused?: () => boolean }): boolean {
  return o.turnRunning && !o.compacting && !isCompactCommand(o.prompt) && !o.queuePaused?.();
}

/**
 * Whether an agent-to-agent send that asked to interrupt cuts the target's
 * running turn short. The sender's request is the only thing that opts a
 * notification in: a callback or a notice never reaches here. The same guards as
 * an operator's message hold it back: no turn running, a compaction under way or
 * queued, a paused queue (nothing would drain, so the cut turn's reply would
 * only be lost).
 */
export function interruptsAtToolBoundary(o: {
  requested: boolean;
  turnRunning: boolean;
  compacting?: boolean;
  queuePaused?: () => boolean;
}): boolean {
  return o.requested && o.turnRunning && !o.compacting && !o.queuePaused?.();
}
