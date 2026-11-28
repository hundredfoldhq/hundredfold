/**
 * Read-aloud playback engine — the real `TtsStart` for the chat TTS controller.
 *
 * Latency model: the server STREAMS one WAV frame per sentence (POST /api/tts,
 * length-prefixed frames). We start playing sentence 1 the moment it arrives while
 * 2..N are still synthesizing → time-to-first-audio ≈ one sentence, independent of
 * message length. Playback uses a gapless sequential queue
 * (WavChunkPlayer), fed binary buffers as frames decode.
 *
 * Strategy per message:
 *   1. Prime audio SYNCHRONOUSLY (resume the shared player's AudioContext) inside
 *      the click gesture — this is what lets the browser's autoplay policy permit
 *      playback after the async stream begins. (The original "stuck loading, no
 *      sound" bug was play() called outside the gesture window.)
 *   2. Strip markdown so we speak clean prose.
 *   3. Prefer Kokoro: open the streaming POST, decode each sentence frame, enqueue
 *      it on the gapless player. Availability is probed once (GET /api/tts, cached)
 *      so we pick the browser fallback WITHOUT a failed POST.
 *   4. Fall back to browser Web Speech (speechSynthesis) when Kokoro is unavailable
 *      OR the stream fails before any audio. It streams naturally.
 *
 * All browser touchpoints (fetch / AudioContext / speechSynthesis) are injected so
 * the streaming, ordering, and fallback logic is unit-testable without a DOM.
 */
import { stripMarkdown } from "@/lib/strip-markdown"
import { authFetch } from "@/lib/auth"
import { WavChunkPlayer } from "@/components/chat/audio-player"
import { errorFields, voiceLog, voiceNow } from "@/lib/voice-log"
import { TtsStreamTrace } from "./tts-stream-trace"
import type { TtsStart, TtsStartCallbacks } from "./tts-controller"

/** Numbers each read-aloud request so the lines of one message can be told apart. Diagnostics only. */
let requestCounter = 0
let activeRequest = 0

/** A gapless, ordered WAV-chunk player (subset of WavChunkPlayer we depend on). */
export interface StreamPlayer {
  enqueueBuffer(data: ArrayBuffer): void
  onStart(cb: () => void): void
  onIdle(cb: () => void): void
  reset(): void
  readonly playing: boolean
}

