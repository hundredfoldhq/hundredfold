/**
 * Hands the gateway's events to the voice hub as they are emitted (FR-005): an
 * attached session's reply text and tool calls, its turn ending, its background
 * work. A decorator on `emit`, after the talk-proactive one, that never changes
 * what the rest of the gateway sees: the original emit runs first and a failure
 * in voice is logged, not thrown.
 *
 * It is installed only when voice is enabled at boot (`runtime.ts`); with voice
 * off, `emit` is the gateway's own and nothing here runs.
 */
import type { GatewayEmit } from "../shared/gateway-events.js";
import type { VoiceLog } from "./hub-types.js";

/** What the tee needs of the hub. */
export interface VoiceEventSink {
  onEvent(event: string, payload: unknown): void;
}

export function createVoiceEmitTee(emit: GatewayEmit, sink: VoiceEventSink, log: VoiceLog): GatewayEmit {
  return ((event, payload) => {
    emit(event, payload);
    try {
      sink.onEvent(event, payload);
    } catch (error) {
      log.warn(`voice: could not handle ${event}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }) as GatewayEmit;
}
