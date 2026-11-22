import type { CueAudioContext, CueGain, CueSource } from "../cues"
import type { PlayerBuffer } from "../player"

export class FakeSource implements CueSource {
  buffer: unknown = null
  loop = false
  onended: (() => void) | null = null
  startedAt: number | null = null
  stoppedAt: number | null = null
  disconnected = false
  connect() { return undefined }
  disconnect() { this.disconnected = true }
  start(when = 0) { this.startedAt = when }
  stop(when = 0) { this.stoppedAt = when }
  /** The context played this source to its end. */
  finish() { this.onended?.() }
}

export class FakeGain implements CueGain {
  /** Every call made on the gain parameter, in order. */
  readonly calls: string[] = []
  disconnected = false
  readonly gain = {
    value: 1,
    setValueAtTime: (value: number, time: number) => { this.calls.push(`set ${value} @${time}`) },
    linearRampToValueAtTime: (value: number, time: number) => { this.calls.push(`ramp ${value} @${time}`) },
  }
  connect() { return undefined }
  disconnect() { this.disconnected = true }
}

export class FakeAudioContext implements CueAudioContext {
  currentTime = 0
  destination = {}
  sources: FakeSource[] = []
  gains: FakeGain[] = []
  createBuffer(_channels: number, length: number, sampleRate: number): PlayerBuffer {
    const data = new Float32Array(length)
    return { duration: length / sampleRate, getChannelData: () => data }
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
  createGain(): FakeGain {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }
}

/** `samples` of PCM16 at a constant value. */
export function pcm(samples: number, value = 1000): Int16Array {
  return new Int16Array(samples).fill(value)
}
