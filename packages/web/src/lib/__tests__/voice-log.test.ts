import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearDebugLog, getDebugLog } from "../debug-log"
import {
  VOICE_DEBUG_PARAM,
  VOICE_DEBUG_STORAGE_KEY,
  contextFields,
  errorFields,
  formatVoiceEvent,
  resetVoiceLog,
  setVoiceDebug,
  traceContextState,
  voiceDebugEnabled,
  voiceLog,
} from "../voice-log"

beforeEach(() => {
  clearDebugLog()
  resetVoiceLog()
  localStorage.clear()
  vi.spyOn(console, "info").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "debug").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", "/")
})

describe("formatVoiceEvent", () => {
  it("writes event then key=value pairs, skipping undefined", () => {
    expect(formatVoiceEvent("segment_summary", { segment: 3, ok: true, gone: false, none: null, skipped: undefined })).toBe(
      "event=segment_summary segment=3 ok=true gone=false none=null",
    )
  })

  it("rounds fractions to three places and keeps integers whole", () => {
    expect(formatVoiceEvent("t", { a: 1.23456, b: 12, c: 0.1 + 0.2 })).toBe("event=t a=1.235 b=12 c=0.3")
  })

  it("quotes strings that are not plain tokens and caps long ones", () => {
    const line = formatVoiceEvent("t", { plain: "a-b_c.d:e", spaced: "two words", long: "x".repeat(200) })
    expect(line).toContain("plain=a-b_c.d:e")
    expect(line).toContain('spaced="two words"')
    expect(line).toContain(`long=${"x".repeat(64)}...`)
  })
})

describe("voiceLog levels", () => {
  it("writes info and warn to the shared debug log and the console with a [voice] prefix", () => {
    voiceLog.info("socket_open", { session: "s1" })
    voiceLog.warn("audio_seq_gap", { missing: 2 })
    const text = getDebugLog()
    expect(text).toContain("[voice] event=socket_open session=s1")
    expect(text).toContain("[voice] event=audio_seq_gap missing=2")
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/^\[voice\] event=socket_open session=s1 dt=\d+$/))
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[voice\] event=audio_seq_gap missing=2 dt=\d+$/))
  })

  it("adds the time since the previous voice line as dt", () => {
    const now = vi.spyOn(performance, "now")
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1250)
    voiceLog.info("a")
    voiceLog.info("b")
    const lines = getDebugLog().split("\n")
    expect(lines[0]).toContain("event=a dt=0")
    expect(lines[1]).toContain("event=b dt=250")
  })

  it("skips debug lines, and never builds their fields, while debug is off", () => {
    const fields = vi.fn(() => ({ n: 1 }))
    voiceLog.debug("audio_in", fields)
    expect(fields).not.toHaveBeenCalled()
    expect(getDebugLog()).toBe("(empty)")
    expect(console.debug).not.toHaveBeenCalled()
  })

  it("writes debug lines once debug is on", () => {
    setVoiceDebug(true)
    voiceLog.debug("audio_in", () => ({ seq: 7 }))
    expect(getDebugLog()).toContain("event=audio_in seq=7")
    expect(console.debug).toHaveBeenCalledOnce()
  })

  it("never throws, even when the field builder does", () => {
    setVoiceDebug(true)
    expect(() => voiceLog.debug("boom", () => { throw new Error("nope") })).not.toThrow()
    expect(() => voiceLog.info("ok", { self: null })).not.toThrow()
  })
})

describe("debug switch", () => {
  it("is off by default", () => {
    expect(voiceDebugEnabled()).toBe(false)
  })

  it("turns on from the storage key", () => {
    localStorage.setItem(VOICE_DEBUG_STORAGE_KEY, "1")
    expect(voiceDebugEnabled()).toBe(true)
  })

  it("turns on from the URL parameter and remembers it, and off again with 0", () => {
    window.history.replaceState(null, "", `/?${VOICE_DEBUG_PARAM}=1`)
    expect(voiceDebugEnabled()).toBe(true)
    expect(localStorage.getItem(VOICE_DEBUG_STORAGE_KEY)).toBe("1")

    resetVoiceLog()
    window.history.replaceState(null, "", `/?${VOICE_DEBUG_PARAM}=0`)
    expect(voiceDebugEnabled()).toBe(false)
    expect(localStorage.getItem(VOICE_DEBUG_STORAGE_KEY)).toBeNull()
  })

  it("works when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked") },
      setItem: () => { throw new Error("blocked") },
      removeItem: () => { throw new Error("blocked") },
    })
    expect(voiceDebugEnabled()).toBe(false)
    expect(() => setVoiceDebug(true)).not.toThrow()
    expect(voiceDebugEnabled()).toBe(true)
  })

  it("can be flipped from the console helper", () => {
    const toggle = (window as unknown as { __voiceDebug: (on?: boolean) => boolean }).__voiceDebug
    expect(toggle(true)).toBe(true)
    expect(toggle(false)).toBe(false)
  })
})

describe("helpers", () => {
  it("errorFields keeps the name and strips URLs from the message", () => {
    const fields = errorFields(new TypeError("failed to fetch https://host.example/api/tts?token=abc"))
    expect(fields.err).toBe("TypeError")
    expect(fields.err_msg).toBe("failed to fetch <url>")
  })

  it("contextFields reads what a context offers and tolerates a bare object", () => {
    expect(contextFields({ sampleRate: 48000, state: "running", baseLatency: 0.01, outputLatency: 0.045 })).toEqual({
      ctx_rate: 48000,
      ctx_state: "running",
      ctx_base_latency_ms: 10,
      ctx_output_latency_ms: 45,
    })
    expect(contextFields({}, "x")).toEqual({ x_rate: undefined, x_state: undefined, x_base_latency_ms: undefined, x_output_latency_ms: undefined })
    expect(contextFields(null)).toEqual({})
  })

  it("traceContextState logs each change until disposed", () => {
    let listener: (() => void) | undefined
    const ctx = {
      state: "running",
      sampleRate: 24000,
      addEventListener: (_: string, fn: () => void) => { listener = fn },
      removeEventListener: vi.fn(),
    }
    const stop = traceContextState(ctx, "test")
    ctx.state = "suspended"
    listener?.()
    expect(getDebugLog()).toContain("event=audio_context_state owner=test from=running to=suspended ctx_rate=24000")
    stop()
    expect(ctx.removeEventListener).toHaveBeenCalled()
  })
})
