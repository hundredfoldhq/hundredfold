/**
 * Diagnostics for one streamed read-aloud request: what came over the wire,
 * how it split into WAV frames, and how the stream ended. A stream that ends
 * mid-frame or drops half way plays as a message that stops short, and nothing
 * else says so, so each of those is written down here. Logging only.
 */
import { errorFields, voiceLog, voiceNow } from "@/lib/voice-log"
import { describeWav } from "@/lib/voice/trace"

export class TtsStreamTrace {
  frames = 0
  bytes = 0
  private framedBytes = 0
  private reads = 0
  private badFrames = 0
  private endedBy: "done" | "error" = "done"
  private firstByteMs: number | null = null
  private lastReadAt: number
  private maxReadGapMs = 0

  constructor(
    private readonly req: number,
    private readonly requestedAt: number,
    private readonly openedAt: number,
  ) {
    this.lastReadAt = openedAt
  }

  /** One read from the response body. */
  read(length: number): void {
    const at = voiceNow()
    this.reads += 1
    this.bytes += length
    const gap = at - this.lastReadAt
    this.maxReadGapMs = Math.max(this.maxReadGapMs, gap)
    this.lastReadAt = at
    if (this.firstByteMs === null) {
      this.firstByteMs = at - this.requestedAt
      voiceLog.info("tts_first_byte", { req: this.req, since_request_ms: this.firstByteMs, since_open_ms: at - this.openedAt, bytes: length })
    }
    voiceLog.debug("tts_read", { req: this.req, read: this.reads, bytes: length, total_bytes: this.bytes, gap_ms: gap })
  }

  /** One whole frame parsed out of the body, before it is queued. */
  frame(wav: ArrayBuffer): void {
    this.frames += 1
    this.framedBytes += 4 + wav.byteLength
    const facts = describeWav(wav)
    if (facts.problem) {
      this.badFrames += 1
      voiceLog.warn("tts_frame_bad", { req: this.req, frame: this.frames, ...facts })
    } else if (this.frames === 1) {
      voiceLog.info("tts_first_frame", { req: this.req, since_request_ms: voiceNow() - this.requestedAt, ...facts })
    } else {
      voiceLog.debug("tts_frame", { req: this.req, frame: this.frames, ...facts })
    }
  }

  /** The read loop threw. An abort is the listener pausing; anything else is a dropped connection. */
  failed(error: unknown, stopped: boolean): void {
    this.endedBy = "error"
    voiceLog[stopped ? "info" : "warn"]("tts_stream_error", { req: this.req, aborted: stopped, frames: this.frames, bytes: this.bytes, ...errorFields(error) })
  }

  /** The loop is over. Bytes read but never part of a whole frame are the tail of a frame that was cut off. */
  ended(stopped: boolean, playing: boolean): void {
    const leftover = this.bytes - this.framedBytes
    const level = leftover > 0 || (this.endedBy === "error" && !stopped) ? "warn" : "info"
    voiceLog[level]("tts_stream_end", {
      req: this.req,
      ended_by: this.endedBy,
      stopped,
      frames: this.frames,
      bad_frames: this.badFrames,
      reads: this.reads,
      bytes: this.bytes,
      leftover_bytes: leftover,
      first_byte_ms: this.firstByteMs,
      max_read_gap_ms: this.maxReadGapMs,
      total_ms: voiceNow() - this.requestedAt,
      player_playing: playing,
    })
  }

  /** The player ran dry. Before the stream finished, that is a gap the listener hears. */
  idle(streamDone: boolean, started: boolean, stopped: boolean): void {
    voiceLog[streamDone ? "info" : "warn"]("tts_player_idle", { req: this.req, stream_done: streamDone, started, stopped, frames: this.frames, since_request_ms: voiceNow() - this.requestedAt })
  }

  playerStarted(stopped: boolean): void {
    voiceLog.info("tts_player_started", { req: this.req, since_request_ms: voiceNow() - this.requestedAt, frames: this.frames, stopped })
  }

  stopRequested(streamDone: boolean, started: boolean): void {
    voiceLog.info("tts_stop", { req: this.req, frames: this.frames, bytes: this.bytes, stream_done: streamDone, started, total_ms: voiceNow() - this.requestedAt })
  }
}
