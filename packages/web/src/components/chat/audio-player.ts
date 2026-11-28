/**
 * Streamed WAV chunk player.
 *
 * Plays audio chunks (a complete WAV per sentence from the local Kokoro TTS
 * backend, for chat read-aloud) IN ARRIVAL ORDER with low latency.
 *
 * Design:
 *  - One shared AudioContext (created lazily, resumed on the first user gesture).
 *  - Each chunk is a SELF-CONTAINED WAV. `seq` is monotonic WITHIN a turn, and
 *    `last:true` rides only the turn's FINAL chunk. We don't gate playback on
 *    `seq` — chunks arrive in order from a single stream, so we play them in
 *    arrival order — but we DO watch `last` to re-arm cleanly at the turn
 *    boundary (a chunk after a `last:true` is turn N+1's first chunk: reset the
 *    drained-run latch and resume a suspended context before scheduling it).
 *  - Decode + schedule is serialized on a promise chain so the moving "playhead"
 *    clock stays correct and chunks are scheduled back-to-back with no gaps,
 *    clicks, or overlaps — regardless of how fast each chunk decodes.
 *  - Every source routes through a single output GainNode → destination.
 *  - `onIdle` fires once the queue fully drains.
 *
 * Decode errors are swallowed per-chunk (we skip the bad chunk) so playback
 * never stalls on one corrupt chunk.
 */

import { contextFields, errorFields, traceContextState, voiceLog, voiceNow } from "@/lib/voice-log"
import { describeWav } from "@/lib/voice/trace"

/** What one playback run did, for the line written when it drains or is cut. Diagnostics only. */
interface RunDiag {
  startedAt: number
  enqueued: number
  scheduled: number
  decodeFailed: number
  stale: number
  audioS: number
  underruns: number
  underrunS: number
  firstPlayMs: number | null
}

function freshRun(): RunDiag {
  return { startedAt: voiceNow(), enqueued: 0, scheduled: 0, decodeFailed: 0, stale: 0, audioS: 0, underruns: 0, underrunS: 0, firstPlayMs: null }
}

/** A hole in the schedule shorter than this is rounding, not an audible gap. */
const GAP_EPSILON_S = 0.005

export class WavChunkPlayer {
  private ctx: AudioContext | null = null
  private outputNode: GainNode | null = null
  /** False when the ctx was supplied externally (shared) — don't close it on dispose. */
  private ownsCtx = true
  /** Fired once when the first buffer of a run actually starts playing. */
  private startCb: (() => void) | null = null
  private startNotified = false

  /**
   * @param externalCtx Optional pre-created (and gesture-resumed) AudioContext to
   *   share — e.g. the chat read-aloud primes one in the click gesture and passes
   *   it here so playback is autoplay-unlocked. When omitted, the player creates
   *   and owns its own context.
   */
  constructor(externalCtx?: AudioContext) {
    if (externalCtx) {
      this.ctx = externalCtx
      this.ownsCtx = false
    }
  }

  /** Serializes decode+schedule so arrival order and the playhead stay correct. */
  private chain: Promise<void> = Promise.resolve()
  /** Have we started a fresh playback run (to anchor the playhead)? */
  private started = false

  /** Absolute AudioContext time at which the next buffer should start. */
  private playhead = 0
  /** Count of buffers currently scheduled / playing. */
  private activeSources = 0
  /**
   * Live references to every scheduled/playing BufferSource so `reset()` can
   * actually halt them. Without this, `source.start(...)` is fire-and-forget and
   * a pause/stop would clear the queue but let already-committed sources play to
   * completion (the "pause keeps playing" bug).
   */
  private liveSources = new Set<AudioBufferSourceNode>()
  /** Chunks accepted but not yet decoded/scheduled (sitting in the chain). */
  private inFlight = 0
  /** True between the first enqueue and the queue fully draining. */
  private _playing = false
  /** Set when a `last:true` frame is accepted; the next frame re-arms a fresh run. */
  private ended = false

  private idleCb: (() => void) | null = null

  private run: RunDiag = freshRun()
  /** Bumped by `reset()`; a decode that started under an older value outlived the reset. */
  private resetGen = 0
  private stopContextTrace: (() => void) | null = null

  /** Lazily build the output graph (on a supplied or freshly-created context). */
  private ensureContext(): AudioContext {
    if (this.ctx && this.outputNode) return this.ctx
    const Ctor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    const ctx = this.ctx ?? new Ctor()
    const gain = ctx.createGain()
    gain.gain.value = 1
    // graph: source -> gain -> destination
    gain.connect(ctx.destination)
    this.ctx = ctx
    this.outputNode = gain
    voiceLog.info("wav_context_ready", { owned: this.ownsCtx, ...contextFields(ctx) })
    this.stopContextTrace = traceContextState(ctx, "read_aloud")
    return ctx
  }

