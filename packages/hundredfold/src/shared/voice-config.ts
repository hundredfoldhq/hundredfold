/**
 * `voice`: voice mode, a spoken conversation with a chat session (speech to
 * text, then the session's own engine, then text to speech), all through the
 * gateway. Off unless `enabled` is true. Contract with every default and range:
 * specs/009-voice-mode/contracts/voice-config.md.
 *
 * This module holds the type; the validator (`voiceConfigProblems`) and the
 * defaults resolver (`resolveVoiceConfig`) live beside it.
 */

export interface VoiceSttConfig {
  /** `local` | `openai` | `openai-compatible`. Defaults to `local`. */
  provider?: string;
  /** Provider default when absent. */
  model?: string;
  /** `openai-compatible` only: the endpoint root, without `/v1`. */
  baseUrl?: string;
  /** The provider key, as a `${ENV_VAR}` reference only; resolved on the gateway. */
  apiKey?: string;
}

export interface VoiceTtsConfig extends VoiceSttConfig {
  /** Provider default when absent; for `local`, the operator's chosen Kokoro voice. */
  voice?: string;
  /** Playback speed multiplier, 0.5 to 2. Defaults to 1. */
  speed?: number;
}

export interface VoiceConfig {
  /** Off unless true. */
  enabled?: boolean;
  /** Defaults to `hands-free`. */
  mode?: "hands-free" | "push-to-talk";
  /** Language hint, e.g. `en`. Defaults to `en`; the local providers are English only. */
  language?: string;
  stt?: VoiceSttConfig;
  tts?: VoiceTtsConfig;
  /** The gateway's voice activity detection. */
  vad?: {
    /** Speech probability threshold, 0..1. Defaults to 0.5. */
    threshold?: number;
    /** Defaults to 250. */
    minSpeechMs?: number;
    /** Silence that ends an utterance. Defaults to 700. */
    silenceMs?: number;
    /** Audio kept from before speech started. Defaults to 300. */
    prerollMs?: number;
  };
  bargeIn?: {
    /** Defaults to true. */
    enabled?: boolean;
    /** How long the client's onset level must hold before playback stops. Defaults to 250. */
    minSpeechMs?: number;
    /** RMS threshold of the client's onset detector, 0..1. Defaults to 0.02. */
    onsetThreshold?: number;
  };
  autoBackground?: {
    /** Defaults to true. */
    enabled?: boolean;
    /** A foreground tool call older than this when the user talks is long work. Defaults to 5. */
    afterSeconds?: number;
  };
  /** Inline voice prompt; replaces the built-in one. */
  prompt?: string;
  /** Instance-relative file holding the voice prompt. `prompt` wins when both are set. */
  promptFile?: string;
  /** Spoken, with no model turn, when an utterance must wait behind long work. */
  holdingLine?: string;
  limits?: {
    /** Defaults to 60. */
    maxUtteranceSeconds?: number;
    /** Defaults to 4. */
    maxConcurrentAttachments?: number;
  };
  /** The built-in local speech sidecar. */
  local?: {
    /** `auto` uses the GPU when one is found. Defaults to `auto`. */
    device?: "auto" | "gpu" | "cpu";
  };
}
