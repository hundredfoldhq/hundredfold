import { describe, expect, it } from "vitest"
import { floatToPcm16 } from "../recording-pcm"

describe("floatToPcm16", () => {
  it("maps full scale, silence and half scale to 16-bit samples", () => {
    expect(Array.from(floatToPcm16(new Float32Array([1, 0, -1, 0.5, -0.5])))).toEqual([32767, 0, -32768, 16384, -16384])
  })

  it("clips what falls outside [-1, 1] instead of wrapping", () => {
    expect(Array.from(floatToPcm16(new Float32Array([2, -2])))).toEqual([32767, -32768])
  })

  it("keeps the sample count", () => {
    expect(floatToPcm16(new Float32Array(160)).length).toBe(160)
  })
})
