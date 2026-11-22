/**
 * How an utterance that arrives while a turn may be running reaches the
 * session (FR-009 to FR-018). A pure decision table over what the engine can
 * do; the hub carries the decision out. Contract and table:
 * specs/009-voice-mode/contracts/providers.md.
 *
 * Invariant: no outcome ends a turn that is running long foreground work by
 * killing it. `interrupt_now` is chosen only when the engine reports none.
 */
import type { ForegroundWork } from "../shared/types.js";

export type BargeInDecision =
  /** No turn is running: the utterance is a message like any other. */
  | { kind: "new_turn" }
  /** A tool call is younger than the threshold: give it until then, then decide again. */
  | { kind: "wait_then_decide"; waitMs: number }
  /** End the turn softly (long work moves to the background), then send the utterance. */
  | { kind: "soft_then_turn" }
  /** Hand the utterance to the running turn at its next step. */
  | { kind: "steer" }
  /** As `steer`, and say a holding line: long work is still running. */
  | { kind: "steer_with_holding" }
  /** Queue behind the turn, and say a holding line. */
  | { kind: "queue_with_holding" }
  /** Nothing long is running: the existing "send now" cuts the turn. */
  | { kind: "interrupt_now" };

export interface BargeInInput {
  turnRunning: boolean;
  /** The tool call running in the foreground, or null when the engine reports none. */
  longWork: ForegroundWork | null;
  /** Epoch ms now, from the injected clock. */
  nowMs: number;
  /** A tool call older than this is long work, in ms. */
  thresholdMs: number;
  /** The engine's soft interrupt, or null when it has none (or backgrounding is off). */
  soft: { preserves: boolean } | null;
  /** The engine can take an input into the running turn. */
  steerable: boolean;
}

/** Whether the foreground call has run past the threshold. */
export function isLongWork(work: ForegroundWork, nowMs: number, thresholdMs: number): boolean {
  return nowMs - work.startedAt >= thresholdMs;
}

function decideWithLongWork(input: BargeInInput): BargeInDecision {
  if (input.soft?.preserves) return { kind: "soft_then_turn" };
  return input.steerable ? { kind: "steer_with_holding" } : { kind: "queue_with_holding" };
}

function decideWithoutWork(input: BargeInInput): BargeInDecision {
  if (input.soft) return { kind: "soft_then_turn" };
  return input.steerable ? { kind: "steer" } : { kind: "interrupt_now" };
}

export function decideBargeIn(input: BargeInInput): BargeInDecision {
  if (!input.turnRunning) return { kind: "new_turn" };
  const work = input.longWork;
  if (!work) return decideWithoutWork(input);
  if (!isLongWork(work, input.nowMs, input.thresholdMs)) {
    return { kind: "wait_then_decide", waitMs: Math.max(1, input.thresholdMs - (input.nowMs - work.startedAt)) };
  }
  return decideWithLongWork(input);
}

/**
 * The foreground tool call an engine reports for a session, or null when it
 * reports none. An engine with no way to say (neither the soft interrupt nor
 * OpenCode's plain method) reports none, as the contract has it.
 */
export function foregroundWorkOf(engine: object, sessionId: string): ForegroundWork | null {
  const candidate = engine as { foregroundWork?: (sessionId: string) => ForegroundWork | null };
  return typeof candidate.foregroundWork === "function" ? candidate.foregroundWork(sessionId) : null;
}
