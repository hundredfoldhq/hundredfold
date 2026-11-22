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

  it("says clearly when the microphone was refused or the app is not paired", async () => {
    for (const [code, text] of [["permission-denied", /microphone permission/i], ["not-paired", /not paired/i]] as const) {
      const { value } = bridge({ voiceStart: vi.fn(async () => { throw { code } }) } as Partial<NativeVoiceBridge>)
      const session = new NativeVoiceSession(value, { sessionId: "s", mode: "hands-free", origin: ORIGIN })
      await session.start()
      expect(session.getSnapshot()).toMatchObject({ status: "off" })
      expect(session.getSnapshot().error).toMatch(text)
    }
    expect(nativeStartMessage("permission-denied")).toMatch(/permission/i)
  })

  it.each(["unsupported", "voice-busy", "invalid-path", "invalid-request", "transport-failed", "something-new"])("%s gets the generic message", async (code) => {
    const { value } = bridge({ voiceStart: vi.fn(async () => { throw { code } }) } as Partial<NativeVoiceBridge>)
    const session = new NativeVoiceSession(value, { sessionId: "s", mode: "hands-free", origin: ORIGIN })
    await session.start()
    expect(session.getSnapshot().error).toBe("Couldn't start voice mode on this device.")
  })

  it("reads a code given as a bare string or an Error message, and tolerates the underscored spelling", () => {
    expect(nativeStartMessage("permission-denied")).toMatch(/permission/i)
    expect(nativeStartMessage(new Error("not-paired"))).toMatch(/not paired/i)
    expect(nativeStartMessage("PERMISSION_DENIED")).toMatch(/permission/i)
    expect(nativeStartMessage(new Error("boom"))).toBe("Couldn't start voice mode on this device.")
    expect(nativeStartMessage(undefined)).toBe("Couldn't start voice mode on this device.")
    expect(nativeStartMessage("constructor")).toBe("Couldn't start voice mode on this device.")
    expect(nativeStartMessage("__proto__")).toBe("Couldn't start voice mode on this device.")
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

describe("NativeVoiceSession native_state events", () => {
  async function running() {
    const rig = bridge()
    const session = new NativeVoiceSession(rig.value, { sessionId: "s", mode: "hands-free", origin: ORIGIN })
    await session.start()
    rig.send(READY)
    return { ...rig, session }
  }

  it("a stop from the lock screen or notification returns the control to idle, quietly", async () => {
    const { session, send } = await running()
    send({ type: "native_state", state: "stopped", reason: "notification" })
    expect(session.getSnapshot()).toMatchObject({ status: "off", error: null, notice: null })
    expect(voicePhase(session.getSnapshot())).toBe("off")
  })

  it("a stop the user asked for in the app is idle too", async () => {
    const { session, send } = await running()
    send(JSON.stringify({ type: "native_state", state: "stopped", reason: "user" }))
    expect(voicePhase(session.getSnapshot())).toBe("off")
  })

  it("a phone call or Siri pauses it, with a notice, and it comes back when the shell says running", async () => {
    const { session, send } = await running()
    send({ type: "native_state", state: "paused", reason: "interruption" })
    expect(voicePhase(session.getSnapshot())).toBe("paused")
    expect(session.getSnapshot().notice).toMatch(/paused by a call/)
    send({ type: "native_state", state: "running" })
    expect(voicePhase(session.getSnapshot())).toBe("listening")
    expect(session.getSnapshot().notice).toBeNull()
  })

  it.each([
    [4409, /in use on this chat by someone else/],
    [4429, /Too many voice sessions on this gateway/],
    [4401, /no longer have access to this chat/],
    [4404, /This chat no longer exists/],
  ])("socket_closed with close code %i says why", async (code, text) => {
    const { session, send } = await running()
    send({ type: "native_state", state: "stopped", reason: "socket_closed", code })
    expect(session.getSnapshot()).toMatchObject({ status: "off" })
    expect(session.getSnapshot().error).toMatch(text)
  })

  it("socket_closed with no code, an unknown code, or a code that is not a number shows the generic error", async () => {
    for (const extra of [{}, { code: 1006 }, { code: "4409" }]) {
      const { session, send } = await running()
      send({ type: "native_state", state: "stopped", reason: "socket_closed", ...extra })
      expect(session.getSnapshot().error).toBe("Voice connection lost.")
    }
  })

  it("a code with any other reason is ignored", async () => {
    const { session, send } = await running()
    send({ type: "native_state", state: "stopped", reason: "notification", code: 4409 })
    expect(session.getSnapshot().error).toBeNull()
  })

  it("a stop with reason error or socket_closed says so", async () => {
    const a = await running()
    a.send({ type: "native_state", state: "stopped", reason: "error" })
    expect(a.session.getSnapshot().error).toMatch(/stopped on this device/)
    const b = await running()
    b.send({ type: "native_state", state: "stopped", reason: "socket_closed" })
    expect(b.session.getSnapshot().error).toBe("Voice connection lost.")
  })

  it("running and connecting before the gateway is ready do not skip ahead of ready", async () => {
    const rig = bridge()
    const session = new NativeVoiceSession(rig.value, { sessionId: "s", mode: "hands-free", origin: ORIGIN })
    await session.start()
    rig.send({ type: "native_state", state: "connecting" })
    rig.send({ type: "native_state", state: "running" })
    expect(voicePhase(session.getSnapshot())).toBe("connecting")
    rig.send(READY)
    expect(voicePhase(session.getSnapshot())).toBe("listening")
  })

  it("paused then running before the gateway was ready goes back to connecting, not on", async () => {
    const rig = bridge()
    const session = new NativeVoiceSession(rig.value, { sessionId: "s", mode: "hands-free", origin: ORIGIN })
    await session.start()
    rig.send({ type: "native_state", state: "paused", reason: "interruption" })
    rig.send({ type: "native_state", state: "running" })
    expect(voicePhase(session.getSnapshot())).toBe("connecting")
    rig.send(READY)
    expect(voicePhase(session.getSnapshot())).toBe("listening")
  })

  it("push-to-talk release is sent once, and only after a press", async () => {
    const rig = bridge()
    const session = new NativeVoiceSession(rig.value, { sessionId: "s", mode: "push-to-talk", origin: ORIGIN })
    await session.start()
    rig.send(READY)
    session.pttUp()
    session.pttDown()
    session.pttDown()
    session.pttUp()
    session.pttUp()
    expect(rig.value.voicePtt).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["a shell stop", { type: "native_state", state: "stopped", reason: "notification" }],
    ["a gateway detach", { type: "detached", reason: "taken_over" }],
  ])("%s while the button is held does not swallow the next run's first press", async (_name, ending) => {
    const rig = bridge()
    const session = new NativeVoiceSession(rig.value, { sessionId: "s", mode: "push-to-talk", origin: ORIGIN })
    await session.start()
    rig.send(READY)
    session.pttDown()
    rig.send(ending)
    expect(voicePhase(session.getSnapshot())).toBe("off")
    ;(rig.value.voicePtt as ReturnType<typeof vi.fn>).mockClear()
    await session.start()
    rig.send(READY)
    session.pttDown()
    expect(rig.value.voicePtt).toHaveBeenCalledWith({ down: true })
    session.pttUp()
    expect(rig.value.voicePtt).toHaveBeenLastCalledWith({ down: false })
  })

  it("is not a gateway frame: an unknown native_state value is ignored", async () => {
    const { session, send } = await running()
    send({ type: "native_state", state: "exploded" })
    expect(voicePhase(session.getSnapshot())).toBe("listening")
  })

  it("a tap on a paused control stops voice mode through the shell", async () => {
    const { session, send, value } = await running()
    send({ type: "native_state", state: "paused", reason: "interruption" })
    session.stop()
    expect(value.voiceStop).toHaveBeenCalledTimes(1)
    expect(voicePhase(session.getSnapshot())).toBe("off")
  })
})