  /**
   * Resume the AudioContext. Must be called from a user gesture (e.g. mic click)
   * so browsers permit playback. Safe to call repeatedly. Returns a promise that
   * settles when the context is running (callers may ignore it).
   */
  resume(): Promise<void> {
    const ctx = this.ensureContext()
    if (ctx.state !== "suspended") return Promise.resolve()
    const at = voiceNow()
    voiceLog.info("wav_resume_from_gesture", { ...contextFields(ctx) })
    const resumed = ctx.resume()
    resumed.then(
      () => voiceLog.info("wav_resumed", { wait_ms: voiceNow() - at, ...contextFields(ctx) }),
      (error: unknown) => voiceLog.warn("wav_resume_failed", { wait_ms: voiceNow() - at, ...errorFields(error), ...contextFields(ctx) }),
    )
    return resumed
  }

  /** Resume a suspended context, awaiting it — used inside the schedule chain. */
  private async ensureResumed(): Promise<void> {
    const ctx = this.ctx
    if (ctx && ctx.state === "suspended") {
      const at = voiceNow()
      try {
        await ctx.resume()
        voiceLog.info("wav_resumed_in_chain", { wait_ms: voiceNow() - at, ...contextFields(ctx) })
      } catch (error) {
        voiceLog.warn("wav_resume_failed", { in_chain: true, wait_ms: voiceNow() - at, ...errorFields(error), ...contextFields(ctx) })
        /* a failed resume must not stall the chain — scheduling will no-op safely */
      }
    }
  }

  /**
   * Enqueue a standalone WAV chunk. Chunks play in ARRIVAL ORDER (see the file
   * header). `last` marks the final frame of a turn; the FIRST frame after a
   * `last` re-arms a fresh playback run so a later turn is never stuck behind
   * the previous turn's drained/suspended state. Decode+schedule is serialized
   * so timing stays correct.
   */
  enqueueBuffer(data: ArrayBuffer, last = false): void {
    this.ensureContext()
    // A frame after a completed turn (`last:true`) is the next turn's first
    // frame: re-arm so the playhead re-anchors and a suspended context resumes.
    if (this.ended) {
      this.ended = false
      this.started = false
      this.startNotified = false
    }

    this._playing = true
    if (last) this.ended = true

    this.inFlight++
    if (this.run.enqueued === 0) this.run.startedAt = voiceNow()
    this.run.enqueued += 1
    const gen = this.resetGen
    voiceLog.debug("wav_enqueue", () => ({ n: this.run.enqueued, bytes: data.byteLength, last, in_flight: this.inFlight, active: this.activeSources, ...contextFields(this.ctx) }))
    // Resume BEFORE scheduling (awaited): a browser may have auto-suspended the
    // context after the previous turn drained; a fire-and-forget resume would let
    // source.start() race a still-suspended clock and the turn plays silently
    // until the next user gesture. Anchoring the playhead is deferred to the
    // schedule step so it reads a live (resumed) currentTime, not a frozen one.
    this.chain = this.chain
      .then(() => this.ensureResumed())
      .then(() => this.decodeAndSchedule(data, gen))
  }

  /** Register a callback fired once when the first buffer of a run starts playing. */
  onStart(cb: () => void): void {
    this.startCb = cb
  }

  private async decodeAndSchedule(data: ArrayBuffer, gen: number): Promise<void> {
    const ctx = this.ctx
    const output = this.outputNode
    this.noteIfStale(data, gen)
    if (!ctx || !output) {
      this.inFlight = Math.max(0, this.inFlight - 1)
      return
    }

    let buffer: AudioBuffer
    const decodeStart = voiceNow()
    try {
      // decodeAudioData consumes the ArrayBuffer; slice keeps callers safe.
      buffer = await ctx.decodeAudioData(data.slice(0))
    } catch (error) {
      // Corrupt/unsupported chunk — skip it; the queue keeps flowing.
      this.noteDecodeFailed(data, decodeStart, error)
      this.inFlight = Math.max(0, this.inFlight - 1)
      this.checkIdle()
      return
    }

    // Anchor the playhead on the first scheduled frame of a run, AFTER the
    // context has resumed (currentTime is frozen while a context is suspended).
    if (!this.started) {
      this.started = true
      this.playhead = ctx.currentTime
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(output)

    // Schedule back-to-back. If we've fallen behind (playhead in the past),
    // catch up to "now" to avoid scheduling in the past.
    const now = ctx.currentTime
    const startAt = Math.max(this.playhead, now)
    this.traceSchedule(buffer, startAt, now, voiceNow() - decodeStart)
    this.playhead = startAt + buffer.duration

    this.activeSources++
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.liveSources.add(source)
    source.onended = () => this.sourceEnded(ctx, source)
    source.start(startAt)
    if (!this.startNotified) {
      this.startNotified = true
      this.startCb?.()
    }
  }

  private sourceEnded(ctx: AudioContext, source: AudioBufferSourceNode): void {
    this.liveSources.delete(source)
    this.activeSources--
    voiceLog.debug("wav_source_ended", { active: this.activeSources, in_flight: this.inFlight, now_s: ctx.currentTime })
    this.checkIdle()
  }

  private checkIdle(): void {
    // Idle only when nothing is playing AND nothing is still queued to decode.
    if (this.activeSources <= 0 && this.inFlight <= 0) {
      this.logRun("drained")
      this.run = freshRun()
      this._playing = false
      this.started = false
      const cb = this.idleCb
      if (cb) cb()
    }
  }

  /** True while audio is queued or playing. */
  get playing(): boolean {
    return this._playing
  }

  /** Register a callback fired each time the queue fully drains. */
  onIdle(cb: () => void): void {
    this.idleCb = cb
  }

  /**
   * Drop all queued audio and reset ordering state (e.g. on cancel / unmount /
   * read-aloud pause). Halts any source that's already scheduled or playing —
   * not just future enqueues — so pause/stop is immediate and silent.
   */
  reset(): void {
    if (this._playing || this.liveSources.size > 0 || this.inFlight > 0) this.logRun("reset")
    this.resetGen += 1
    this.stopLiveSources()
    // Abandon the in-flight decode chain; future enqueues start a fresh chain.
    this.chain = Promise.resolve()
    this.started = false
    this.startNotified = false
    this.inFlight = 0
    this._playing = false
    this.activeSources = 0
    this.ended = false
    if (this.ctx) this.playhead = this.ctx.currentTime
    this.run = freshRun()
  }

  /**
   * Immediately stop every scheduled/playing source. We null `onended` first so
   * the stop()-triggered callback doesn't run the activeSources/idle bookkeeping
   * (we've already zeroed it in reset), then `stop()` + `disconnect()` each one.
   */
  private stopLiveSources(): void {
    for (const source of this.liveSources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        /* not yet started, or already stopped — fine */
      }
      try {
        source.disconnect()
      } catch {
        /* best effort */
      }
    }
    this.liveSources.clear()
  }

