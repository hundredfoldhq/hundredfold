import { describe, expect, it } from "vitest"
import { CaptureStats, SegmentTrace, SeqTracker, describeServerFrame, describeWav, isChattyFrame } from "../trace"

describe("SeqTracker", () => {
  it("accepts consecutive numbers and reports the first", () => {
    const t = new SeqTracker()
    expect(t.next(10)).toEqual({ kind: "first" })
    expect(t.next(11)).toEqual({ kind: "ok" })
    expect(t.next(12)).toEqual({ kind: "ok" })
  })

  it("counts missing frames in a forward gap", () => {
    const t = new SeqTracker()
    t.next(5)
    expect(t.next(9)).toEqual({ kind: "gap", missing: 3 })
  })

  it("treats the 16-bit wrap as in order", () => {
    const t = new SeqTracker()
    t.next(0xfffe)
    expect(t.next(0xffff)).toEqual({ kind: "ok" })
    expect(t.next(0)).toEqual({ kind: "ok" })
    expect(t.next(2)).toEqual({ kind: "gap", missing: 1 })
  })

  it("flags a repeat and a frame that arrives after a later one", () => {
    const t = new SeqTracker()
    t.next(20)
    expect(t.next(20)).toEqual({ kind: "duplicate" })
    t.next(25)
    expect(t.next(23)).toEqual({ kind: "reorder", behind: 2 })
  })

  it("starts over after reset", () => {
    const t = new SeqTracker()
    t.next(1)
    t.reset()
    expect(t.next(500)).toEqual({ kind: "first" })
  })
})

describe("SegmentTrace", () => {
  it("summarises frames, bytes, latency and gaps", () => {
    const trace = new SegmentTrace(4, 1000, 42)
    trace.frame({ kind: "first" }, 1008, 500, 1120)
    trace.frame({ kind: "gap", missing: 2 }, 1008, 500, 1200)
    trace.frame({ kind: "reorder", behind: 1 }, 508, 250, 1230)
    trace.micLevel(0.01)
    trace.micLevel(0.03)
    trace.micLevel(0.02)
    trace.end(1300)
    const s = trace.summary("played", 1500, 24000)
    expect(s).toMatchObject({
      segment: 4,
      outcome: "played",
      frames: 3,
      bytes: 2524,
      total_ms: 500,
      first_frame_ms: 120,
      max_frame_gap_ms: 80,
      seq_gaps: 1,
      seq_missing: 2,
      seq_reordered: 1,
      seq_duplicates: 0,
      ended: true,
      text_chars: 42,
      mic_peak: 0.03,
    })
    expect(s.audio_ms).toBe(Math.round((1250 * 1000) / 24000))
  })

  it("reports no first frame when none arrived", () => {
    const s = new SegmentTrace(1, 0, 0).summary("cut", 50, 24000)
    expect(s.first_frame_ms).toBeNull()
    expect(s.frames).toBe(0)
    expect(s.ended).toBe(false)
  })
})

describe("CaptureStats", () => {
  it("counts late frames, odd sizes and the largest gap", () => {
    const stats = new CaptureStats(640, 60)
    expect(stats.frame(640, 0)).toBeNull()
    expect(stats.frame(640, 20)).toBe(20)
    expect(stats.frame(320, 140)).toBe(120)
    expect(stats.summary(160)).toMatchObject({ frames: 3, bytes: 1600, span_ms: 160, odd_sized: 1, late_frames: 1, max_gap_ms: 120, sizes: "640/320" })
  })
})

describe("describeServerFrame", () => {
  it("logs lengths, never the words", () => {
    const fields = describeServerFrame({ type: "segment_start", segmentId: 9, messageId: "m1", text: "hello there friend" })
    expect(fields).toEqual({ segment: 9, message: "m1", text_chars: 18 })
    expect(JSON.stringify(fields)).not.toContain("hello")
    expect(describeServerFrame({ type: "transcript", utteranceId: "u", text: "secret words", final: true })).toEqual({ utterance: "u", final: true, text_chars: 12 })
    expect(describeServerFrame({ type: "error", code: "tts_failed", message: "boom boom", utteranceId: "u" })).toEqual({ code: "tts_failed", message_chars: 9, utterance: "u" })
  })

  it("knows which frames are chatty", () => {
    expect(isChattyFrame({ type: "keepalive" })).toBe(true)
    expect(isChattyFrame({ type: "vad", speaking: true })).toBe(true)
    expect(isChattyFrame({ type: "transcript", utteranceId: "u", text: "x", final: false })).toBe(true)
    expect(isChattyFrame({ type: "transcript", utteranceId: "u", text: "x", final: true })).toBe(false)
    expect(isChattyFrame({ type: "segment_end", segmentId: 1 })).toBe(false)
  })
})

function wav(dataBytes: number, opts: { riffSize?: number; dataSize?: number } = {}): ArrayBuffer {
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const put = (o: number, s: string) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  put(0, "RIFF")
  v.setUint32(4, opts.riffSize ?? 36 + dataBytes, true)
  put(8, "WAVE")
  put(12, "fmt ")
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, 24000, true)
  v.setUint32(28, 48000, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  put(36, "data")
  v.setUint32(40, opts.dataSize ?? dataBytes, true)
  return buf
}

describe("describeWav", () => {
  it("reads a whole chunk without a problem", () => {
    const facts = describeWav(wav(200))
    expect(facts).toMatchObject({ bytes: 244, channels: 1, rate: 24000, bits: 16, data_bytes: 200, data_avail: 200 })
    expect(facts.problem).toBeUndefined()
  })

  it("flags a chunk cut short of its declared data", () => {
    const whole = wav(200)
    const cut = whole.slice(0, 144)
    expect(describeWav(cut).problem).toBe("riff_size_mismatch")
  })

  it("flags data that claims more than is present", () => {
    expect(describeWav(wav(100, { dataSize: 400 })).problem).toBe("data_truncated")
  })

  it("flags something that is not RIFF or is too short", () => {
    expect(describeWav(new ArrayBuffer(4)).problem).toBe("too_short")
    expect(describeWav(new Uint8Array(64).buffer).problem).toBe("not_riff")
  })
})
