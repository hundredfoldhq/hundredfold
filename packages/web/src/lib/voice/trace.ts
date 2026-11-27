/**
 * Pure bookkeeping behind the voice diagnostics: sequence tracking for the
 * downstream audio frames, a per-segment tally that becomes one summary line,
 * capture cadence, and field extraction for frames and WAV headers. Nothing
 * here logs or touches the browser, so it can be tested directly.
 */
import type { VoiceServerFrame } from "@hundredfold/gateway-events"
import type { VoiceLogFields } from "@/lib/voice-log"

const SEQ_MODULUS = 0x1_0000

export type SeqStep =
  | { kind: "first" }
  | { kind: "ok" }
  | { kind: "gap"; missing: number }
  | { kind: "duplicate" }
  | { kind: "reorder"; behind: number }

/**
 * The gateway numbers audio frames with a 16-bit counter that wraps. A step of
 * one is in order, a larger forward step is `missing` lost frames, zero is a
 * repeat and a step that lands in the upper half of the range is a frame that
 * arrived after one numbered later.
 */
export class SeqTracker {
  private last: number | null = null

  next(seq: number): SeqStep {
    const previous = this.last
    this.last = seq
    if (previous === null) return { kind: "first" }
    const step = (seq - previous + SEQ_MODULUS) % SEQ_MODULUS
    if (step === 1) return { kind: "ok" }
    if (step === 0) return { kind: "duplicate" }
    if (step < SEQ_MODULUS / 2) return { kind: "gap", missing: step - 1 }
    return { kind: "reorder", behind: SEQ_MODULUS - step }
  }

  reset(): void {
    this.last = null
  }
}

export type SegmentOutcome = "played" | "cut"

/** What arrived for one segment, from `segment_start` until it played out or was cut. */
export class SegmentTrace {
  frames = 0
  bytes = 0
  samples = 0
  gaps = 0
  missing = 0
  reordered = 0
  duplicates = 0
  firstFrameMs: number | null = null
  lastFrameMs: number | null = null
  maxFrameGapMs = 0
  micPeak = 0
  ended = false
  endedAtMs: number | null = null

  constructor(
    readonly segmentId: number,
    readonly startedAtMs: number,
    readonly textChars: number,
  ) {}

  frame(step: SeqStep, bytes: number, samples: number, now: number): void {
    this.frames += 1
    this.bytes += bytes
    this.samples += samples
    if (step.kind === "gap") { this.gaps += 1; this.missing += step.missing }
    else if (step.kind === "reorder") this.reordered += 1
    else if (step.kind === "duplicate") this.duplicates += 1
    if (this.firstFrameMs === null) this.firstFrameMs = now - this.startedAtMs
    if (this.lastFrameMs !== null) this.maxFrameGapMs = Math.max(this.maxFrameGapMs, now - this.lastFrameMs)
    this.lastFrameMs = now
  }

  micLevel(level: number): void {
    if (level > this.micPeak) this.micPeak = level
  }

  end(now: number): void {
    this.ended = true
    this.endedAtMs = now
  }

  /** Audio received, in ms, at the output sample rate. */
  audioMs(outputRate: number): number {
    return outputRate > 0 ? (this.samples * 1000) / outputRate : 0
  }

  summary(outcome: SegmentOutcome, now: number, outputRate: number): VoiceLogFields {
    return {
      segment: this.segmentId,
      outcome,
      frames: this.frames,
      bytes: this.bytes,
      audio_ms: Math.round(this.audioMs(outputRate)),
      total_ms: Math.round(now - this.startedAtMs),
      first_frame_ms: this.firstFrameMs === null ? null : Math.round(this.firstFrameMs),
      max_frame_gap_ms: Math.round(this.maxFrameGapMs),
      seq_gaps: this.gaps,
      seq_missing: this.missing,
      seq_reordered: this.reordered,
      seq_duplicates: this.duplicates,
      ended: this.ended,
      text_chars: this.textChars,
      mic_peak: this.micPeak,
    }
  }
}

/** Cadence of captured microphone frames: how many, how big, and how uneven. */
export class CaptureStats {
  frames = 0
  bytes = 0
  late = 0
  maxGapMs = 0
  oddSized = 0
  private firstAt: number | null = null
  private lastAt: number | null = null
  private sizes = new Set<number>()

  constructor(
    private readonly expectedBytes: number,
    private readonly lateAfterMs: number,
  ) {}

  frame(bytes: number, now: number): number | null {
    this.frames += 1
    this.bytes += bytes
    if (bytes !== this.expectedBytes) this.oddSized += 1
    if (this.sizes.size < 8) this.sizes.add(bytes)
    this.firstAt ??= now
    let gap: number | null = null
    if (this.lastAt !== null) {
      gap = now - this.lastAt
      if (gap > this.maxGapMs) this.maxGapMs = gap
      if (gap > this.lateAfterMs) this.late += 1
    }
    this.lastAt = now
    return gap
  }

  summary(now: number): VoiceLogFields {
    const spanMs = this.firstAt === null ? 0 : now - this.firstAt
    return {
      frames: this.frames,
      bytes: this.bytes,
      span_ms: Math.round(spanMs),
      sizes: [...this.sizes].join("/"),
      odd_sized: this.oddSized,
      late_frames: this.late,
      max_gap_ms: Math.round(this.maxGapMs),
    }
  }
}

