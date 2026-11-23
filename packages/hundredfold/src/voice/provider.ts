/**
 * Voice mode speech providers. A provider runs only on the gateway; nothing
 * here, a key least of all, is ever sent to a client. Contract:
 * specs/009-voice-mode/contracts/providers.md.
 */

/** Readiness reported by `GET /api/voice/config`, with no secret in it. */
export interface VoiceProviderStatus {
  available: boolean;
  /** Why it is not available (missing binary, missing key, unreachable endpoint). */
  reason?: string;
}

export interface SttStreamOptions {
  /** Language hint, e.g. `en`. */
  language: string;
  /** Sample rate of the PCM16LE mono audio written. */
  sampleRate: number;
  /** Aborts the recognition and its upstream connection. */
  signal: AbortSignal;
}

/**
 * What a provider says about how sure it is of a final transcript, when it says anything (each field is absent when the
 * provider reports nothing: the local Parakeet models and OpenAI's Realtime transcription report neither).
 */
export interface SttQuality {
  /** Mean per-token probability of the words, 0..1 (the exponent of a Whisper-style `avg_logprob`). */
  confidence?: number;
  /** Probability that the audio held no speech, 0..1 (Whisper's `no_speech_prob`; the highest of the segments). */
  noSpeechProb?: number;
}

export type SttEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string; quality?: SttQuality }
  | { type: "error"; message: string };

/** One utterance's recognition. Emits at most one `final` or one `error`, then nothing. */
export interface SttStream {
  /** Append captured audio. Ignored after `end()` or `abort()`. */
  write(pcm: Buffer): void;
  /** The utterance is over: flush and produce the final transcript. */
  end(): void;
  /** Drop the utterance; no `final` follows. */
  abort(): void;
  /** Subscribe to events. Later subscribers do not replace earlier ones. */
  on(handler: (event: SttEvent) => void): void;
}

export interface SttProvider {
  readonly id: string;
  /** Whether `partial` events arrive while the user speaks (false for batch providers). */
  readonly partials: boolean;
  open(options: SttStreamOptions): SttStream;
  status(): VoiceProviderStatus;
  /** Release long-lived resources (sockets, sidecars). */
  close?(): void;
}

export interface TtsSynthesisOptions {
  voice?: string;
  speed?: number;
  language: string;
  /** Aborting stops synthesis and ends the iterator. */
  signal: AbortSignal;
}

export interface TtsProvider {
  readonly id: string;
  /** Sample rate of the PCM16LE mono chunks `synthesize` yields. */
  readonly sampleRate: number;
  /**
   * Whether the provider's `speed` request changes how fast it speaks. False for a model that accepts the
   * field and ignores it (OpenAI's `gpt-4o-mini-tts`); the pipeline then changes the pace of the audio itself.
   * Absent means true.
   */
  readonly honoursSpeed?: boolean;
  /** The voice used when none is configured, or null when the provider has no notion of one. */
  readonly defaultVoice: string | null;
  /** Speak one sentence, yielding PCM16LE mono chunks as they are produced. */
  synthesize(text: string, options: TtsSynthesisOptions): AsyncIterable<Buffer>;
  status(): VoiceProviderStatus;
  close?(): void;
}

/**
 * What a VAD stream reports, at `atMs`, an offset into everything written to the stream. `start` and `end` mark speech.
 * An `end` carries `speechMs`, how long that speech was voiced. `reset` says the detector behind the stream was replaced
 * (the sidecar restarted): nothing before `atMs` will get an end, and every later event has `atMs` at or after it. The
 * in-process detector never emits one.
 */
export interface VadEvent {
  kind: "start" | "end" | "reset";
  atMs: number;
  /** On `end`: how long the speech that just ended was voiced, first voiced frame to last, without the pre-roll or the trailing silence. */
  speechMs?: number;
}
export type VadEventHandler = (event: VadEvent) => void;

/** The gateway's voice activity detection over one attachment's continuous audio. */
export interface VadStream {
  /** Append PCM16LE mono at 16 kHz. */
  write(pcm: Buffer): void;
  /** Speech started or ended, or the detector was replaced, at an offset into the stream. */
  on(handler: VadEventHandler): void;
  close(): void;
}
