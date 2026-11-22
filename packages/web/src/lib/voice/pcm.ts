/**
 * PCM maths for voice mode: the capture side resamples whatever rate the
 * device runs at to 16 kHz PCM16 in 20 ms frames, and the playback side turns
 * the gateway's 24 kHz PCM16 back into floats. Pure functions and one small
 * stateful class, so the worklet and the tests run the same code.
 */

export const CAPTURE_RATE = 16_000
export const FRAME_MS = 20
export const FRAME_SAMPLES = (CAPTURE_RATE * FRAME_MS) / 1000

/** Root mean square of a block, 0..1. Int16 input is scaled to the float range. */
export function rms(block: Float32Array | Int16Array): number {
  if (block.length === 0) return 0
  const scale = block instanceof Int16Array ? 1 / 32768 : 1
  let sum = 0
  for (let i = 0; i < block.length; i++) {
    const v = block[i] * scale
    sum += v * v
  }
  return Math.sqrt(sum / block.length)
}

export function floatToInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value))
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
}

export function int16ToFloat(value: number): number {
  return value < 0 ? value / 0x8000 : value / 0x7fff
}

/**
 * Downsamples a stream of float blocks by averaging every input sample that
 * falls inside each output sample's window (a box filter with fractional edge
 * weights). The window position carries over between blocks, so block sizes
 * never change the output and the long-run rate is exact for any input rate.
 */
export class BoxResampler {
  private readonly ratio: number
  private need: number
  private acc = 0

  constructor(inputRate: number, outputRate: number = CAPTURE_RATE) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new RangeError("sample rates must be positive")
    this.ratio = inputRate / outputRate
    this.need = this.ratio
  }

  push(input: Float32Array): number[] {
    const out: number[] = []
    for (let i = 0; i < input.length; i++) this.pushSample(input[i], out)
    return out
  }

  private pushSample(sample: number, out: number[]): void {
    let remaining = 1
    while (remaining > 1e-12) {
      const take = Math.min(remaining, this.need)
      this.acc += sample * take
      this.need -= take
      remaining -= take
      if (this.need <= 1e-9) {
        out.push(this.acc / this.ratio)
        this.acc = 0
        this.need += this.ratio
      }
    }
  }
}

/** Resamples to 16 kHz and cuts the result into 20 ms PCM16 frames. */
export class Pcm16Framer {
  private readonly resampler: BoxResampler
  private pending: number[] = []

  constructor(inputRate: number, private readonly frameSamples: number = FRAME_SAMPLES) {
    this.resampler = new BoxResampler(inputRate, CAPTURE_RATE)
  }

  push(input: Float32Array): Int16Array[] {
    for (const sample of this.resampler.push(input)) this.pending.push(sample)
    const frames: Int16Array[] = []
    while (this.pending.length >= this.frameSamples) {
      const frame = new Int16Array(this.frameSamples)
      for (let i = 0; i < this.frameSamples; i++) frame[i] = floatToInt16(this.pending[i])
      this.pending = this.pending.slice(this.frameSamples)
      frames.push(frame)
    }
    return frames
  }
}
