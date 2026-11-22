import { beforeEach, describe, expect, it, vi } from "vitest"
import type { VoiceClientFrame, VoiceServerFrame } from "@hundredfold/gateway-events"
import { floatToInt16 } from "../pcm"
import { VoicePlayer } from "../player"
import { BrowserVoiceSession, type BrowserVoiceDeps, type VoiceAudioContext, type VoiceSocketLike } from "../session"
import type { VoiceSocketHandlers } from "../socket"
import { voicePhase } from "../state"
import { FakeAudioContext, pcm } from "./fakes"

class Emitter {
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, l: () => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(l) }
  removeEventListener(type: string, l: () => void) { this.listeners.get(type)?.delete(l) }
  emit(type: string) { for (const l of [...(this.listeners.get(type) ?? [])]) l() }
}

class FakeTrack extends Emitter {
  readyState = "live"
  stopped = false
  stop() { this.stopped = true; this.readyState = "ended" }
}

class FakeSessionContext extends FakeAudioContext implements VoiceAudioContext {
  private emitter = new Emitter()
  state = "running"
  resume = vi.fn(async () => { this.state = "running" })
  close = vi.fn(async () => { this.state = "closed" })
  addEventListener(type: "statechange", l: () => void) { this.emitter.addEventListener(type, l) }
  removeEventListener(type: "statechange", l: () => void) { this.emitter.removeEventListener(type, l) }
  setState(state: string) { this.state = state; this.emitter.emit("statechange") }
}

class FakeSocket implements VoiceSocketLike {
  isOpen = true
  frames: VoiceClientFrame[] = []
  audio: Int16Array[] = []
  closed: { code?: number; reason?: string } | null = null
  constructor(readonly handlers: VoiceSocketHandlers) {}
  send(frame: VoiceClientFrame) { if (!this.isOpen) return false; this.frames.push(frame); return true }
  sendAudio(p: Int16Array) { if (!this.isOpen) return false; this.audio.push(p); return true }
  close(code?: number, reason?: string) { if (!this.isOpen) return; this.isOpen = false; this.closed = { code, reason }; this.handlers.onClose({ code: code ?? 1000, reason: reason ?? "" }) }
  serverFrame(frame: VoiceServerFrame) { this.handlers.onFrame(frame) }
  serverAudio(segmentId: number, samples = 480) { this.handlers.onAudio({ seq: 0, segmentId, pcm: pcm(samples) }) }
  drop(code: number) { this.isOpen = false; this.handlers.onClose({ code, reason: "" }) }
  types() { return this.frames.map((f) => f.type) }
}

const READY: VoiceServerFrame = {
  type: "ready", protocol: 1, sessionId: "s",
  input: { encoding: "pcm16", sampleRate: 16000 }, output: { encoding: "pcm16", sampleRate: 24000 },
  stt: { provider: "local", partials: true }, tts: { provider: "local", voice: null },
  onset: { threshold: 0.02, minSpeechMs: 250 }, backgrounding: "native", limits: { maxUtteranceSeconds: 60 },
}

/** One 20 ms frame at an RMS level. */
function frameAt(level: number): Int16Array {
  const out = new Int16Array(320)
  for (let i = 0; i < 320; i++) out[i] = floatToInt16(level * Math.SQRT2 * Math.sin((2 * Math.PI * 200 * i) / 16000))
  return out
}

class FakeDocument extends Emitter {
  visibilityState = "visible"
  set(state: "visible" | "hidden") { this.visibilityState = state; this.emit("visibilitychange") }
}

interface Rig {
  session: BrowserVoiceSession
  calls: string[]
  sockets: FakeSocket[]
  contexts: FakeSessionContext[]
  tracks: FakeTrack[]
  doc: FakeDocument
  mediaSession: { metadata: unknown; playbackState: string; setActionHandler: ReturnType<typeof vi.fn> }
  emitCapture: (pcmFrame: Int16Array) => void
  micError: { value: unknown }
  clock: { now: number }
  captureStops: ReturnType<typeof vi.fn>
}

