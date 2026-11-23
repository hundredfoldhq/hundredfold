import { describe, expect, it } from 'vitest'
import { waveformBarHeight, scaleForDpr } from '../mic-waveform'

describe('waveformBarHeight', () => {
  it('clamps to the minimum bar height for silence', () => {
    expect(waveformBarHeight(0, 16, 2)).toBe(2)
    expect(waveformBarHeight(-1, 16, 2)).toBe(2)
  })

  it('scales linearly with the audio level', () => {
    expect(waveformBarHeight(0.5, 16, 2)).toBe(8)
    expect(waveformBarHeight(1, 16, 2)).toBe(16)
  })

  it('clamps levels above 1 to the full height', () => {
    expect(waveformBarHeight(2, 16, 2)).toBe(16)
  })
})

describe('scaleForDpr', () => {
  it('multiplies the backing store by the device pixel ratio', () => {
    expect(scaleForDpr(20, 16, 2)).toEqual({ width: 40, height: 32 })
    expect(scaleForDpr(20, 16, 1)).toEqual({ width: 20, height: 16 })
  })

  it('rounds fractional ratios and falls back to 1 for invalid values', () => {
    expect(scaleForDpr(20, 16, 1.5)).toEqual({ width: 30, height: 24 })
    expect(scaleForDpr(20, 16, 0)).toEqual({ width: 20, height: 16 })
  })
})
