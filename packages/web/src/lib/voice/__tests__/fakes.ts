import type { PlayerAudioContext, PlayerBuffer, PlayerSource } from "../player"

export class FakeSource implements PlayerSource {
  buffer: unknown = null
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

export class FakeAudioContext implements PlayerAudioContext {
  currentTime = 0
  destination = {}
  sources: FakeSource[] = []
  createBuffer(_channels: number, length: number, sampleRate: number): PlayerBuffer {
    const data = new Float32Array(length)
    return { duration: length / sampleRate, getChannelData: () => data }
  }
  createBufferSource(): PlayerSource {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
}

/** `samples` of PCM16 at a constant value. */
export function pcm(samples: number, value = 1000): Int16Array {
  return new Int16Array(samples).fill(value)
}
