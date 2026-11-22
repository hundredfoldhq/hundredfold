# Contract: speech providers and the engine capability

## `voice/provider.ts`

```ts
export interface VoiceProviderStatus { available: boolean; reason?: string }

export interface SttStreamOptions { language: string; sampleRate: number; signal: AbortSignal }

export type SttEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

/** One utterance. At most one `final` or one `error`, then nothing. */
export interface SttStream {
  write(pcm: Buffer): void;
  end(): void;
  abort(): void;
  on(handler: (event: SttEvent) => void): void;
}

export interface SttProvider {
  readonly id: string;
  readonly partials: boolean;
  open(options: SttStreamOptions): SttStream;
  status(): VoiceProviderStatus;
  close?(): void;
}

export interface TtsSynthesisOptions { voice?: string; speed?: number; language: string; signal: AbortSignal }

export interface TtsProvider {
  readonly id: string;
  readonly sampleRate: number;
  readonly defaultVoice: string | null;
  /** One sentence in, PCM16LE mono chunks out. */
  synthesize(text: string, options: TtsSynthesisOptions): AsyncIterable<Buffer>;
  status(): VoiceProviderStatus;
  close?(): void;
}

/** VAD is the gateway's; the local sidecar provides it, others reuse the local one if
 *  installed, else an energy VAD in-process (documented as less accurate). */
export interface VadStream {
  write(pcm: Buffer): void;
  on(handler: (event: { kind: "start" | "end"; atMs: number }) => void): void;
  close(): void;
}
```

| Provider | STT | TTS | Partials |
|---|---|---|---|
| `local` | sidecar `stt.partial` (every 400 ms, skip if busy) / `stt.final` | sidecar `tts` | yes |
| `openai` | Realtime transcription session over WebSocket (the producer checks the current API shape and cites the doc and date in the PR) | `POST /v1/audio/speech`, `response_format: "pcm"` (24 kHz), streamed | yes |
| `openai-compatible` | `POST {baseUrl}/v1/audio/transcriptions` (multipart WAV, batch) | `POST {baseUrl}/v1/audio/speech` asking `pcm`, falling back to `wav` (unwrapped); MP3-only refused | no |

Every network call honours its `AbortSignal`. Keys come from `resolveEnvVar` at
construction and live only in the provider's closure.

## `SoftInterruptibleEngine` (in `shared/types.ts`)

```ts
export interface ForegroundWork { tool: string; startedAt: number; description: string | null }
export interface BackgroundedWork { taskId: string; description: string | null }
export type SoftInterruptOutcome =
  | { ended: true; backgrounded: BackgroundedWork[] }
  | { ended: false; reason: "no_turn" | "unsupported" };

export interface SoftInterruptibleEngine extends Engine {
  /** True when a soft interrupt moves running foreground work to the background. */
  readonly softInterruptPreservesForegroundWork: boolean;
  foregroundWork(sessionId: string): ForegroundWork | null;
  /** End the running turn, keep the process. Never rejects. */
  softInterrupt(sessionId: string, reason: string): Promise<SoftInterruptOutcome>;
}
export function isSoftInterruptibleEngine(engine: Engine): engine is SoftInterruptibleEngine;
```

Implementer: `InteractiveClaudeEngine` (Ctrl+B then Esc in the TUI, `preserves = true`: verified
in R8, where plain Esc kills the command). Consumer: the voice hub's barge-in policy.

`foregroundWork` is also needed for the steer branch's holding-line rule. OpenCode 2.x
exposes it as a plain method on its engine, without the soft interrupt.

## Barge-in policy (`voice/barge-in-policy.ts`, pure)

Input: `{ turnRunning, longWork: ForegroundWork | null, ageMs, threshold, soft:
{preserves} | null, steerable, }`. Output: one of `new_turn`, `wait_then_decide(ms)`,
`soft_then_turn`, `steer`, `steer_with_holding`, `queue_with_holding`, `interrupt_now`.

| turnRunning | foreground work | age vs threshold | soft (preserves) | steerable | → |
|---|---|---|---|---|---|
| no | — | — | — | — | `new_turn` |
| yes | yes | younger | — | — | `wait_then_decide(threshold − age)`, then re-evaluate |
| yes | none | — | yes (any) | — | `soft_then_turn` |
| yes | long | — | yes (preserves) | — | `soft_then_turn` |
| yes | long | — | no / not preserving | yes | `steer_with_holding` |
| yes | long | — | no | no | `queue_with_holding` |
| yes | none | — | no | yes | `steer` |
| yes | none | — | no | no | `interrupt_now` (existing `delivery: "now"`) |

Invariant: no output calls `kill` while long work is running.