function rig(options: Partial<{ mode: "hands-free" | "push-to-talk"; bargeIn: boolean }> = {}): Rig {
  const calls: string[] = []
  const sockets: FakeSocket[] = []
  const contexts: FakeSessionContext[] = []
  const tracks: FakeTrack[] = []
  const doc = new FakeDocument()
  const micError = { value: null as unknown }
  const clock = { now: 1_000_000 }
  const captureStops = vi.fn()
  let sink: (p: Int16Array) => void = () => {}
  const mediaSession = { metadata: null as unknown, playbackState: "none", setActionHandler: vi.fn() }
  const deps: BrowserVoiceDeps = {
    openSocket: (_id, handlers) => { calls.push("socket"); const s = new FakeSocket(handlers); sockets.push(s); return s },
    createContext: () => { calls.push("context"); const c = new FakeSessionContext(); contexts.push(c); const resume = c.resume; c.resume = vi.fn(async () => { calls.push("resume"); return resume() }); return c },
    requestMicrophone: () => {
      calls.push("microphone")
      if (micError.value) return Promise.reject(micError.value)
      const track = new FakeTrack(); tracks.push(track)
      return Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream)
    },
    startCapture: async (_ctx, stream, onFrame) => {
      sink = onFrame
      const track = (stream as unknown as { getAudioTracks(): FakeTrack[] }).getAudioTracks()[0]
      return { track, stop: () => { captureStops(); track.stop() } }
    },
    createPlayer: (ctx, onPlayed) => new VoicePlayer(ctx, { onPlayed }),
    doc,
    mediaSession,
    createMediaMetadata: () => ({ title: "Voice mode is on" }),
    now: () => clock.now,
  }
  const session = new BrowserVoiceSession({ sessionId: "s1", mode: options.mode ?? "hands-free", bargeIn: options.bargeIn ?? true }, deps)
  return { session, calls, sockets, contexts, tracks, doc, mediaSession, emitCapture: (f) => sink(f), micError, clock, captureStops }
}

async function started(options?: Parameters<typeof rig>[0]) {
  const r = rig(options)
  await r.session.start()
  r.sockets[0].serverFrame(READY)
  return r
}

beforeEach(() => { vi.useRealTimers() })

describe("starting from a tap", () => {
  it("creates the context, resumes it, asks for the microphone and opens the socket before any await (iOS)", () => {
    const r = rig()
    void r.session.start()
    // Nothing has been awaited yet: all four ran inside the synchronous part of start().
    expect(r.calls).toEqual(["context", "resume", "microphone", "socket"])
  })

  it("is connecting until the gateway says ready, then listening", async () => {
    const r = rig()
    await r.session.start()
    expect(voicePhase(r.session.getSnapshot())).toBe("connecting")
    r.sockets[0].serverFrame(READY)
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
  })

  it("a second start while running does nothing", async () => {
    const r = await started()
    await r.session.start()
    expect(r.sockets).toHaveLength(1)
  })

  it("a refused microphone is reported and everything is released", async () => {
    const r = rig()
    r.micError.value = new DOMException("denied", "NotAllowedError")
    await r.session.start()
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: "Microphone permission was denied." })
    expect(r.sockets[0].closed).not.toBeNull()
    expect(r.contexts[0].close).toHaveBeenCalled()
  })
})

describe("audio up", () => {
  it("sends nothing until the gateway is ready", async () => {
    const r = rig()
    await r.session.start()
    r.emitCapture(frameAt(0.1))
    expect(r.sockets[0].audio).toHaveLength(0)
    r.sockets[0].serverFrame(READY)
    r.emitCapture(frameAt(0.1))
    expect(r.sockets[0].audio).toHaveLength(1)
  })

  it("hands-free sends every frame continuously", async () => {
    const r = await started()
    for (let i = 0; i < 5; i++) r.emitCapture(frameAt(0.001))
    expect(r.sockets[0].audio).toHaveLength(5)
  })

  it("push-to-talk sends only between ptt_down and ptt_up", async () => {
    const r = await started({ mode: "push-to-talk" })
    r.emitCapture(frameAt(0.1))
    r.session.pttDown()
    r.emitCapture(frameAt(0.1))
    r.emitCapture(frameAt(0.1))
    r.session.pttUp()
    r.emitCapture(frameAt(0.1))
    expect(r.sockets[0].audio).toHaveLength(2)
    expect(r.sockets[0].types()).toEqual(["ptt_down", "ptt_up"])
  })

  it("ptt calls mean nothing in hands-free mode", async () => {
    const r = await started()
    r.session.pttDown()
    expect(r.sockets[0].frames).toHaveLength(0)
  })
})

