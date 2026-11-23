/**
 * Gateway-facing view of the neutral wire protocol.
 *
 * The CLI build replaces this module's generated declaration with the complete
 * neutral declaration so the published package remains self-contained while
 * source builds still compile against the single workspace contract.
 */
export type {
  CompanyChangedEvent,
  GatewayEmit,
  GatewayEvent,
  GatewayEventMap,
  GatewayEventName,
} from "@hundredfold/gateway-events";

// Voice mode wire protocol (specs/009-voice-mode/contracts/voice-socket.md). The
// constants are runtime values: in the published build this module is replaced by
// the embedded protocol runtime, which exports them too.
export {
  VOICE_AUDIO_HEADER_BYTES,
  VOICE_AUDIO_KIND,
  VOICE_CLOSE,
  VOICE_INPUT_SAMPLE_RATE,
  VOICE_KEEPALIVE_MS,
  VOICE_MAX_INPUT_FRAME_BYTES,
  VOICE_OUTPUT_SAMPLE_RATE,
  VOICE_PROTOCOL_VERSION,
  VOICE_SPEED_DEFAULT,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
} from "@hundredfold/gateway-events";
export type {
  VoiceBackgrounding,
  VoiceBackgroundFrame,
  VoiceClientFrame,
  VoiceDetachReason,
  VoiceDetachedFrame,
  VoiceErrorCode,
  VoiceErrorFrame,
  VoiceHoldingFrame,
  VoiceKeepaliveFrame,
  VoiceMessageMeta,
  VoiceMetricsFrame,
  VoiceMissedFrame,
  VoiceMode,
  VoiceReadyFrame,
  VoiceSegmentEndFrame,
  VoiceSegmentStartFrame,
  VoiceServerFrame,
  VoiceStopPlaybackFrame,
  VoiceTranscriptFrame,
  VoiceTurnFrame,
  VoiceTurnState,
  VoiceVadFrame,
} from "@hundredfold/gateway-events";
