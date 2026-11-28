import { describe, expect, it } from "vitest"
import type { VoiceServerFrame } from "@hundredfold/gateway-events"
import { INITIAL_VOICE_STATE, voicePhase, voiceReducer, type VoiceAction, type VoiceUiState } from "../state"

const READY: VoiceServerFrame = {
  type: "ready", protocol: 1, sessionId: "s",
  input: { encoding: "pcm16", sampleRate: 16000 }, output: { encoding: "pcm16", sampleRate: 24000 },
  stt: { provider: "local", partials: true }, tts: { provider: "local", voice: null },
  onset: { threshold: 0.02, minSpeechMs: 250 }, backgrounding: "native", limits: { maxUtteranceSeconds: 60 },
}

function run(actions: VoiceAction[], from: VoiceUiState = INITIAL_VOICE_STATE): VoiceUiState {
  return actions.reduce(voiceReducer, from)
}
const frame = (f: VoiceServerFrame): VoiceAction => ({ type: "frame", frame: f, now: 1000 })
const on = (): VoiceUiState => run([{ type: "connecting", mode: "hands-free" }, frame(READY)])

describe("voice phase from scripted frames", () => {
  it("walks off → connecting → listening on ready", () => {
    const connecting = run([{ type: "connecting", mode: "hands-free" }])
    expect(voicePhase(INITIAL_VOICE_STATE)).toBe("off")
    expect(voicePhase(connecting)).toBe("connecting")
    expect(voicePhase(on())).toBe("listening")
  })

  it("shows hearing with the live partial, then settles when the final lands", () => {
    let s = run([frame({ type: "vad", speaking: true })], on())
    expect(voicePhase(s)).toBe("hearing")
    s = run([frame({ type: "transcript", utteranceId: "u", text: "what is the", final: false })], s)
    expect(s.partial).toBe("what is the")
    s = run([frame({ type: "transcript", utteranceId: "u", text: "what is the time", final: true }), frame({ type: "vad", speaking: false })], s)
    expect(s.partial).toBe("")
    expect(voicePhase(s)).toBe("listening")
  })

  it("follows the gateway's turn: thinking, working with the tool, speaking, idle", () => {
    let s = run([frame({ type: "turn", state: "thinking" })], on())
    expect(voicePhase(s)).toBe("thinking")
    s = run([frame({ type: "turn", state: "working", tool: "Bash" })], s)
    expect(voicePhase(s)).toBe("working")
    expect(s.tool).toBe("Bash")
    s = run([frame({ type: "turn", state: "speaking" })], s)
    expect(voicePhase(s)).toBe("speaking")
    expect(s.tool).toBeNull()
    s = run([frame({ type: "turn", state: "idle" })], s)
    expect(voicePhase(s)).toBe("listening")
  })

  it("clears a leftover partial when the utterance is handed to the session", () => {
    const s = run([frame({ type: "transcript", utteranceId: "u", text: "um", final: false }), frame({ type: "turn", state: "thinking" })], on())
    expect(s.partial).toBe("")
    expect(voicePhase(s)).toBe("thinking")
  })

  it("hearing wins over speaking: the user talking over the reply", () => {
    const s = run([frame({ type: "turn", state: "speaking" }), frame({ type: "vad", speaking: true })], on())
    expect(voicePhase(s)).toBe("hearing")
  })

  it("keeps a holding line until the turn changes", () => {
    let s = run([frame({ type: "holding", text: "Still working on the last thing." })], on())
    expect(s.holding).toBe("Still working on the last thing.")
    s = run([frame({ type: "turn", state: "thinking" })], s)
    expect(s.holding).toBeNull()
  })

  it("records the latest time to first audio and ignores a null one", () => {
    let s = run([frame({ type: "metrics", utteranceId: "u", sttMs: 100, ttfaMs: 820 })], on())
    expect(s.ttfaMs).toBe(820)
    s = run([frame({ type: "metrics", utteranceId: "v", sttMs: 100, ttfaMs: null })], s)
    expect(s.ttfaMs).toBe(820)
  })

  it("collects each backgrounded task once", () => {
    const bg: VoiceServerFrame = { type: "background", taskId: "t1", description: "run the tests" }
    const s = run([frame(bg), frame(bg), frame({ type: "background", taskId: "t2", description: null })], on())
    expect(s.background.map((t) => t.taskId)).toEqual(["t1", "t2"])
  })

  it("announces replies that finished while suspended", () => {
    expect(run([frame({ type: "missed", messageIds: ["a"] })], on()).notice).toMatch(/finished while you were away/)
    expect(run([frame({ type: "missed", messageIds: ["a", "b"] })], on()).notice).toMatch(/2 replies/)
  })
})

describe("sync tick (when the stored chat has likely changed)", () => {
  it("bumps for a final transcript with words, an exchange's metrics and a turn going back to idle", () => {
    const base = on()
    expect(run([frame({ type: "transcript", utteranceId: "u", text: "hello", final: true })], base).syncTick).toBe(base.syncTick + 1)
    expect(run([frame({ type: "metrics", utteranceId: "u", sttMs: 1, ttfaMs: null })], base).syncTick).toBe(base.syncTick + 1)
    const speaking = run([frame({ type: "turn", state: "speaking" })], base)
    expect(run([frame({ type: "turn", state: "idle" })], speaking).syncTick).toBe(speaking.syncTick + 1)
  })

  it("does not bump for an empty final, a partial, or idle while already idle", () => {
    const base = on()
    expect(run([frame({ type: "transcript", utteranceId: "u", text: "  ", final: true })], base).syncTick).toBe(base.syncTick)
    expect(run([frame({ type: "transcript", utteranceId: "u", text: "hel", final: false })], base).syncTick).toBe(base.syncTick)
    expect(run([frame({ type: "turn", state: "idle" })], base).syncTick).toBe(base.syncTick)
  })
})