  /** Fully tear down the AudioContext. Call on unmount. */
  dispose(): void {
    this.reset()
    this.stopContextTrace?.()
    this.stopContextTrace = null
    this.idleCb = null
    this.startCb = null
    const ctx = this.ctx
    const owns = this.ownsCtx
    this.ctx = null
    this.outputNode = null
    // Only close a context we created — a shared/external one belongs to the caller.
    if (owns && ctx && ctx.state !== "closed") void ctx.close().catch(() => {})
  }

  // ── diagnostics ───────────────────────────────────────────────────────────

  /** The chain a reset abandons still runs; say so when one of its chunks gets this far. */
  private noteIfStale(data: ArrayBuffer, gen: number): void {
    if (gen === this.resetGen) return
    this.run.stale += 1
    voiceLog.warn("wav_stale_chunk", { bytes: data.byteLength, enqueued_under: gen, now_gen: this.resetGen, has_ctx: Boolean(this.ctx) })
  }

  private noteDecodeFailed(data: ArrayBuffer, decodeStart: number, error: unknown): void {
    this.run.decodeFailed += 1
    voiceLog.warn("wav_decode_failed", { bytes: data.byteLength, decode_ms: voiceNow() - decodeStart, ...errorFields(error), ...describeWav(data) })
  }

  private traceSchedule(buffer: AudioBuffer, startAt: number, now: number, decodeMs: number): void {
    const run = this.run
    run.scheduled += 1
    run.audioS += buffer.duration
    const gapS = this.started && run.scheduled > 1 ? startAt - this.playhead : 0
    if (gapS > GAP_EPSILON_S) {
      run.underruns += 1
      run.underrunS += gapS
      voiceLog.warn("wav_underrun", { chunk: run.scheduled, gap_ms: gapS * 1000, now_s: now, playhead_s: this.playhead })
    }
    if (run.firstPlayMs === null) {
      run.firstPlayMs = voiceNow() - run.startedAt
      voiceLog.info("wav_first_chunk", { since_enqueue_ms: run.firstPlayMs, decode_ms: decodeMs, rate: buffer.sampleRate, channels: buffer.numberOfChannels, audio_ms: buffer.duration * 1000 })
    }
    voiceLog.debug("wav_schedule", () => ({ chunk: run.scheduled, decode_ms: decodeMs, audio_ms: buffer.duration * 1000, rate: buffer.sampleRate, channels: buffer.numberOfChannels, start_s: startAt, now_s: now, lead_ms: (startAt - now) * 1000, in_flight: this.inFlight, ...contextFields(this.ctx) }))
  }

  private logRun(how: "drained" | "reset"): void {
    const run = this.run
    voiceLog.info("wav_run", {
      outcome: how,
      enqueued: run.enqueued,
      scheduled: run.scheduled,
      decode_failed: run.decodeFailed,
      stale: run.stale,
      audio_ms: run.audioS * 1000,
      underruns: run.underruns,
      underrun_ms: run.underrunS * 1000,
      first_chunk_ms: run.firstPlayMs,
      run_ms: voiceNow() - run.startedAt,
      pending_sources: this.liveSources.size,
      in_flight: this.inFlight,
    })
  }
}
