import { describe, expect, it } from 'vitest'
import { classifyMicGesture, MIC_HOLD_THRESHOLD_MS } from '../mic-gesture'

describe('classifyMicGesture', () => {
  it('treats a press at or beyond the threshold as a hold (push-to-talk)', () => {
    expect(classifyMicGesture(1000, 1000 + MIC_HOLD_THRESHOLD_MS)).toBe('hold')
    expect(classifyMicGesture(1000, 1000 + MIC_HOLD_THRESHOLD_MS + 500)).toBe('hold')
  })

  it('treats a press shorter than the threshold as a quick tap (toggle)', () => {
    expect(classifyMicGesture(1000, 1000 + MIC_HOLD_THRESHOLD_MS - 1)).toBe('tap')
    expect(classifyMicGesture(1000, 1010)).toBe('tap')
    expect(classifyMicGesture(1000, 1000)).toBe('tap')
  })

  it('honors a custom threshold', () => {
    expect(classifyMicGesture(0, 100, 50)).toBe('hold')
    expect(classifyMicGesture(0, 40, 50)).toBe('tap')
  })
})