describe("endings", () => {
  it("a requested stop goes quietly back to off", () => {
    const s = run([{ type: "stopped" }], on())
    expect(s).toMatchObject({ status: "off", error: null })
  })

  it.each([
    [4409, /already in use/],
    [4429, /Too many/],
    [4401, /no longer have access/],
    [4404, /no longer exists/],
  ])("explains close code %i", (code, text) => {
    const s = run([{ type: "closed", code, reason: "", requested: false }], on())
    expect(s.status).toBe("off")
    expect(s.error).toMatch(text)
  })

  it("keeps the gateway's own explanation when it detached us before closing", () => {
    const s = run([frame({ type: "detached", reason: "taken_over" }), { type: "closed", code: 1000, reason: "", requested: false }], on())
    expect(s.error).toBe("Voice mode moved to another tab.")
  })

  it("treats an assistant hang-up as a clean end, not an error, however the close or stop after it arrives", () => {
    const afterDetach = (follow: VoiceAction[]) => run([frame({ type: "detached", reason: "ended" }), ...follow], on())
    expect(afterDetach([]).error).toBeNull()
    expect(afterDetach([{ type: "closed", code: 1000, reason: "", requested: false }]).error).toBeNull()
    // The mobile shell reports its own stop for the close that follows: "socket_closed", not an error.
    const native: VoiceAction = { type: "native-state", state: "stopped", reason: "socket_closed", code: 1000 }
    const s = afterDetach([{ type: "closed", code: 1000, reason: "", requested: false }, native])
    expect(s.status).toBe("off")
    expect(s.error).toBeNull()
    expect(afterDetach([native]).error).toBeNull()
  })

  it("a lost connection after a normal start is still an error, and a new run forgets an earlier hang-up", () => {
    const hungUp = run([frame({ type: "detached", reason: "ended" })], on())
    expect(hungUp.hungUp).toBe(true)
    const again = run([{ type: "connecting", mode: "hands-free" }, frame(READY)], hungUp)
    expect(again.hungUp).toBe(false)
    expect(run([{ type: "native-state", state: "stopped", reason: "socket_closed", code: 1006 }], on()).error).toBe("Voice connection lost.")
  })

  it("does not call a requested close an error", () => {
    expect(run([{ type: "closed", code: 1000, reason: "bye", requested: true }], on()).error).toBeNull()
  })

  it("a stale error frame does not replace the lost-connection message", () => {
    const s = run([frame({ type: "error", code: "stt_failed", message: "Speech recognition failed." }), { type: "closed", code: 1006, reason: "", requested: false }], on())
    expect(s.error).toBe("Voice connection lost.")
  })

  it("an unexplained close is a lost connection", () => {
    expect(run([{ type: "closed", code: 1006, reason: "", requested: false }], on()).error).toBe("Voice connection lost.")
  })
})

describe("an error ends the utterance in progress", () => {
  it.each(["stt_failed", "utterance_too_long"] as const)("%s does not leave the control on hearing", (code) => {
    let s = run([frame({ type: "vad", speaking: true }), frame({ type: "transcript", utteranceId: "u", text: "what is the", final: false })], on())
    expect(voicePhase(s)).toBe("hearing")
    s = run([frame({ type: "error", code, message: "That did not work." })], s)
    expect(s).toMatchObject({ partial: "", vadSpeaking: false, error: "That did not work." })
    expect(voicePhase(s)).toBe("listening")
  })
})

describe("suspension", () => {
  it("shows the device notice and drops any live transcript", () => {
    const s = run([frame({ type: "vad", speaking: true }), { type: "suspended" }], on())
    expect(voicePhase(s)).toBe("suspended")
    expect(s.notice).toBe("Voice mode was suspended by the device.")
    expect(s.partial).toBe("")
  })

  it("a close while suspended asks for a tap instead of reporting an error", () => {
    const s = run([{ type: "suspended" }, { type: "closed", code: 1006, reason: "", requested: false }], on())
    expect(s).toMatchObject({ status: "suspended", needsTap: true, error: null })
  })

  it("resuming bumps syncTick so the chat is re-read for replies that finished meanwhile", () => {
    const before = on().syncTick
    expect(run([{ type: "suspended" }, { type: "resumed" }], on()).syncTick).toBe(before + 1)
  })

  it("a resume clears the suspended notice but keeps any other notice", () => {
    expect(run([{ type: "suspended" }, { type: "resumed" }], on()).notice).toBeNull()
    const other = run([{ type: "suspended" }, { type: "frame", frame: { type: "missed", messageIds: ["a"] } as never, now: 0 }, { type: "resumed" }], on())
    expect(other.notice).not.toBeNull()
  })

  it("a resume brings it back on, no longer needing a tap", () => {
    const s = run([{ type: "suspended" }, { type: "needs-tap" }, { type: "resumed" }], on())
    expect(s).toMatchObject({ status: "on", needsTap: false })
  })

  it("an off state cannot be suspended", () => {
    expect(run([{ type: "suspended" }]).status).toBe("off")
  })
})

describe("notices", () => {
  it("dismiss clears the notice and the error", () => {
    const s = run([frame({ type: "error", code: "stt_failed", message: "no" }), { type: "dismiss-notice" }], on())
    expect(s.error).toBeNull()
  })

  it("background-cleared empties the task list", () => {
    const s = run([frame({ type: "background", taskId: "t", description: null }), { type: "background-cleared" }], on())
    expect(s.background).toEqual([])
  })
})
