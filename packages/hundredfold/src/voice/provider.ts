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

export type SttEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
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
  /** The voice used when none is configured, or null when the provider has no notion of one. */
  readonly defaultVoice: string | null;
  /** Speak one sentence, yielding PCM16LE mono chunks as they are produced. */
  synthesize(text: string, options: TtsSynthesisOptions): AsyncIterable<Buffer>;
  status(): VoiceProviderStatus;
  close?(): void;
}

/**
 * What a VAD stream reports, at `atMs`, an offset into everything written to the stream. `start` and `end` mark speech.
 * `reset` says the detector behind the stream was replaced (the sidecar restarted): nothing before `atMs` will get an
 * end, and every later event has `atMs` at or after it. The in-process detector never emits one.
 */
export interface VadEvent { kind: "start" | "end" | "reset"; atMs: number }
export type VadEventHandler = (event: VadEvent) => void;

/** The gateway's voice activity detection over one attachment's continuous audio. */
export interface VadStream {
  /** Append PCM16LE mono at 16 kHz. */
  write(pcm: Buffer): void;
  /** Speech started or ended, or the detector was replaced, at an offset into the stream. */
  on(handler: VadEventHandler): void;
  close(): void;
}
