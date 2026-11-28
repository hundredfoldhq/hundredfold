/**
 * When each turn this gateway runs last showed progress: its start, then every
 * block the engine streamed. The turn heartbeat cannot answer this, because it
 * ticks for as long as the engine's run() is pending, wedged or not.
 *
 * Engines that report {@link import("../../shared/types.js").TurnProgress}
 * say more (tools and model requests in flight); this clock covers every engine,
 * so a reader can tell a turn that is getting somewhere from one gone quiet.
 */
const lastOutputAt = new Map<string, number>();

export function markTurnOutput(sessionId: string, at: number = Date.now()): void {
  lastOutputAt.set(sessionId, at);
}

/** The last progress of the session's turn in flight, or undefined when none is running here. */
export function lastTurnOutputAt(sessionId: string): number | undefined {
  return lastOutputAt.get(sessionId);
}

/** The turn ended: a stale clock must not speak for the next one. */
export function clearTurnOutput(sessionId: string): void {
  lastOutputAt.delete(sessionId);
}
