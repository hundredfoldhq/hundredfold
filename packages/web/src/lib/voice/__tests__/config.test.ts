import { describe, expect, it } from "vitest"
import { parseVoiceConfig } from "../config"

const ENABLED = {
  enabled: true, available: true, reason: null, mode: "hands-free", language: "en",
  onset: { threshold: 0.03, minSpeechMs: 300 }, bargeIn: { enabled: true },
  install: { state: "ready", progress: 1 },
}

describe("parseVoiceConfig", () => {
  it("reads an enabled config", () => {
    expect(parseVoiceConfig(ENABLED)).toEqual({
      enabled: true, available: true, reason: null, mode: "hands-free", bargeIn: true,
      onset: { threshold: 0.03, minSpeechMs: 300 }, install: { state: "ready", progress: 1, reason: null },
    })
  })

  it("is disabled for the disabled answer and for anything malformed", () => {
    for (const raw of [{ enabled: false }, null, undefined, "x", [], { enabled: "true" }, {}]) {
      expect(parseVoiceConfig(raw)).toEqual({ enabled: false })
    }
  })

  it("carries the reason an unavailable voice gives, and the install progress", () => {
    const parsed = parseVoiceConfig({ ...ENABLED, available: false, reason: "Python 3.10+ not found", install: { state: "installing", progress: 0.4 } })
    expect(parsed).toMatchObject({ available: false, reason: "Python 3.10+ not found", install: { state: "installing", progress: 0.4 } })
  })

  it("reads push-to-talk and a disabled barge-in", () => {
    expect(parseVoiceConfig({ ...ENABLED, mode: "push-to-talk", bargeIn: { enabled: false } })).toMatchObject({ mode: "push-to-talk", bargeIn: false })
  })

  it("falls back to the default onset when it is missing", () => {
    expect(parseVoiceConfig({ ...ENABLED, onset: undefined })).toMatchObject({ onset: { threshold: 0.02, minSpeechMs: 250 } })
  })

  it("clamps install progress", () => {
    expect(parseVoiceConfig({ ...ENABLED, install: { state: "installing", progress: 7 } })).toMatchObject({ install: { progress: 1 } })
  })
})
