import { describe, expect, it } from "vitest"
import { BoxResampler, FRAME_SAMPLES, Pcm16Framer, floatToInt16, int16ToFloat, rms } from "../pcm"

function sine(freq: number, rate: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate)
  return out
}

function concat(frames: Int16Array[]): Int16Array {
  const out = new Int16Array(frames.length * FRAME_SAMPLES)
  frames.forEach((f, i) => out.set(f, i * FRAME_SAMPLES))
  return out
}

describe("rms", () => {
  it("is 0 for silence and for an empty block", () => {
    expect(rms(new Float32Array(320))).toBe(0)
    expect(rms(new Float32Array(0))).toBe(0)
  })
  it("matches amplitude / sqrt(2) for a sine, in float and in int16", () => {
    const wave = sine(440, 16000, 0.1, 0.5)
    expect(rms(wave)).toBeCloseTo(0.5 / Math.SQRT2, 2)
    const ints = Int16Array.from(wave, floatToInt16)
    expect(rms(ints)).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })
})

describe("int16 conversion", () => {
  it("clamps and round-trips the range ends", () => {
    expect(floatToInt16(2)).toBe(32767)
    expect(floatToInt16(-2)).toBe(-32768)
    expect(floatToInt16(0)).toBe(0)
    expect(int16ToFloat(32767)).toBeCloseTo(1, 5)
    expect(int16ToFloat(-32768)).toBe(-1)
  })
})

describe("BoxResampler", () => {
  it("emits one sample per `ratio` input samples", () => {
    const resampler = new BoxResampler(48000, 16000)
    expect(resampler.push(new Float32Array(480)).length).toBe(160)
  })

  it("keeps a constant level through a non-integer ratio", () => {
    const resampler = new BoxResampler(44100, 16000)
    const out = resampler.push(new Float32Array(44100).fill(0.25))
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1)
    for (const v of out) expect(v).toBeCloseTo(0.25, 6)
  })

  it("gives the same samples whatever the block size", () => {
    const wave = sine(300, 48000, 0.2)
    const whole = new BoxResampler(48000, 16000).push(wave)
    const chunked: number[] = []
    const resampler = new BoxResampler(48000, 16000)
    for (let i = 0; i < wave.length; i += 128) chunked.push(...resampler.push(wave.subarray(i, i + 128)))
    expect(chunked.length).toBe(whole.length)
    chunked.forEach((v, i) => expect(v).toBeCloseTo(whole[i], 6))
  })

  it("keeps the frequency and roughly the level of speech-band content", () => {
    const out = Float32Array.from(new BoxResampler(48000, 16000).push(sine(440, 48000, 0.5)))
    expect(rms(out)).toBeGreaterThan(0.3)
    let crossings = 0
    for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++
    expect(Math.abs(crossings / 0.5 - 440)).toBeLessThan(10)
  })

  it("rejects a non-positive rate", () => {
    expect(() => new BoxResampler(0)).toThrow(RangeError)
  })
})

describe("Pcm16Framer", () => {
  it("cuts 20 ms frames of 320 samples, holding the remainder for the next block", () => {
    const framer = new Pcm16Framer(48000)
    expect(framer.push(new Float32Array(900))).toHaveLength(0)
    const frames = framer.push(new Float32Array(960))
    expect(frames.length).toBeGreaterThanOrEqual(1)
    for (const frame of frames) expect(frame.length).toBe(FRAME_SAMPLES)
  })

  it("produces 50 frames a second and the right level", () => {
    const framer = new Pcm16Framer(48000)
    const frames: Int16Array[] = []
    const wave = sine(440, 48000, 1, 0.5)
    for (let i = 0; i < wave.length; i += 128) frames.push(...framer.push(wave.subarray(i, i + 128)))
    expect(Math.abs(frames.length - 50)).toBeLessThanOrEqual(1)
    expect(rms(concat(frames))).toBeCloseTo(0.5 / Math.SQRT2, 1)
  })

  it("passes 16 kHz audio through unchanged", () => {
    const wave = sine(440, 16000, 0.04, 0.5)
    const frames = new Pcm16Framer(16000).push(wave)
    expect(frames).toHaveLength(2)
    expect(Array.from(frames[0].subarray(0, 8))).toEqual(Array.from(wave.subarray(0, 8), floatToInt16))
  })
})
