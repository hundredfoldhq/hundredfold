import { describe, expect, it } from "vitest"
import { OnsetDetector } from "../onset"
import { floatToInt16, rms } from "../pcm"

const SETTINGS = { threshold: 0.02, minSpeechMs: 250 }

function frameAt(level: number): Int16Array {
  const frame = new Int16Array(320)
  for (let i = 0; i < 320; i++) frame[i] = floatToInt16(level * Math.SQRT2 * Math.sin((2 * Math.PI * 200 * i) / 16000))
  return frame
}

function run(detector: OnsetDetector, levels: number[], active = true): number {
  let fired = 0
  for (const level of levels) if (detector.feed(rms(frameAt(level)), active)) fired++
  return fired
}

describe("OnsetDetector", () => {
  it("fires once a loud-enough level has held for minSpeechMs", () => {
    const detector = new OnsetDetector(SETTINGS)
    const frames = Array(13).fill(0.1) // 13 x 20 ms = 260 ms
    let firedAt = -1
    frames.forEach((level, i) => { if (detector.feed(rms(frameAt(level)), true) && firedAt < 0) firedAt = i })
    expect(firedAt).toBe(12) // the 13th frame completes 260 ms >= 250 ms
  })

  it("does not fire before the hold is reached", () => {
    expect(run(new OnsetDetector(SETTINGS), Array(12).fill(0.1))).toBe(0)
  })

  it("does not fire on sub-threshold noise however long it lasts", () => {
    expect(run(new OnsetDetector(SETTINGS), Array(200).fill(0.01))).toBe(0)
  })

  it("does not fire on echo-level playback leaking into the microphone", () => {
    // Echo that survives cancellation sits well under the onset threshold.
    expect(run(new OnsetDetector(SETTINGS), Array(500).fill(0.015))).toBe(0)
  })

  it("restarts the hold when the level dips, so a click or cough burst does not fire", () => {
    const burst = [...Array(8).fill(0.1), 0.0, ...Array(8).fill(0.1), 0.0, ...Array(8).fill(0.1)]
    expect(run(new OnsetDetector(SETTINGS), burst)).toBe(0)
  })

  it("only listens while something is playing", () => {
    expect(run(new OnsetDetector(SETTINGS), Array(50).fill(0.2), false)).toBe(0)
  })

  it("starts the hold from zero when playback starts", () => {
    const detector = new OnsetDetector(SETTINGS)
    run(detector, Array(10).fill(0.2), true)
    run(detector, [0.2], false)
    expect(run(detector, Array(10).fill(0.2), true)).toBe(0)
  })

  it("fires once per hold, then needs a fresh hold", () => {
    expect(run(new OnsetDetector(SETTINGS), Array(26).fill(0.2))).toBe(2)
  })

  it("follows updated settings", () => {
    const detector = new OnsetDetector(SETTINGS)
    detector.update({ threshold: 0.5, minSpeechMs: 40 })
    expect(run(detector, Array(10).fill(0.2))).toBe(0)
    expect(run(detector, Array(2).fill(0.6))).toBe(1)
  })
})
