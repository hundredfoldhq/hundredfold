import type { Engine } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import { ENGINE_SWITCHED_REASON } from "../shared/engine-switch.js";
import { onEngineTargetMoved } from "./engine-override-revert.js";

/** Whether the engine reports that releasing the session's process now would cut a turn off. An engine that cannot say
 *  reads as busy: for the headless engines `kill` is the turn interrupt, and only the Claude PTY holds background tasks. */
function mayCutTurn(engine: Engine, sessionId: string): boolean {
  const reports = (engine as unknown as { holdsTurn?: (id: string) => boolean }).holdsTurn;
  return typeof reports !== "function" || reports.call(engine, sessionId);
}

/**
 * A session handed back to its own target leaves the stand-in's engine process behind, with whatever
 * background tasks it held. Release it as a move, so they are recorded for the turn that runs next and
 * that turn's note tells the session, instead of the release surfacing later as a crash. Not while a
 * turn runs on it, or one typed into its terminal: that turn owns the process. Returns the way to stop.
 */
export function releaseEngineOnMove(engines: ReadonlyMap<string, Engine>): () => void {
  return onEngineTargetMoved((sessionId, fromEngine) => {
    const engine = engines.get(fromEngine);
    if (!engine || !isInterruptibleEngine(engine) || mayCutTurn(engine, sessionId)) return;
    engine.kill(sessionId, ENGINE_SWITCHED_REASON);
  });
}
