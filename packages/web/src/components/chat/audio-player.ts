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
    return ctx
  }

  /**
   * Resume the AudioContext. Must be called from a user gesture (e.g. mic click)
   * so browsers permit playback. Safe to call repeatedly. Returns a promise that
   * settles when the context is running (callers may ignore it).
   */
  resume(): Promise<void> {
    const ctx = this.ensureContext()
    return ctx.state === "suspended" ? ctx.resume() : Promise.resolve()
  }

  /** Resume a suspended context, awaiting it — used inside the schedule chain. */
  private async ensureResumed(): Promise<void> {
    const ctx = this.ctx
    if (ctx && ctx.state === "suspended") {
      try {
        await ctx.resume()
      } catch {
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
    // Resume BEFORE scheduling (awaited): a browser may have auto-suspended the
    // context after the previous turn drained; a fire-and-forget resume would let
    // source.start() race a still-suspended clock and the turn plays silently
    // until the next user gesture. Anchoring the playhead is deferred to the
    // schedule step so it reads a live (resumed) currentTime, not a frozen one.
    this.chain = this.chain
      .then(() => this.ensureResumed())
      .then(() => this.decodeAndSchedule(data))
  }

  /** Register a callback fired once when the first buffer of a run starts playing. */
  onStart(cb: () => void): void {
    this.startCb = cb
  }

  private async decodeAndSchedule(data: ArrayBuffer): Promise<void> {
    const ctx = this.ctx
    const output = this.outputNode
    if (!ctx || !output) {
      this.inFlight = Math.max(0, this.inFlight - 1)
      return
    }

    let buffer: AudioBuffer
    try {
      // decodeAudioData consumes the ArrayBuffer; slice keeps callers safe.
      buffer = await ctx.decodeAudioData(data.slice(0))
    } catch {
      // Corrupt/unsupported chunk — skip it; the queue keeps flowing.
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
    this.playhead = startAt + buffer.duration

    this.activeSources++
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.liveSources.add(source)
    source.onended = () => {
      this.liveSources.delete(source)
      this.activeSources--
      this.checkIdle()
    }
    source.start(startAt)
    if (!this.startNotified) {
      this.startNotified = true
      this.startCb?.()
    }
  }

  private checkIdle(): void {
    // Idle only when nothing is playing AND nothing is still queued to decode.
    if (this.activeSources <= 0 && this.inFlight <= 0) {
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
    this.idleCb = null
    this.startCb = null
    const ctx = this.ctx
    const owns = this.ownsCtx
    this.ctx = null
    this.outputNode = null
    // Only close a context we created — a shared/external one belongs to the caller.
    if (owns && ctx && ctx.state !== "closed") void ctx.close().catch(() => {})
  }
}
