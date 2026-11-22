/**
 * Microphone capture for voice mode. The browser's own echo cancellation,
 * noise suppression and gain control are on (the assistant's voice must not
 * count as the user speaking), and an AudioWorklet resamples to 16 kHz PCM16
 * in 20 ms frames.
 *
 * iOS Safari only grants the microphone and a running AudioContext to calls
 * made synchronously inside the tap handler, so `requestMicrophone` must be
 * the first thing a tap does, before any await.
 */

export const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
}

export interface CaptureHandle {
  /** The live microphone track, for `mute` and `ended` events. */
  readonly track: MediaStreamTrack | null
  /** Release the microphone and the audio graph. */
  stop(): void
}

/** Asks for the microphone. Calls `getUserMedia` synchronously; await the result afterwards. */
export function requestMicrophone(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream> = (c) => navigator.mediaDevices.getUserMedia(c),
): Promise<MediaStream> {
  return getUserMedia(MICROPHONE_CONSTRAINTS)
}

export type FrameSink = (pcm: Int16Array) => void

/** Wires a microphone stream through the capture worklet. Frames arrive on `onFrame`, one per 20 ms. */
export async function startCapture(ctx: AudioContext, stream: MediaStream, onFrame: FrameSink): Promise<CaptureHandle> {
  const [{ default: moduleUrl }, { CAPTURE_PROCESSOR_NAME }] = await Promise.all([
    import("./capture-processor-url"),
    import("./capture-processor-name"),
  ])
  await ctx.audioWorklet.addModule(moduleUrl)
  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR_NAME, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
  // Some engines only run a worklet whose output reaches the destination.
  const silent = ctx.createGain()
  silent.gain.value = 0
  node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onFrame(new Int16Array(event.data))
  source.connect(node)
  node.connect(silent)
  silent.connect(ctx.destination)
  return {
    track: stream.getAudioTracks()[0] ?? null,
    stop() {
      node.port.onmessage = null
      source.disconnect()
      node.disconnect()
      silent.disconnect()
      for (const track of stream.getTracks()) track.stop()
    },
  }
}