type FrameOf<K extends VoiceServerFrame["type"]> = Extract<VoiceServerFrame, { type: K }>
type Describers = { [K in VoiceServerFrame["type"]]: (frame: FrameOf<K>) => VoiceLogFields }

/** A string's length, or undefined for anything else, so a malformed frame still gets a line. */
function len(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined
}

/** A field of something that should be an object. */
function pick(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
}

function describeReady(frame: FrameOf<"ready">): VoiceLogFields {
  return {
    protocol: frame.protocol,
    input_rate: pick(frame.input, "sampleRate") as number,
    output_rate: pick(frame.output, "sampleRate") as number,
    stt: pick(frame.stt, "provider") as string,
    stt_partials: pick(frame.stt, "partials") as boolean,
    tts: pick(frame.tts, "provider") as string,
    tts_voice: pick(frame.tts, "voice") as string | null,
    onset_threshold: pick(frame.onset, "threshold") as number,
    onset_min_speech_ms: pick(frame.onset, "minSpeechMs") as number,
    cues: pick(frame.cues, "enabled") as boolean,
    backgrounding: frame.backgrounding,
    max_utterance_s: pick(frame.limits, "maxUtteranceSeconds") as number,
    keepalive_ms: frame.keepaliveMs,
  }
}

const DESCRIBERS: Describers = {
  ready: describeReady,
  vad: (f) => ({ speaking: f.speaking }),
  transcript: (f) => ({ utterance: f.utteranceId, final: f.final, text_chars: len(f.text) }),
  stop_playback: (f) => ({ reason: f.reason }),
  turn: (f) => ({ state: f.state, tool: f.tool }),
  segment_start: (f) => ({ segment: f.segmentId, message: f.messageId, text_chars: len(f.text) }),
  segment_end: (f) => ({ segment: f.segmentId }),
  holding: (f) => ({ text_chars: len(f.text) }),
  background: (f) => ({ task: f.taskId, description_chars: len(f.description) }),
  missed: (f) => ({ messages: Array.isArray(f.messageIds) ? f.messageIds.length : undefined }),
  metrics: (f) => ({ utterance: f.utteranceId, stt_ms: f.sttMs, ttfa_ms: f.ttfaMs }),
  error: (f) => ({ code: f.code, message_chars: len(f.message), utterance: f.utteranceId }),
  detached: (f) => ({ reason: f.reason }),
  keepalive: () => ({}),
}

/** The loggable facts of a gateway frame: ids, counts and lengths, never the words. */
export function describeServerFrame(frame: VoiceServerFrame): VoiceLogFields {
  const describe = DESCRIBERS[frame.type] as (f: VoiceServerFrame) => VoiceLogFields
  return describe(frame)
}

/** Frame types that arrive many times a second or only prove liveness: debug, not info. */
export function isChattyFrame(frame: VoiceServerFrame): boolean {
  return frame.type === "keepalive" || frame.type === "vad" || (frame.type === "transcript" && !frame.final)
}

/**
 * Reads the header of one WAV chunk and says whether it is whole: a RIFF/WAVE
 * header whose declared size matches the bytes held, and a `data` chunk that is
 * not longer than what follows it. A chunk that fails these decodes short or
 * not at all, which is what a truncated or garbled sentence is made of.
 */
export function describeWav(data: ArrayBuffer): VoiceLogFields & { problem?: string } {
  try {
    return readWav(data)
  } catch {
    return { bytes: data.byteLength, problem: "unreadable" }
  }
}

function readWav(data: ArrayBuffer): VoiceLogFields & { problem?: string } {
  const bytes = data.byteLength
  if (bytes < 12) return { bytes, problem: "too_short" }
  const view = new DataView(data)
  if (wavTag(view, 0) !== "RIFF" || wavTag(view, 8) !== "WAVE") return { bytes, problem: "not_riff" }
  const riffSize = view.getUint32(4, true)
  const out: VoiceLogFields & { problem?: string } = { bytes, riff_size: riffSize }
  // 0xFFFFFFFF is the streaming placeholder for "unknown length"; anything else must match.
  const sizeProblem = riffSize !== 0xffffffff && riffSize + 8 !== bytes ? "riff_size_mismatch" : undefined
  const chunkProblem = readWavChunks(view, out)
  const problem = sizeProblem ?? chunkProblem
  if (problem) out.problem = problem
  return out
}

function wavTag(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
}

/** Walks the chunks after the RIFF header, filling `out` from `fmt ` and `data`; returns a problem found in them. */
function readWavChunks(view: DataView, out: VoiceLogFields): string | undefined {
  const bytes = view.byteLength
  let offset = 12
  while (offset + 8 <= bytes) {
    const id = wavTag(view, offset)
    const size = view.getUint32(offset + 4, true)
    if (id === "fmt " && offset + 24 <= bytes) {
      out.format = view.getUint16(offset + 8, true)
      out.channels = view.getUint16(offset + 10, true)
      out.rate = view.getUint32(offset + 12, true)
      out.bits = view.getUint16(offset + 22, true)
    } else if (id === "data") {
      out.data_bytes = size
      out.data_avail = bytes - (offset + 8)
      return size !== 0xffffffff && size > bytes - (offset + 8) ? "data_truncated" : undefined
    }
    offset += 8 + size + (size % 2)
  }
  return "no_data_chunk"
}
