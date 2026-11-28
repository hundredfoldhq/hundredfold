/**
 * Server-side TTS synthesis for chat read-aloud (POST/GET /api/tts).
 *
 * Validates and bounds request text, synthesizes it either whole or
 * sentence-by-sentence for fast time-to-first-audio, and reports engine
 * readiness. The Kokoro engine is a process-wide singleton so there is
 * exactly one sidecar.
 */
import { logger } from "../shared/logger.js";
import { traceLine } from "../voice/trace.js";
import { createKokoroTts } from "./kokoro.js";
import type { Tts } from "./protocol.js";
import { wavFacts } from "./wav-facts.js";

type KokoroOpts = Parameters<typeof createKokoroTts>[0];

let engine: Tts | null = null;

/** The shared Kokoro engine (lazily constructed with the live config). */
export function getTts(opts?: KokoroOpts): Tts {
  if (!engine) engine = createKokoroTts(opts);
  return engine;
}

/** Test seam: swap the singleton for a mock. */
export function __setTtsForTest(tts: Tts | null): void {
  engine = tts;
}

/**
 * Max characters accepted by POST /api/tts in a single read-aloud call. Bounds
 * the sidecar's synth time and the WAV response size (≈ a few minutes of audio).
 */
export const TTS_MAX_CHARS = 8000;

/**
 * Validate + bound the `text` field of a POST /api/tts request. Trims, rejects
 * non-strings and empties, and caps over-long input at the last sentence/space
 * boundary before the limit so a word is never cut mid-token. Pure — unit-tested.
 */
export function validateTtsText(
  raw: unknown,
  maxChars = TTS_MAX_CHARS,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "text must be a string" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "text must be a non-empty string" };
  if (trimmed.length <= maxChars) return { ok: true, text: trimmed };
  const head = trimmed.slice(0, maxChars);
  // Prefer a clean cut at a sentence/newline/space boundary in the back half of
  // the window; if none (e.g. one giant token), hard-slice at the cap.
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"), head.lastIndexOf(" "));
  const text = (boundary > maxChars / 2 ? head.slice(0, boundary + 1) : head).trim();
  return { ok: true, text };
}

/**
 * Standalone one-shot synthesis for POST /api/tts: returns a single WAV buffer
 * for the whole text. Reuses the shared Kokoro engine; rejects when unavailable.
 */
export async function synthesizeText(text: string, opts?: KokoroOpts): Promise<Buffer> {
  return getTts(opts).synthesize(text);
}

/** TTS engine readiness for GET /api/tts — no synth, no sidecar spawn. */
export function ttsStatus(opts?: KokoroOpts): { available: boolean; voice: string } {
  const s = getTts(opts).status();
  return { available: s.available, voice: s.voice };
}

/**
 * Split already-markdown-stripped prose into sentence-sized chunks for streamed
 * read-aloud. Splits on sentence terminators (followed by whitespace) AND on
 * newlines (list items / paragraphs), collapsing inner whitespace and dropping
 * empties. Pure — unit-tested. Text with no terminator stays one chunk.
 */
export function splitTtsSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

/**
 * Synthesize `text` sentence-by-sentence, invoking `onFrame` with each sentence's
 * WAV as soon as it's ready — so the client can PLAY sentence 1 while 2..N are
 * still synthesizing (time-to-first-audio ≈ one sentence, not the whole message).
 *
 * Kokoro is one-request-at-a-time, so synthesis is naturally sequential; that's
 * fine since playback is sequential too. `isCancelled` is checked before and
 * after each synth so a paused/aborted client stops further synthesis promptly
 * (we don't keep synthesizing a message nobody is listening to). Resolves with
 * the number of frames emitted.
 */
export async function streamTtsSentences(
  text: string,
  opts: KokoroOpts | undefined,
  onFrame: (wav: Buffer) => void,
  isCancelled: () => boolean,
  requestId?: string,
): Promise<number> {
  const sentences = splitTtsSentences(text);
  const startedAt = Date.now();
  const id = requestId ?? "-";
  logger.info(traceLine("tts_stream_start", { req: id, chars: text.length, sentences: sentences.length }));
  let count = 0;
  for (const sentence of sentences) {
    if (isCancelled()) {
      logger.info(traceLine("tts_stream_cancelled", { req: id, before: "synth", sentence: count + 1, sentences: sentences.length, frames: count, ms: Date.now() - startedAt }));
      return count;
    }
    const synthStartedAt = Date.now();
    const wav = await getTts(opts).synthesize(sentence);
    const synthMs = Date.now() - synthStartedAt;
    if (isCancelled()) {
      logger.info(traceLine("tts_stream_cancelled", { req: id, before: "send", sentence: count + 1, sentences: sentences.length, frames: count, synth_ms: synthMs, ms: Date.now() - startedAt }));
      return count;
    }
    onFrame(wav);
    count++;
    logger.info(traceLine("tts_stream_frame", { req: id, n: count, of: sentences.length, chars: sentence.length, synth_ms: synthMs, since_start_ms: Date.now() - startedAt, ...wavFacts(wav) }));
  }
  logger.info(traceLine("tts_stream_end", { req: id, frames: count, sentences: sentences.length, ms: Date.now() - startedAt }));
  return count;
}
