/**
 * AudioWorklet side of microphone capture. Runs in the audio rendering
 * thread, so it only resamples and frames: 16 kHz PCM16, 20 ms (320 samples)
 * per message. The maths lives in pcm.ts and is shared with the tests.
 */
import { CAPTURE_PROCESSOR_NAME } from "./capture-processor-name"
import { Pcm16Framer } from "./pcm"

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor & {
  process(inputs: Float32Array[][]): boolean
}): void

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly framer = new Pcm16Framer(sampleRate)

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (const frame of this.framer.push(channel)) this.port.postMessage(frame.buffer, [frame.buffer])
    return true
  }
}

registerProcessor(CAPTURE_PROCESSOR_NAME, CaptureProcessor)
