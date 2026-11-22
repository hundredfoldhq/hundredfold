import { describe, expect, it, vi } from "vitest"
import type { HundredfoldNativeBridge } from "@/platform/native-bridge"
import { NativeVoiceSession, nativeStartMessage, nativeVoiceBridge, type NativeVoiceBridge } from "../native"
import { voicePhase } from "../state"

function bridge(overrides: Partial<NativeVoiceBridge> = {}) {
  let forward: (frame: unknown) => void = () => {}
  const voiceStart = vi.fn(async (_input: unknown, onFrame: (frame: unknown) => void) => { forward = onFrame; return { ok: true } })
  const value = {
    runtime: "tauri", voiceStart, voiceStop: vi.fn(async () => ({ ok: true })), voicePtt: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as NativeVoiceBridge
  return { value, voiceStart, send: (frame: unknown) => forward(frame) }
}
const ORIGIN = "https://gw.example.test"
const READY = { type: "ready", protocol: 1, sessionId: "s", input: { encoding: "pcm16", sampleRate: 16000 }, output: { encoding: "pcm16", sampleRate: 24000 }, stt: { provider: "local", partials: true }, tts: { provider: "local", voice: null }, onset: { threshold: 0.02, minSpeechMs: 250 }, backgrounding: "native", limits: { maxUtteranceSeconds: 60 } }

describe("nativeVoiceBridge", () => {
  it("is the bridge only when the shell offers all the voice commands", () => {
    const full = bridge().value
    expect(nativeVoiceBridge(full)).toBe(full)
    expect(nativeVoiceBridge({ runtime: "tauri" } as HundredfoldNativeBridge)).toBeNull()
    expect(nativeVoiceBridge(undefined)).toBeNull()
  })
})

describe("NativeVoiceSession", () => {
  it("starts through voice_start with the target, session and mode, and renders forwarded frames", async () => {
    const { value, voiceStart, send } = bridge()
    const session = new NativeVoiceSession(value, { sessionId: "s1", mode: "hands-free", origin: ORIGIN })
    const started = session.start()
    expect(voiceStart.mock.calls[0][0]).toEqual({ target: { origin: ORIGIN }, sessionId: "s1", mode: "hands-free" })
    expect(voicePhase(session.getSnapshot())).toBe("connecting")
    await started
    send(READY)
    expect(voicePhase(session.getSnapshot())).toBe("listening")
    send({ type: "transcript", utteranceId: "u", text: "hello there", final: false })
    expect(session.getSnapshot().partial).toBe("hello there")
    send({ type: "transcript", utteranceId: "u", text: "hello there", final: true })
    send({ type: "turn", state: "working", tool: "Bash" })
    expect(voicePhase(session.getSnapshot())).toBe("working")
  })

  it("calls voice_start synchronously, inside the tap", () => {
    const { value, voiceStart } = bridge()
    void new NativeVoiceSession(value, { sessionId: "s1", mode: "hands-free", origin: ORIGIN }).start()
    expect(voiceStart).toHaveBeenCalledTimes(1)
  })

  it("stops through voice_stop and ignores frames that arrive after", async () => {
    const { value, send } = bridge()
    const session = new NativeVoiceSession(value, { sessionId: "s1", mode: "hands-free", origin: ORIGIN })
    await session.start()
    send(READY)
    session.stop()
    expect(value.voiceStop).toHaveBeenCalledTimes(1)
    send({ type: "turn", state: "speaking" })
    expect(voicePhase(session.getSnapshot())).toBe("off")
  })

  it("turns the shell's refusal codes into something a person can act on", async () => {
    for (const [code, text] of [["permission_denied", /permission/i], ["not_paired", /not paired/i], ["unsupported", /not supported/i]] as const) {
      const { value } = bridge({ voiceStart: vi.fn(async () => { throw { code } }) } as Partial<NativeVoiceBridge>)
      const session = new NativeVoiceSession(value, { sessionId: "s", mode: "hands-free", origin: ORIGIN })
      await session.start()
      expect(session.getSnapshot()).toMatchObject({ status: "off" })
      expect(session.getSnapshot().error).toMatch(text)
    }
    expect(nativeStartMessage("permission_denied")).toMatch(/permission/i)
    expect(nativeStartMessage(new Error("boom"))).toMatch(/could not start/i)
  })

  it("an ok:false answer is a failure", async () => {
    const { value } = bridge({ voiceStart: vi.fn(async () => ({ ok: false })) } as Partial<NativeVoiceBridge>)
    const session = new NativeVoiceSession(value, { sessionId: "s", mode: "hands-free", origin: ORIGIN })
    await session.start()
    expect(session.getSnapshot().error).toBeTruthy()
  })

  it("push-to-talk goes through voice_ptt, and hands-free never sends it", async () => {
    const ptt = bridge()
    const talk = new NativeVoiceSession(ptt.value, { sessionId: "s", mode: "push-to-talk", origin: ORIGIN })
    await talk.start()
    ptt.send(READY)
    talk.pttDown()
    talk.pttUp()
    expect(ptt.value.voicePtt).toHaveBeenNthCalledWith(1, { down: true })
    expect(ptt.value.voicePtt).toHaveBeenNthCalledWith(2, { down: false })

    const free = bridge()
    const hands = new NativeVoiceSession(free.value, { sessionId: "s", mode: "hands-free", origin: ORIGIN })
    await hands.start()
    free.send(READY)
    hands.pttDown()
    expect(free.value.voicePtt).not.toHaveBeenCalled()
  })

  it("accepts frames forwarded as parsed objects or as strings, and drops unknown ones", async () => {
    const { value, send } = bridge()
    const session = new NativeVoiceSession(value, { sessionId: "s", mode: "hands-free", origin: ORIGIN })
    await session.start()
    send(JSON.stringify(READY))
    send({ type: "nonsense" })
    expect(voicePhase(session.getSnapshot())).toBe("listening")
  })
})
