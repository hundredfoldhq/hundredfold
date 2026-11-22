/** Hold threshold (ms) that separates a quick tap from a tap-and-hold. */
export const MIC_HOLD_THRESHOLD_MS = 250

export type MicGesture = "hold" | "tap"

/**
 * Pure classifier for a dictation mic button gesture. A press held for at least
 * `threshold` ms is a push-to-talk hold; anything shorter is a quick tap.
 * Shared by the Notes and Todo quick-capture mics.
 */
export function classifyMicGesture(
  downAt: number,
  upAt: number,
  threshold: number = MIC_HOLD_THRESHOLD_MS,
): MicGesture {
  return upAt - downAt >= threshold ? "hold" : "tap"
}
