/** A recording as the gateway's speech-to-text takes it: 16 kHz, mono, 16-bit samples. */

export const DICTATION_SAMPLE_RATE = 16_000

/** Float samples in [-1, 1] to 16-bit PCM, clipping what falls outside. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[index]))
    out[index] = clipped < 0 ? Math.round(clipped * 0x8000) : Math.round(clipped * 0x7fff)
  }
  return out
}

/** Decode what a MediaRecorder produced (WebM, Ogg or MP4 audio) and resample it to mono 16 kHz. */
export async function recordingToPcm16(blob: Blob): Promise<Int16Array> {
  const Ctor: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const context = new Ctor()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const length = Math.max(1, Math.ceil(decoded.duration * DICTATION_SAMPLE_RATE))
    const offline = new OfflineAudioContext(1, length, DICTATION_SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return floatToPcm16(rendered.getChannelData(0))
  } finally {
    void context.close().catch(() => {})
  }
}
