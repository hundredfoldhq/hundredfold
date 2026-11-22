import { VOICE_OUTPUT_SAMPLE_RATE } from "@hundredfold/gateway-events"
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
}

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

  constructor(
    private readonly ctx: PlayerAudioContext,
    private readonly options: VoicePlayerOptions = {},
  ) {
    this.outputRate = options.outputRate ?? VOICE_OUTPUT_SAMPLE_RATE
  }

  beginSegment(segmentId: number): void {
    if (this.segments.has(segmentId)) return
    this.segments.set(segmentId, { id: segmentId, startAt: null, duration: 0, sources: new Set(), closed: false })
  }

  enqueue(segmentId: number, pcm: Int16Array): void {
    const segment = this.segments.get(segmentId)
    if (!segment || segment.closed || pcm.length === 0) return
    const buffer = this.ctx.createBuffer(1, pcm.length, this.outputRate)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) channel[i] = int16ToFloat(pcm[i])
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    const at = Math.max(this.nextStart, this.ctx.currentTime + START_LEAD_S)
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
    if (!segment) return
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
    this.options.onPlayed?.(segment.id)
  }
}