describe("playback and barge-in", () => {
  function speak(r: Rig, id = 1) {
    r.sockets[0].serverFrame({ type: "turn", state: "speaking" })
    r.sockets[0].serverFrame({ type: "segment_start", segmentId: id, messageId: null, text: "Hello there." })
    r.sockets[0].serverAudio(id, 12_000)
  }
  const ctx = (r: Rig) => r.contexts[0]

  it("plays a segment and reports it played when it finishes", async () => {
    const r = await started()
    speak(r)
    r.sockets[0].serverFrame({ type: "segment_end", segmentId: 1 })
    ctx(r).sources[0].finish()
    expect(r.sockets[0].frames).toContainEqual({ type: "played", segmentId: 1 })
  })

  it("stops playback and sends barge_in once speech holds over playback, with how much was heard", async () => {
    const r = await started()
    speak(r)
    ctx(r).currentTime = ctx(r).sources[0].startedAt! + 0.3
    for (let i = 0; i < 12; i++) r.emitCapture(frameAt(0.1))
    expect(r.sockets[0].types()).not.toContain("barge_in")
    r.emitCapture(frameAt(0.1)) // the 13th frame completes 260 ms
    expect(ctx(r).sources.every((s) => s.stoppedAt === 0)).toBe(true)
    expect(r.sockets[0].frames.filter((f) => f.type === "barge_in")).toEqual([{ type: "barge_in", segmentId: 1, playedMs: 300 }])
  })

  it("the flush happens in the same call that processed the frame, not later", async () => {
    vi.useFakeTimers()
    const r = rig()
    await r.session.start()
    r.sockets[0].serverFrame(READY)
    speak(r)
    for (let i = 0; i < 13; i++) r.emitCapture(frameAt(0.1))
    expect(ctx(r).sources[0].stoppedAt).toBe(0)
    vi.useRealTimers()
  })

  it("keeps sending audio up while playback is cut: the gateway needs the utterance", async () => {
    const r = await started()
    speak(r)
    for (let i = 0; i < 20; i++) r.emitCapture(frameAt(0.1))
    expect(r.sockets[0].audio).toHaveLength(20)
  })

  it("does not interrupt on quiet noise or echo-level audio", async () => {
    const r = await started()
    speak(r)
    for (let i = 0; i < 200; i++) r.emitCapture(frameAt(0.01))
    expect(r.sockets[0].types()).not.toContain("barge_in")
    expect(ctx(r).sources[0].stoppedAt).toBeNull()
  })

  it("does not fire when nothing is playing", async () => {
    const r = await started()
    for (let i = 0; i < 50; i++) r.emitCapture(frameAt(0.2))
    expect(r.sockets[0].types()).not.toContain("barge_in")
  })

  it("does nothing on speech when barge-in is turned off in the config", async () => {
    const r = await started({ bargeIn: false })
    speak(r)
    for (let i = 0; i < 40; i++) r.emitCapture(frameAt(0.2))
    expect(r.sockets[0].types()).not.toContain("barge_in")
    expect(ctx(r).sources[0].stoppedAt).toBeNull()
  })

  it("flushes on the gateway's stop_playback without sending barge_in", async () => {
    const r = await started()
    speak(r)
    r.sockets[0].serverFrame({ type: "stop_playback", reason: "speech" })
    expect(ctx(r).sources[0].stoppedAt).toBe(0)
    expect(r.sockets[0].types()).not.toContain("barge_in")
  })

  it("drops audio that was already in flight for the interrupted reply", async () => {
    const r = await started()
    speak(r)
    r.sockets[0].serverFrame({ type: "stop_playback", reason: "speech" })
    const count = ctx(r).sources.length
    r.sockets[0].serverAudio(1)
    expect(ctx(r).sources).toHaveLength(count)
  })

  it("uses the onset settings the gateway sent in ready", async () => {
    const r = rig()
    await r.session.start()
    r.sockets[0].serverFrame({ ...READY, onset: { threshold: 0.5, minSpeechMs: 40 } })
    speak(r)
    for (let i = 0; i < 10; i++) r.emitCapture(frameAt(0.2))
    expect(r.sockets[0].types()).not.toContain("barge_in")
    r.emitCapture(frameAt(0.6))
    r.emitCapture(frameAt(0.6))
    expect(r.sockets[0].types()).toContain("barge_in")
  })
})