export interface TtsEngineDeps {
  /** Probe whether the custom (Kokoro) TTS is available. Cached by the caller. */
  checkAvailable: () => Promise<boolean>
  /** Open the streaming synth; resolve with the framed byte stream, reject on failure. */
  openStream: (text: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>
  /** Get the (reset) shared sequential player. */
  getPlayer: () => StreamPlayer
  /** Browser Web Speech fallback; returns a stop() handle. */
  speak: (text: string, cbs: TtsStartCallbacks) => () => void
  /** Synchronous gesture-time unlock (resume the shared AudioContext). */
  primeAudio?: () => void
}

const NOOP = () => {}

/**
 * Parse a length-prefixed frame stream: each frame is a 4-byte big-endian length
 * followed by that many bytes. `push` returns whatever complete frames are now
 * available; partial frames are buffered until the rest arrives. Pure (testable).
 */
export function createFrameReader(): { push: (chunk: Uint8Array) => ArrayBuffer[] } {
  let buf = new Uint8Array(0)
  return {
    push(chunk: Uint8Array): ArrayBuffer[] {
      const merged = new Uint8Array(buf.length + chunk.length)
      merged.set(buf)
      merged.set(chunk, buf.length)
      buf = merged
      const frames: ArrayBuffer[] = []
      for (;;) {
        if (buf.length < 4) break
        const len = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0
        if (buf.length < 4 + len) break
        // slice() copies into a fresh, exactly-sized buffer (safe for decodeAudioData).
        frames.push(buf.slice(4, 4 + len).buffer)
        buf = buf.slice(4 + len)
      }
      return frames
    },
  }
}

/** Build a `TtsStart` from injected playback dependencies. */
export function createTtsStart(deps: TtsEngineDeps): TtsStart {
  return async (raw, cbs) => {
    const req = ++requestCounter
    activeRequest = req
    const requestedAt = voiceNow()
    // MUST be first — runs in the click gesture's synchronous stack so the browser
    // unlocks audio for the streamed playback that begins after the fetch resolves.
    deps.primeAudio?.()

    const text = stripMarkdown(raw).trim()
    voiceLog.info("tts_request", { req, raw_chars: raw.length, text_chars: text.length })
    if (!text) {
      voiceLog.info("tts_nothing_to_speak", { req })
      cbs.onEnd() // nothing speakable (media-/code-only message) — end cleanly
      return NOOP
    }

    let available = false
    try {
      available = await deps.checkAvailable()
    } catch {
      available = false
    }
    voiceLog.info("tts_backend", { req, kokoro_available: available, since_request_ms: voiceNow() - requestedAt })

    if (available) {
      try {
        // openStream rejects on 503 / network error → fall through to Web Speech.
        return await playKokoroStream(deps, text, cbs, req, requestedAt)
      } catch (error) {
        voiceLog.warn("tts_stream_open_failed", { req, since_request_ms: voiceNow() - requestedAt, ...errorFields(error) })
        /* Kokoro unavailable / connection failed at call time → browser fallback */
      }
    }

    voiceLog.info("tts_fallback_speech_synthesis", { req, reason: available ? "stream_open_failed" : "kokoro_unavailable" })
    return deps.speak(text, cbs)
  }
}

/**
 * Stream Kokoro audio: pump framed WAV chunks into the gapless player as they
 * arrive. Resolves (with a stop handle) once the stream is open; playback proceeds
 * in the background. stop() aborts the fetch — which cancels server-side synthesis
 * of the remaining sentences — and clears the queue.
 */
async function playKokoroStream(
  deps: TtsEngineDeps,
  text: string,
  cbs: TtsStartCallbacks,
  req = 0,
  requestedAt = voiceNow(),
): Promise<() => void> {
  const ac = new AbortController()
  const stream = await deps.openStream(text, ac.signal) // may throw → caller falls back
  const streamOpenAt = voiceNow()
  voiceLog.info("tts_stream_open", { req, since_request_ms: streamOpenAt - requestedAt })
  const player = deps.getPlayer()

  let started = false
  let streamDone = false
  let stopped = false
  let frames = 0
  const trace = new TtsStreamTrace(req, requestedAt, streamOpenAt)

  player.onStart(() => {
    trace.playerStarted(stopped)
    if (!started && !stopped) {
      started = true
      cbs.onPlaying()
    }
  })
  player.onIdle(() => {
    trace.idle(streamDone, started, stopped)
    if (streamDone && started && !stopped) cbs.onEnd()
  })

  // Background pump — read frames and enqueue them; never blocks the returned stop.
  void (async () => {
    const reader = stream.getReader()
    const parser = createFrameReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          trace.read(value.length)
          for (const wav of parser.push(value)) {
            frames++
            trace.frame(wav)
            player.enqueueBuffer(wav)
          }
        }
      }
    } catch (error) {
      trace.failed(error, stopped)
      /* aborted (pause) or network drop — fall through to settle below */
    } finally {
      trace.ended(stopped, player.playing)
      streamDone = true
      if (!stopped) {
        if (frames === 0) {
          cbs.onError() // produced no audio at all → controller resets to idle
        } else if (started && !player.playing) {
          cbs.onEnd() // already drained before the stream finished reading
        }
        // else: onIdle will fire onEnd when the queue drains
      }
    }
  })()

  return () => {
    trace.stopRequested(streamDone, started)
    stopped = true
    ac.abort() // cancels in-flight server synthesis of the remaining sentences
    player.reset()
  }
}

/* ── Default browser-backed dependencies ─────────────────────────────────── */

let availabilityPromise: Promise<boolean> | null = null

