import { VOICE_OUTPUT_SAMPLE_RATE } from "@hundredfold/gateway-events"
import { contextFields, voiceLog } from "@/lib/voice-log"
import { int16ToFloat } from "./pcm"

/** The slice of an AudioContext the player uses, so tests can supply a fake clock. */
export interface PlayerAudioNode {
  connect(destination: unknown): unknown
  disconnect(): void
}
export interface PlayerSource extends PlayerAudioNode {
  buffer: unknown
  onended: (() => void) | null
  start(when?: number): void
  stop(when?: number): void
}
export interface PlayerBuffer {
  readonly duration: number
  getChannelData(channel: number): Float32Array
}
export interface PlayerAudioContext {
  readonly currentTime: number
  readonly destination: unknown
  createBuffer(channels: number, length: number, sampleRate: number): PlayerBuffer
  createBufferSource(): PlayerSource
}

/** Where playback was when it was cut. `segmentId` is null when nothing was playing. */
export interface PlaybackCut {
  segmentId: number | null
  playedMs: number
}

export interface VoicePlayerOptions {
  /** A segment finished playing in full, and the gateway said it was complete. */
  onPlayed?(segmentId: number): void
  outputRate?: number
}

interface Segment {
  id: number
  startAt: number | null
  duration: number
  sources: Set<PlayerSource>
  /** `segment_end` arrived: no more audio is coming for it. */
  closed: boolean
  /** Diagnostics only. */
  chunks: number
  samples: number
  underruns: number
  underrunS: number
  /** Silence between the previous audio and this segment's first chunk, in seconds. */
  gapBeforeS: number | null
}

/** A scheduling gap shorter than this is clock rounding, not silence. */
const GAP_EPSILON_S = 0.002
/** Frames still arriving this soon after a flush belong to the reply that was cut. */
const AFTER_FLUSH_MS = 2000

/** Scheduling slack on a cold start, so the first chunk is not late by the time it is scheduled. */
const START_LEAD_S = 0.03

/**
 * Plays the gateway's PCM16 segments through one AudioContext. Chunks are
 * scheduled back to back on the context clock, so playback is gapless and
 * `flush()` is a handful of synchronous `stop()` calls: it takes effect inside
 * the current render quantum, not after a round trip.
 *
 * Audio is only accepted for a segment the gateway opened with
 * `segment_start`. After a flush nothing is open, so frames the gateway had
 * already sent for the interrupted reply are dropped on arrival.
 */