describe("stopping", () => {
  it("says bye, closes, releases the microphone and the context, and sends nothing more", async () => {
    const r = await started()
    r.session.stop()
    expect(r.sockets[0].frames.at(-1)).toEqual({ type: "bye" })
    expect(r.sockets[0].closed).toEqual({ code: 1000, reason: "bye" })
    expect(r.captureStops).toHaveBeenCalled()
    expect(r.tracks[0].stopped).toBe(true)
    expect(r.contexts[0].close).toHaveBeenCalled()
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: null })
    r.emitCapture(frameAt(0.1))
    expect(r.sockets[0].audio).toHaveLength(0)
  })

  it("never shows a lost-connection error while stopping on request", async () => {
    const r = await started()
    const errors: Array<string | null> = []
    r.session.subscribe(() => errors.push(r.session.getSnapshot().error))
    r.session.stop()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((e) => e === null)).toBe(true)
  })

  it("dispose (leaving the chat) stops capture", async () => {
    const r = await started()
    r.session.dispose()
    expect(r.tracks[0].stopped).toBe(true)
  })

  it("an unexpected close releases the microphone and explains why", async () => {
    const r = await started()
    r.sockets[0].drop(4409)
    expect(r.session.getSnapshot().error).toMatch(/already in use/)
    expect(r.tracks[0].stopped).toBe(true)
    expect(r.contexts[0].close).toHaveBeenCalled()
  })

  it("a plain socket drop on a visible page, no suspension and no resume: it ends with a message, and a tap gets back in", async () => {
    const r = await started()
    expect(r.doc.visibilityState).toBe("visible")
    r.sockets[0].drop(1006)
    // Not left showing "on": the mode is off, the person is told, and nothing keeps capturing.
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: "Voice connection lost." })
    expect(r.tracks[0].stopped).toBe(true)
    expect(r.contexts[0].close).toHaveBeenCalled()
    r.emitCapture(frameAt(0.1))
    expect(r.sockets[0].audio).toHaveLength(0)
    // The tap that starts it again is a new run on a new socket, and it needs no `resume`.
    await r.session.start()
    r.sockets[1].serverFrame(READY)
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
    expect(r.sockets[1].types()).not.toContain("resume")
  })

  it("a detached frame ends voice mode with the gateway's reason and releases everything", async () => {
    const r = await started()
    r.sockets[0].serverFrame({ type: "detached", reason: "disabled" })
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: "Voice was turned off on the gateway." })
    expect(r.tracks[0].stopped).toBe(true)
    expect(r.captureStops).toHaveBeenCalled()
    expect(r.contexts[0].close).toHaveBeenCalled()
    expect(r.sockets[0].isOpen).toBe(false)
    r.emitCapture(frameAt(0.1))
    expect(r.sockets[0].audio).toHaveLength(0)
  })

  it("after a detach a tap starts one clean run, not a second one beside the first", async () => {
    const r = await started()
    r.sockets[0].serverFrame({ type: "detached", reason: "taken_over" })
    await r.session.start()
    r.sockets[1].serverFrame(READY)
    expect(r.contexts).toHaveLength(2)
    expect(r.contexts[0].close).toHaveBeenCalled()
    expect(r.tracks[0].stopped).toBe(true)
    expect(r.sockets[0].isOpen).toBe(false)
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
  })
})

