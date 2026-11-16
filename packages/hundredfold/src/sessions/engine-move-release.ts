import type { Engine } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import { ENGINE_SWITCHED_REASON } from "../shared/engine-switch.js";
import { onEngineTargetMoved } from "./engine-override-revert.js";

/** Whether the engine has a turn running for the session; an engine that cannot say reads as none. */
function turnRunning(engine: Engine, sessionId: string): boolean {
  return "isTurnRunning" in engine && Boolean((engine as unknown as { isTurnRunning(id: string): boolean }).isTurnRunning(sessionId));
}

/**
 * A session handed back to its own target leaves the stand-in's engine process behind, with whatever
 * background tasks it held. Release it as a move, so they are recorded for the turn that runs next and
 * that turn's note tells the session, instead of the release surfacing later as a crash. Not while a
 * turn runs on it: that turn owns the process. Returns the way to stop.
 */
export function releaseEngineOnMove(engines: ReadonlyMap<string, Engine>): () => void {
  return onEngineTargetMoved((sessionId, fromEngine) => {
    const engine = engines.get(fromEngine);
    if (!engine || !isInterruptibleEngine(engine) || turnRunning(engine, sessionId)) return;
    engine.kill(sessionId, ENGINE_SWITCHED_REASON);
  });
}