export class VoicePlayer {
  private readonly segments = new Map<number, Segment>()
  private readonly outputRate: number
  private nextStart = 0
  private lastFlushAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly ctx: PlayerAudioContext,
    private readonly options: VoicePlayerOptions = {},
  ) {
    this.outputRate = options.outputRate ?? VOICE_OUTPUT_SAMPLE_RATE
  }

  beginSegment(segmentId: number): void {
    if (this.segments.has(segmentId)) return
    this.segments.set(segmentId, { id: segmentId, startAt: null, duration: 0, sources: new Set(), closed: false, chunks: 0, samples: 0, underruns: 0, underrunS: 0, gapBeforeS: null })
    voiceLog.debug("player_segment_begin", () => ({ segment: segmentId, ...contextFields(this.ctx), queue_ms: this.queuedMs() }))
  }

  enqueue(segmentId: number, pcm: Int16Array): void {
    const segment = this.segments.get(segmentId)
    if (!segment || segment.closed || pcm.length === 0) {
      this.logDropped(segmentId, segment ? (segment.closed ? "closed" : "empty") : "no_segment", pcm.length)
      return
    }
    const buffer = this.ctx.createBuffer(1, pcm.length, this.outputRate)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) channel[i] = int16ToFloat(pcm[i])
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    const now = this.ctx.currentTime
    const at = Math.max(this.nextStart, now + START_LEAD_S)
    this.traceChunk(segment, at, now, pcm.length, buffer.duration)
    segment.startAt ??= at
    segment.duration = at + buffer.duration - segment.startAt
    this.nextStart = at + buffer.duration
    segment.sources.add(source)
    source.onended = () => this.sourceEnded(segment, source)
    source.start(at)
  }

  /** `segment_end`: no more audio for this segment. It reports `played` once its audio has run out. */
  endSegment(segmentId: number): void {
    const segment = this.segments.get(segmentId)
    if (!segment) {
      voiceLog.debug("player_segment_end_unknown", { segment: segmentId })
      return
    }
    segment.closed = true
    this.settle(segment)
  }

  /** True from a segment's start until it has played out or been cut. */
  isActive(): boolean {
    return this.segments.size > 0
  }

  /** The segment under the playhead and how much of it has played. */
  position(): PlaybackCut {
    const now = this.ctx.currentTime
    let current: Segment | null = null
    for (const segment of this.segments.values()) {
      if (segment.startAt !== null && segment.startAt <= now) current = segment
    }
    if (!current || current.startAt === null) return { segmentId: null, playedMs: 0 }
    const playedS = Math.min(now - current.startAt, current.duration)
    return { segmentId: current.id, playedMs: Math.round(Math.max(0, playedS) * 1000) }
  }

  /** Stops everything now. Returns where playback was, or null when nothing was active. */
  flush(): PlaybackCut | null {
    if (this.segments.size === 0) return null
    const cut = this.position()
    this.lastFlushAt = Date.now()
    this.logFlush(cut)
    for (const segment of this.segments.values()) {
      for (const source of segment.sources) {
        source.onended = null
        try { source.stop(0) } catch { /* already stopped */ }
        source.disconnect()
      }
    }
    this.segments.clear()
    this.nextStart = 0
    return cut
  }

  dispose(): void {
    this.flush()
  }

  private sourceEnded(segment: Segment, source: PlayerSource): void {
    segment.sources.delete(source)
    source.disconnect()
    this.settle(segment)
  }

  private settle(segment: Segment): void {
    if (!segment.closed || segment.sources.size > 0) return
    if (this.segments.get(segment.id) !== segment) return
    this.segments.delete(segment.id)
    this.logSegmentDone(segment, "played")
    this.options.onPlayed?.(segment.id)
  }

  // ── diagnostics ───────────────────────────────────────────────────────────

  /** Seconds of audio scheduled but not yet played. */
  private queuedMs(): number {
    return Math.max(0, Math.round((this.nextStart - this.ctx.currentTime) * 1000))
  }

  private traceChunk(segment: Segment, at: number, now: number, samples: number, durationS: number): void {
    segment.chunks += 1
    segment.samples += samples
    const gapS = this.nextStart > 0 ? at - this.nextStart : 0
    if (gapS > GAP_EPSILON_S) {
      if (segment.startAt === null) {
        segment.gapBeforeS = gapS
      } else {
        segment.underruns += 1
        segment.underrunS += gapS
        voiceLog.warn("playback_underrun", { segment: segment.id, chunk: segment.chunks, gap_ms: gapS * 1000, now_s: now, next_start_s: this.nextStart })
      }
    } else if (segment.startAt === null) {
      segment.gapBeforeS = 0
    }
    voiceLog.debug("player_enqueue", () => ({
      segment: segment.id,
      chunk: segment.chunks,
      samples,
      audio_ms: durationS * 1000,
      at_s: at,
      now_s: now,
      lead_ms: (at - now) * 1000,
      queue_ms: Math.max(0, (this.nextStart - now) * 1000),
      ...contextFields(this.ctx),
    }))
  }

  private logDropped(segmentId: number, reason: string, samples: number): void {
    const afterFlush = Date.now() - this.lastFlushAt < AFTER_FLUSH_MS
    // Frames the gateway had already sent for a reply that was just cut are dropped on purpose.
    const level = reason === "no_segment" && afterFlush ? "debug" : "warn"
    voiceLog[level]("player_chunk_dropped", { segment: segmentId, reason, samples, after_flush: afterFlush })
  }

  private logFlush(cut: PlaybackCut): void {
    const now = this.ctx.currentTime
    voiceLog.info("player_flush", {
      segment: cut.segmentId,
      played_ms: cut.playedMs,
      open_segments: this.segments.size,
      discarded_ms: this.queuedMs(),
      now_s: now,
      ...contextFields(this.ctx),
    })
    for (const segment of this.segments.values()) this.logSegmentDone(segment, "cut")
  }

  private logSegmentDone(segment: Segment, outcome: "played" | "cut"): void {
    const now = this.ctx.currentTime
    const expectedEnd = segment.startAt === null ? null : segment.startAt + segment.duration
    voiceLog.info("player_segment_done", {
      segment: segment.id,
      outcome,
      chunks: segment.chunks,
      audio_ms: (segment.samples * 1000) / this.outputRate,
      scheduled_ms: segment.duration * 1000,
      underruns: segment.underruns,
      underrun_ms: segment.underrunS * 1000,
      gap_before_ms: segment.gapBeforeS === null ? null : segment.gapBeforeS * 1000,
      end_skew_ms: outcome === "played" && expectedEnd !== null ? (now - expectedEnd) * 1000 : null,
      closed: segment.closed,
      pending_sources: segment.sources.size,
    })
  }
}
