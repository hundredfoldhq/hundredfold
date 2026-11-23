/**
 * TTS engine contract.
 *
 * The shared type for Kokoro speech synthesis, implemented by kokoro.ts and
 * consumed by tts-stream.ts. Nothing else lives here.
 */

/** Kokoro-82M TTS engine (sidecar-backed). Implemented by kokoro.ts. */
export interface Tts {
  /**
   * One-shot synthesis of arbitrary `text` into a single WAV buffer. Backs the
   * POST /api/tts read-aloud surface. Rejects if the engine is unavailable
   * (missing venv/weights).
   */
  synthesize(text: string): Promise<Buffer>
  status(): { available: boolean; voice: string; ready: boolean }
  /** Pre-spawn the sidecar and load the model so the first real synth is fast. No-op if weights/venv are missing. */
  warm?(): Promise<void>
  shutdown(): void
}
