/**
 * Voice mode wire protocol for `/ws/voice/:sessionId`. JSON text frames carry
 * control; binary frames carry audio only. Contract:
 * specs/009-voice-mode/contracts/voice-socket.md.
 *
 * Up (client → gateway) audio: PCM16LE mono at `ready.input.sampleRate`
 * (16 kHz) in 20 ms frames, continuous while voice mode is on (hands-free) or
 * between `ptt_down` and `ptt_up` (push-to-talk). The gateway owns voice
 * activity detection.
 * Down (gateway → client) audio: a {@link VOICE_AUDIO_HEADER_BYTES}-byte
 * header (`u8 kind = VOICE_AUDIO_KIND`, `u8 reserved`, `u16 seq`,
 * `u32 segmentId`, little-endian) followed by PCM16LE mono at
 * `ready.output.sampleRate` (24 kHz).
 */

export const VOICE_PROTOCOL_VERSION = 1
export const VOICE_AUDIO_KIND = 1
export const VOICE_AUDIO_HEADER_BYTES = 8
export const VOICE_INPUT_SAMPLE_RATE = 16_000
export const VOICE_OUTPUT_SAMPLE_RATE = 24_000
/** The speaking-rate multiplier for spoken replies (`voice.tts.speed`): 1 is the voice's natural pace. */
export const VOICE_SPEED_MIN = 0.5
export const VOICE_SPEED_MAX = 2
export const VOICE_SPEED_DEFAULT = 1
/** The named speeds the settings offer; any value in range is accepted from the config file. */
export const VOICE_SPEED_PRESETS = [
  { label: "Slower", speed: 0.8 },
  { label: "Normal", speed: 1 },
  { label: "Faster", speed: 1.25 },
  { label: "Fastest", speed: 1.5 },
] as const
/** Largest binary frame a client may send. */
export const VOICE_MAX_INPUT_FRAME_BYTES = 4096
/**
 * How often the gateway sends a `keepalive` frame while a client is attached.
 * Browsers cannot see protocol-level ws pings, so a client that wants to notice
 * a half-open connection needs a message it can observe.
 */
export const VOICE_KEEPALIVE_MS = 10_000

export type VoiceMode = "hands-free" | "push-to-talk"
export type VoiceClientKind = "web" | "native"

/** How the session's engine treats long work when the user talks over a running turn. */
export type VoiceBackgrounding =
  /** Long foreground work moves to the background and keeps running. */
  | "native"
  /** Long work keeps running; the utterance is read at the engine's next step. */
  | "steer"
  /** Long work keeps running; the utterance waits for the turn to end. */
  | "none"

export type VoiceTurnState = "idle" | "thinking" | "working" | "speaking"

// ── client → gateway ─────────────────────────────────────────────────────────

export interface VoiceHelloFrame {
  type: "hello"
  protocol: number
  mode: VoiceMode
  client: VoiceClientKind
}

export interface VoicePttFrame {
  type: "ptt_down" | "ptt_up"
}

/** The client's onset detector fired over playback; playback has already stopped. */
export interface VoiceBargeInFrame {
  type: "barge_in"
  /** The segment that was playing, or null when none was. */
  segmentId: number | null
  /** Milliseconds of that segment actually played. */
  playedMs: number
}

/** A segment finished playing in full. */
export interface VoicePlayedFrame {
  type: "played"
  segmentId: number
}

/** The client is back after the device suspended it. */
export interface VoiceResumeFrame {
  type: "resume"
  suspendedMs: number
}

export interface VoiceByeFrame {
  type: "bye"
}

export type VoiceClientFrame =
  | VoiceHelloFrame
  | VoicePttFrame
  | VoiceBargeInFrame
  | VoicePlayedFrame
  | VoiceResumeFrame
  | VoiceByeFrame

// ── gateway → client ─────────────────────────────────────────────────────────

/** Parameters of the client's playback-stopping onset detector. */
export interface VoiceOnsetSettings {
  /** RMS threshold, 0..1. */
  threshold: number
  /** How long the level must hold before playback stops. */
  minSpeechMs: number
}

/** Soft sound cues while the assistant thinks or runs a tool (`voice.cues`). */
export interface VoiceCueSettings {
  enabled: boolean
  /** 0..1. */
  volume: number
}

