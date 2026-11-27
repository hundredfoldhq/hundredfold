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

import { contextFields, errorFields, voiceLog, voiceNow } from "@/lib/voice-log"
import { CAPTURE_RATE, FRAME_MS, FRAME_SAMPLES } from "./pcm"
import { CaptureStats } from "./trace"

/** A frame that arrives more than this long after the previous one is counted as late (a frame is 20 ms). */
const LATE_FRAME_MS = FRAME_MS * 3
/** One cadence line per this many frames at debug level (every 5 s). */
const STATS_EVERY_FRAMES = 250

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
  const requestedAt = voiceNow()
  voiceLog.info("mic_request")
  const pending = getUserMedia(MICROPHONE_CONSTRAINTS)
  pending.then(
    (stream) => voiceLog.info("mic_granted", { wait_ms: voiceNow() - requestedAt, tracks: stream?.getAudioTracks?.().length }),
    (error: unknown) => voiceLog.warn("mic_denied", { wait_ms: voiceNow() - requestedAt, ...errorFields(error) }),
  )
  return pending
}

export type FrameSink = (pcm: Int16Array) => void

/** Wires a microphone stream through the capture worklet. Frames arrive on `onFrame`, one per 20 ms. */
export async function startCapture(ctx: AudioContext, stream: MediaStream, onFrame: FrameSink): Promise<CaptureHandle> {
  const [{ default: moduleUrl }, { CAPTURE_PROCESSOR_NAME }] = await Promise.all([
    import("./capture-processor-url"),
    import("./capture-processor-name"),
  ])
  const loadStart = voiceNow()
  try {
    await ctx.audioWorklet.addModule(moduleUrl)
  } catch (error) {
    voiceLog.warn("capture_worklet_failed", { load_ms: voiceNow() - loadStart, ...errorFields(error) })
    throw error
  }
  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR_NAME, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
  // Some engines only run a worklet whose output reaches the destination.
  const silent = ctx.createGain()
  silent.gain.value = 0
  const stats = new CaptureStats(FRAME_SAMPLES * 2, LATE_FRAME_MS)
  logCaptureStart(ctx, stream, voiceNow() - loadStart)
  node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    traceCaptureFrame(stats, event.data)
    onFrame(new Int16Array(event.data))
  }
  source.connect(node)
  node.connect(silent)
  silent.connect(ctx.destination)
  return {
    track: stream.getAudioTracks()[0] ?? null,
    stop() {
      voiceLog.info("capture_stopped", { ...stats.summary(voiceNow()), track_state: stream.getAudioTracks()[0]?.readyState })
      node.port.onmessage = null
      source.disconnect()
      node.disconnect()
      silent.disconnect()
      for (const track of stream.getTracks()) track.stop()
    },
  }
}

function logCaptureStart(ctx: AudioContext, stream: MediaStream, loadMs: number): void {
  try {
    const track = stream.getAudioTracks()[0]
    const settings = track?.getSettings?.() ?? {}
    voiceLog.info("capture_started", {
      load_ms: loadMs,
      target_rate: CAPTURE_RATE,
      frame_samples: FRAME_SAMPLES,
      track_state: track?.readyState,
      track_muted: track?.muted,
      track_rate: settings.sampleRate,
      channels: settings.channelCount,
      echo_cancellation: settings.echoCancellation,
      noise_suppression: settings.noiseSuppression,
      auto_gain: settings.autoGainControl,
      ...contextFields(ctx),
    })
  } catch { /* diagnostics only */ }
}

function traceCaptureFrame(stats: CaptureStats, data: ArrayBuffer): void {
  try {
    const now = voiceNow()
    const gap = stats.frame(data.byteLength, now)
    if (data.byteLength !== FRAME_SAMPLES * 2) voiceLog.warn("capture_frame_size", { bytes: data.byteLength, expected: FRAME_SAMPLES * 2 })
    if (gap !== null && gap > LATE_FRAME_MS) voiceLog.debug("capture_frame_late", { gap_ms: gap })
    if (stats.frames % STATS_EVERY_FRAMES === 0) voiceLog.debug("capture_stats", stats.summary(now))
  } catch { /* diagnostics only */ }
}