describe("media session", () => {
  it("shows voice mode on once ready, stops it from the lock screen, and removes itself afterwards", async () => {
    const r = await started()
    expect(r.mediaSession.metadata).toEqual({ title: "Voice mode is on" })
    const stop = r.mediaSession.setActionHandler.mock.calls.find(([a]) => a === "stop")?.[1] as () => void
    stop()
    expect(r.session.getSnapshot().status).toBe("off")
    expect(r.mediaSession.metadata).toBeNull()
  })
})

describe("suspension and return", () => {
  it("a muted microphone on a hidden page shows the device notice; return sends resume with how long", async () => {
    const r = await started()
    r.doc.set("hidden")
    r.clock.now += 45_000
    r.tracks[0].emit("mute")
    expect(voicePhase(r.session.getSnapshot())).toBe("suspended")
    expect(r.session.getSnapshot().notice).toBe("Voice mode was suspended by the device.")
    r.clock.now += 15_000
    r.tracks[0].emit("unmute")
    r.doc.set("visible")
    await vi.waitFor(() => expect(r.sockets[0].frames).toContainEqual({ type: "resume", suspendedMs: 60_000 }))
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
    expect(r.session.getSnapshot().needsTap).toBe(false)
  })

  it("a context that stays suspended after return asks for a tap", async () => {
    vi.useFakeTimers()
    const r = await started()
    r.doc.set("hidden")
    r.contexts[0].setState("suspended")
    r.contexts[0].resume.mockImplementation(() => new Promise(() => {})) // no gesture, so it never resolves
    r.doc.set("visible")
    await vi.advanceTimersByTimeAsync(500)
    expect(r.session.getSnapshot().needsTap).toBe(true)
    expect(r.sockets[0].types()).not.toContain("resume")
  })

  it("a socket lost while hidden is not reopened by itself; a tap reopens it and resume follows ready", async () => {
    vi.useFakeTimers()
    const r = await started()
    r.doc.set("hidden")
    r.clock.now += 90_000
    r.sockets[0].drop(1006)
    r.doc.set("visible")
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(r.sockets).toHaveLength(1) // no reconnect without a gesture
    expect(r.session.getSnapshot()).toMatchObject({ status: "suspended", needsTap: true })

    r.calls.length = 0
    const tapped = r.session.resumeFromTap()
    // Inside the tap, before any await: the context is resumed and the socket reopened.
    expect(r.calls).toEqual(["resume", "socket"])
    await tapped
    expect(r.sockets).toHaveLength(2)
    expect(r.session.getSnapshot().status).toBe("connecting")
    r.sockets[1].serverFrame(READY)
    expect(r.sockets[1].frames.map((f) => f.type)).toContain("resume")
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
  })

  it("a tap after the microphone track ended asks for a new microphone inside the tap", async () => {
    vi.useFakeTimers()
    const r = await started()
    r.doc.set("hidden")
    r.tracks[0].readyState = "ended"
    r.tracks[0].emit("ended")
    r.doc.set("visible")
    await vi.advanceTimersByTimeAsync(500)
    expect(r.session.getSnapshot().needsTap).toBe(true)
    r.calls.length = 0
    const tapped = r.session.resumeFromTap()
    expect(r.calls).toContain("microphone")
    await tapped
    expect(r.tracks).toHaveLength(2)
  })

  it("missed replies are announced, and their audio is played like any other", async () => {
    const r = await started()
    r.sockets[0].serverFrame({ type: "missed", messageIds: ["m1"] })
    expect(r.session.getSnapshot().notice).toMatch(/finished while you were away/)
    r.sockets[0].serverFrame({ type: "segment_start", segmentId: 9, messageId: "m1", text: "It is done." })
    r.sockets[0].serverAudio(9, 12_000)
    expect(r.contexts[0].sources).toHaveLength(1)
  })
})

describe("reconnecting", () => {
  it("never opens a second socket without a user gesture, whatever the close", async () => {
    vi.useFakeTimers()
    const r = await started()
    r.sockets[0].drop(1006)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(r.sockets).toHaveLength(1)
    expect(r.session.getSnapshot().status).toBe("off")
  })

  it("starting again after a close is a fresh run", async () => {
    const r = await started()
    r.sockets[0].drop(1006)
    await r.session.start()
    expect(r.sockets).toHaveLength(2)
    expect(r.contexts).toHaveLength(2)
  })
})