/** GET /api/tts once and cache the answer for the page lifetime. */
function checkAvailable(): Promise<boolean> {
  if (!availabilityPromise) {
    const at = voiceNow()
    availabilityPromise = authFetch("/api/tts")
      .then((r) => {
        voiceLog.info("tts_availability_probe", { status: r.status, ok: r.ok, ms: voiceNow() - at })
        return r.ok ? (r.json() as Promise<{ available?: boolean }>) : { available: false }
      })
      .then((d) => !!d.available)
      .catch((error: unknown) => {
        voiceLog.warn("tts_availability_probe_failed", { ms: voiceNow() - at, ...errorFields(error) })
        return false
      })
  }
  return availabilityPromise
}

async function openStream(text: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const at = voiceNow()
  const req = activeRequest
  voiceLog.info("tts_fetch", { req, method: "POST", path: "/api/tts", text_chars: text.length })
  const r = await authFetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  })
  voiceLog[r.ok && r.body ? "info" : "warn"]("tts_response", () => ({
    req,
    status: r.status,
    ok: r.ok,
    has_body: Boolean(r.body),
    content_type: r.headers?.get("content-type") ?? undefined,
    content_length: r.headers?.get("content-length") ?? undefined,
    content_encoding: r.headers?.get("content-encoding") ?? undefined,
    headers_ms: voiceNow() - at,
  }))
  if (!r.ok || !r.body) throw new Error(`tts ${r.status}`)
  return r.body
}

/* One shared player so priming on the click unlocks playback for every message. */
let sharedPlayer: WavChunkPlayer | null = null

function getPlayerInstance(): WavChunkPlayer | null {
  if (typeof window === "undefined") return null
  const hasAudio =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!hasAudio) return null
  if (!sharedPlayer) sharedPlayer = new WavChunkPlayer()
  return sharedPlayer
}

/** Resume the player's AudioContext from within the user gesture (autoplay unlock). */
function primeAudio(): void {
  getPlayerInstance()?.resume()
}

function getPlayer(): StreamPlayer {
  const p = getPlayerInstance()
  if (!p) throw new Error("AudioContext unavailable") // → caller falls back to Web Speech
  p.reset() // clear any prior message's queue (single-active)
  return p
}

function speak(text: string, { onPlaying, onEnd, onError }: TtsStartCallbacks): () => void {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    onError()
    return NOOP
  }
  const utt = new SpeechSynthesisUtterance(text)
  const startedAt = voiceNow()
  let spokeAt: number | null = null
  voiceLog.info("speech_synthesis_speak", () => ({ chars: text.length, pending: synth.pending, speaking: synth.speaking, voices: synth.getVoices?.().length }))
  utt.onstart = () => {
    spokeAt = voiceNow()
    voiceLog.info("speech_synthesis_start", { start_ms: spokeAt - startedAt })
    onPlaying()
  }
  utt.onend = () => {
    voiceLog.info("speech_synthesis_end", { chars: text.length, spoke_ms: spokeAt === null ? null : voiceNow() - spokeAt })
    onEnd()
  }
  utt.onerror = (event) => {
    voiceLog.warn("speech_synthesis_error", () => ({ error: (event as SpeechSynthesisErrorEvent | undefined)?.error, spoke_ms: spokeAt === null ? null : voiceNow() - spokeAt, chars: text.length }))
    onError()
  }
  synth.cancel() // clear any queued/leftover speech first
  synth.speak(utt)
  return () => {
    voiceLog.info("speech_synthesis_stop", { spoke_ms: spokeAt === null ? null : voiceNow() - spokeAt })
    // cancel() may fire a late onend/onerror — the controller's generation guard
    // ignores those, so stop() is safe to call here.
    synth.cancel()
  }
}

/** Production dependencies (browser fetch + shared AudioContext player + Web Speech). */
export function defaultTtsDeps(): TtsEngineDeps {
  return { checkAvailable, openStream, getPlayer, speak, primeAudio }
}
