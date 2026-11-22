import type { VoiceOnsetSettings } from "@hundredfold/gateway-events"
import { FRAME_MS } from "./pcm"

/**
 * The client's only voice-activity logic: an RMS level held for
 * `minSpeechMs` while something is playing. It exists to stop playback at
 * once on barge-in, without a round trip. The gateway's VAD decides what the
 * speech means; a false trigger (a cough) costs nothing.
 *
 * The browser's echo canceller keeps the assistant's own voice out of the
 * capture, so the threshold only sees the user. A level that dips below the
 * threshold restarts the hold, so a click or a burst of echo does not fire.
 */
export class OnsetDetector {
  private heldMs = 0

  constructor(private settings: VoiceOnsetSettings) {}

  update(settings: VoiceOnsetSettings): void {
    this.settings = settings
  }

  reset(): void {
    this.heldMs = 0
  }

  /** Feed one captured frame's level. Returns true once, when the hold is reached. */
  feed(level: number, playbackActive: boolean, frameMs: number = FRAME_MS): boolean {
    if (!playbackActive || level < this.settings.threshold) {
      this.heldMs = 0
      return false
    }
    this.heldMs += frameMs
    if (this.heldMs < this.settings.minSpeechMs) return false
    this.heldMs = 0
    return true
  }
}