export interface VoiceReadyFrame {
  type: "ready"
  protocol: number
  sessionId: string
  input: { encoding: "pcm16"; sampleRate: number }
  output: { encoding: "pcm16"; sampleRate: number }
  stt: { provider: string; partials: boolean }
  tts: { provider: string; voice: string | null }
  onset: VoiceOnsetSettings
  /** Absent from a gateway that predates cues: the client then uses its own defaults. */
  cues?: VoiceCueSettings
  backgrounding: VoiceBackgrounding
  limits: { maxUtteranceSeconds: number }
  /**
   * The gateway sends a `keepalive` frame this often. A client may treat the
   * connection as lost when nothing at all has arrived for a few intervals.
   * Absent from gateways that predate keepalives: no watchdog then.
   */
  keepaliveMs?: number
}

/** Sent every `ready.keepaliveMs` so a client can tell a quiet connection from a dead one. Carries no state. */
export interface VoiceKeepaliveFrame {
  type: "keepalive"
}

/** The gateway's voice activity state, for the UI. */
export interface VoiceVadFrame {
  type: "vad"
  speaking: boolean
}

export interface VoiceTranscriptFrame {
  type: "transcript"
  utteranceId: string
  text: string
  final: boolean
}

/**
 * Stop playing now and drop what is buffered. `speech`: the gateway heard speech over playback before the client's
 * onset detector did. `new_reply`: a newer reply is about to be spoken, so the older one is abandoned.
 */
export interface VoiceStopPlaybackFrame {
  type: "stop_playback"
  reason: "speech" | "new_reply"
}

export interface VoiceTurnFrame {
  type: "turn"
  state: VoiceTurnState
  /** The tool running, when `state` is `working`. */
  tool?: string
}

export interface VoiceSegmentStartFrame {
  type: "segment_start"
  segmentId: number
  /** The assistant message the sentence belongs to, when known. */
  messageId: string | null
  /** The speakable text of the sentence. */
  text: string
}

export interface VoiceSegmentEndFrame {
  type: "segment_end"
  segmentId: number
}

/** A holding line is being spoken, with no model turn behind it. */
export interface VoiceHoldingFrame {
  type: "holding"
  text: string
}

export interface VoiceBackgroundFrame {
  type: "background"
  taskId: string
  description: string | null
}

/** Replies that finished while the client was suspended; their speech follows. */
export interface VoiceMissedFrame {
  type: "missed"
  messageIds: string[]
}

export interface VoiceMetricsFrame {
  type: "metrics"
  utteranceId: string
  /** End of speech to final transcript. */
  sttMs: number
  /** Final transcript to the first audio byte sent for the reply. */
  ttfaMs: number | null
}

export type VoiceErrorCode =
  | "bad_frame"
  | "utterance_too_long"
  | "stt_failed"
  | "tts_failed"
  | "dispatch_failed"
  | "speech_unavailable"
  | "internal"

export interface VoiceErrorFrame {
  type: "error"
  code: VoiceErrorCode
  message: string
  utteranceId?: string
}

/** `ended`: the assistant hung up at the user's request (the `end_voice_call` tool), after saying goodbye. */
export type VoiceDetachReason = "taken_over" | "session_gone" | "disabled" | "access_lost" | "shutdown" | "ended"

export interface VoiceDetachedFrame {
  type: "detached"
  reason: VoiceDetachReason
}

export type VoiceServerFrame =
  | VoiceReadyFrame
  | VoiceVadFrame
  | VoiceTranscriptFrame
  | VoiceStopPlaybackFrame
  | VoiceTurnFrame
  | VoiceSegmentStartFrame
  | VoiceSegmentEndFrame
  | VoiceHoldingFrame
  | VoiceBackgroundFrame
  | VoiceMissedFrame
  | VoiceMetricsFrame
  | VoiceErrorFrame
  | VoiceDetachedFrame
  | VoiceKeepaliveFrame

/** WebSocket close codes the gateway uses on `/ws/voice`. */
export const VOICE_CLOSE = {
  protocolError: 4400,
  accessLost: 4401,
  sessionGone: 4404,
  inUse: 4409,
  limit: 4429,
} as const

/** Voice facts stored under `meta.voice` on a message. */
export interface VoiceMessageMeta {
  /** User message: the utterance, STT provider id and captured audio length. */
  utteranceId?: string
  sttProvider?: string
  audioMs?: number
  /** Assistant message: what was actually heard, whether the user cut it off, time to first audio. */
  spokenText?: string
  interrupted?: boolean
  ttfaMs?: number
}
