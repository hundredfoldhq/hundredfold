import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { VoiceClientFrame, VoiceServerFrame } from "@hundredfold/gateway-events"
import type { VoiceCuePlayerLike } from "../cues"
import { floatToInt16 } from "../pcm"
import { MUTED_RETURN_WAIT_MS } from "../suspend"
import { VoicePlayer } from "../player"
import type { VoiceSessionStarter } from "../controller"
import { BrowserVoiceSession, type BrowserVoiceDeps, type VoiceAudioContext, type VoiceSocketLike } from "../session"
import { VoiceSocket, type VoiceSocketHandlers } from "../socket"
import { voicePhase } from "../state"
import { clearDebugLog, getDebugLog } from "@/lib/debug-log"
import { GATEWAY_SOCKET_OPEN, type GatewaySocketConnection } from "@/lib/gateway-transport"
import { resetVoiceLog, setVoiceDebug } from "@/lib/voice-log"
import { FakeAudioContext, pcm } from "./fakes"

class Emitter {
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, l: () => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(l) }
  removeEventListener(type: string, l: () => void) { this.listeners.get(type)?.delete(l) }
  emit(type: string) { for (const l of [...(this.listeners.get(type) ?? [])]) l() }
  listenerCount() { let n = 0; for (const set of this.listeners.values()) n += set.size; return n }
}

class FakeTrack extends Emitter {
  readyState = "live"
  muted = false
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
  /** The session id of each socket opened. */
  opened: string[]
  sockets: FakeSocket[]
  contexts: FakeSessionContext[]
  tracks: FakeTrack[]
  doc: FakeDocument
  mediaSession: { metadata: unknown; playbackState: string; setActionHandler: ReturnType<typeof vi.fn> }
  emitCapture: (pcmFrame: Int16Array) => void
  micError: { value: unknown }
  clock: { now: number }
  captureStops: ReturnType<typeof vi.fn>
  /** What the cue player was told, in order: `thinking@0.3`, `tool@0.3`, `stop`. */
  cues: string[]
  /** Pending prompts and worklet loads, when the rig was built to defer them. */
  micGates: Gate<MediaStream>[]
  captureGates: Gate<void>[]
  wakeLock: { request: ReturnType<typeof vi.fn>; sentinels: Array<{ released: boolean; drop(): void }> }
}

interface Gate<T> { open(value: T extends void ? void : T): void; fail(error: unknown): void }

function rig(options: Partial<{ mode: "hands-free" | "push-to-talk"; bargeIn: boolean; deferMic: boolean; deferCapture: boolean; sessionId: string | VoiceSessionStarter }> = {}): Rig {
  const micGates: Gate<MediaStream>[] = []
  const captureGates: Gate<void>[] = []
  const calls: string[] = []
  const opened: string[] = []
  const sockets: FakeSocket[] = []
  const contexts: FakeSessionContext[] = []
  const tracks: FakeTrack[] = []
  const doc = new FakeDocument()
  const micError = { value: null as unknown }
  const clock = { now: 1_000_000 }
  const captureStops = vi.fn()
  let sink: (p: Int16Array) => void = () => {}
  const wakeLock = {
    sentinels: [] as Array<{ released: boolean; drop(): void }>,
    request: vi.fn(async (_type: "screen") => {
      const listeners: Array<() => void> = []
      const sentinel = {
        released: false,
        release: async () => { sentinel.released = true },
        addEventListener: (_t: "release", l: () => void) => { listeners.push(l) },
        drop: () => { sentinel.released = true; for (const l of listeners) l() },
      }
      wakeLock.sentinels.push(sentinel)
      return sentinel
    }),
  }
  const mediaSession = { metadata: null as unknown, playbackState: "none", setActionHandler: vi.fn() }
  const cues: string[] = []
  const cuePlayer: VoiceCuePlayerLike = {
    set: (cue, volume) => { const call = cue ? `${cue}@${volume}` : "stop"; if (cues.at(-1) !== call) cues.push(call) },
    dispose: () => { if (cues.at(-1) !== "stop") cues.push("stop") },
  }
  const deps: BrowserVoiceDeps = {
    openSocket: (id, handlers) => { calls.push("socket"); opened.push(id); const s = new FakeSocket(handlers); sockets.push(s); return s },
    createContext: () => { calls.push("context"); const c = new FakeSessionContext(); contexts.push(c); const resume = c.resume; c.resume = vi.fn(async () => { calls.push("resume"); return resume() }); return c },
    requestMicrophone: () => {
      calls.push("microphone")
      if (micError.value) return Promise.reject(micError.value)
      const track = new FakeTrack(); tracks.push(track)
      const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
      if (!options.deferMic) return Promise.resolve(stream)
      return new Promise<MediaStream>((resolve, reject) => { micGates.push({ open: () => resolve(stream), fail: reject }) })
    },
    startCapture: async (_ctx, stream, onFrame) => {
      if (options.deferCapture) await new Promise<void>((resolve, reject) => { captureGates.push({ open: resolve, fail: reject }) })
      sink = onFrame
      const track = (stream as unknown as { getAudioTracks(): FakeTrack[] }).getAudioTracks()[0]
      return { track, stop: () => { captureStops(); track.stop() } }
    },
    createPlayer: (ctx, onPlayed) => new VoicePlayer(ctx, { onPlayed }),
    createCuePlayer: () => cuePlayer,
    doc,
    mediaSession,
    wakeLock,
    createMediaMetadata: () => ({ title: "Voice mode is on" }),
    now: () => clock.now,
  }
  const session = new BrowserVoiceSession({ sessionId: options.sessionId ?? "s1", mode: options.mode ?? "hands-free", bargeIn: options.bargeIn ?? true }, deps)
  return { session, calls, opened, sockets, contexts, tracks, doc, mediaSession, emitCapture: (f) => sink(f), micError, clock, captureStops, cues, micGates, captureGates, wakeLock }
}

async function started(options?: Parameters<typeof rig>[0]) {
  const r = rig(options)
  await r.session.start()
  r.sockets[0].serverFrame(READY)
  return r
}

beforeEach(() => { vi.useRealTimers(); resetVoiceLog() })

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

/** Every microphone track the run asked for is stopped, and none still has a listener. */
function expectNothingLive(r: Rig) {
  expect(r.tracks.length).toBeGreaterThan(0)
  expect(r.tracks.map((t) => t.stopped)).toEqual(r.tracks.map(() => true))
  expect(r.tracks.map((t) => t.listenerCount())).toEqual(r.tracks.map(() => 0))
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("stopping while startup is pending", () => {
  it("a stop before the worklet loads leaves no live track and no listener", async () => {
    const r = rig({ deferCapture: true })
    const starting = r.session.start()
    await flush()
    r.session.stop()
    r.captureGates[0].open()
    await starting
    expectNothingLive(r)
    expect(r.captureStops).toHaveBeenCalled()
    expect(r.session.getSnapshot().status).toBe("off")
  })

  it("a worklet that fails because a stop closed the audio context releases the microphone, with no error note", async () => {
    const r = rig({ deferCapture: true })
    const starting = r.session.start()
    await flush()
    r.session.stop()
    r.captureGates[0].fail(new DOMException("The AudioContext is closed.", "InvalidStateError"))
    await starting
    expectNothingLive(r)
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: null })
  })

  it("a worklet that fails to load releases the microphone stream", async () => {
    const r = rig({ deferCapture: true })
    const starting = r.session.start()
    await flush()
    r.captureGates[0].fail(new Error("worklet blocked"))
    await starting
    expectNothingLive(r)
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: "Microphone unavailable: worklet blocked" })
  })

  it("a stop while the microphone prompt is open stops the stream once it is granted", async () => {
    const r = rig({ deferMic: true })
    const starting = r.session.start()
    r.session.stop()
    r.micGates[0].open({} as MediaStream)
    await starting
    expectNothingLive(r)
  })

  it("a stop while a replacement microphone is pending stops that stream too", async () => {
    const r = rig({ deferMic: true })
    const starting = r.session.start()
    r.micGates[0].open({} as MediaStream)
    await starting
    r.sockets[0].serverFrame(READY)
    r.tracks[0].readyState = "ended"
    const resuming = r.session.resumeFromTap()
    r.session.stop()
    r.micGates[1].open({} as MediaStream)
    await resuming
    expectNothingLive(r)
  })

  it("a stale failure does not report or disturb a stopped run", async () => {
    const r = rig({ deferMic: true })
    const starting = r.session.start()
    r.session.stop()
    r.micGates[0].fail(new DOMException("denied", "NotAllowedError"))
    await starting
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: null })
  })
})

describe("start, stop, start while the first prompt is pending", () => {
  it("the first run's stream is stopped and does not attach to the second run", async () => {
    const r = rig({ deferMic: true })
    const first = r.session.start()
    r.session.stop()
    const second = r.session.start()
    // The first prompt is granted late, after the second start reset the session.
    r.micGates[0].open({} as MediaStream)
    await first
    expect(r.tracks[0].stopped).toBe(true)
    expect(r.tracks[0].listenerCount()).toBe(0)
    // The stale stream is dropped before the worklet: it is never wired into the new run's context.
    expect(r.captureStops).not.toHaveBeenCalled()
    expect(r.tracks[1].stopped).toBe(false)
    r.micGates[1].open({} as MediaStream)
    await second
    r.sockets[1].serverFrame(READY)
    expect(r.session.getSnapshot().status).toBe("on")
    expect(r.tracks[1].stopped).toBe(false)
    r.session.stop()
    expectNothingLive(r)
  })

  it("the first run's late refusal does not tear down the second run", async () => {
    const r = rig({ deferMic: true })
    const first = r.session.start()
    r.session.stop()
    const second = r.session.start()
    r.micGates[0].fail(new DOMException("denied", "NotAllowedError"))
    await first
    r.micGates[1].open({} as MediaStream)
    await second
    r.sockets[1].serverFrame(READY)
    expect(r.session.getSnapshot()).toMatchObject({ status: "on", error: null })
    expect(r.sockets[1].isOpen).toBe(true)
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

  it("logs the audio still in flight after a local barge-in at debug, not as a warning", async () => {
    const r = await started()
    speak(r)
    for (let i = 0; i < 13; i++) r.emitCapture(frameAt(0.1))
    expect(r.sockets[0].types()).toContain("barge_in")
    clearDebugLog()
    setVoiceDebug(true)
    for (let i = 0; i < 5; i++) r.sockets[0].serverAudio(1)
    const log = getDebugLog()
    expect(log).not.toContain("event=audio_without_segment")
    expect(log.split("\n").filter((l) => l.includes("event=audio_after_cut segment=1"))).toHaveLength(5)
  })

  it("logs the audio still in flight after stop_playback at debug, not as a warning", async () => {
    const r = await started()
    speak(r)
    r.sockets[0].serverFrame({ type: "stop_playback", reason: "new_reply" })
    clearDebugLog()
    r.sockets[0].serverAudio(1)
    expect(getDebugLog()).not.toContain("event=audio_without_segment")
  })

  it("still warns about audio for a segment that was never started and not just cut", async () => {
    const r = await started()
    r.sockets[0].serverAudio(7)
    expect(getDebugLog()).toContain("event=audio_without_segment segment=7")
  })

  it("still warns about audio for a segment that was never started, straight after a cut", async () => {
    const r = await started()
    speak(r)
    r.sockets[0].serverFrame({ type: "stop_playback", reason: "speech" })
    clearDebugLog()
    r.sockets[0].serverAudio(8)
    expect(getDebugLog()).toContain("event=audio_without_segment segment=8")
  })

  it("warns about audio for another segment once the cut is long past", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000)
    let log: string
    try {
      const r = await started()
      speak(r)
      r.sockets[0].serverFrame({ type: "stop_playback", reason: "speech" })
      now.mockReturnValue(15_000)
      clearDebugLog()
      r.sockets[0].serverAudio(1)
      r.sockets[0].serverAudio(8)
      log = getDebugLog()
    } finally {
      now.mockRestore()
    }
    expect(log).not.toContain("event=audio_without_segment segment=1")
    expect(log).toContain("event=audio_without_segment segment=8")
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

  it("an assistant hang-up releases the microphone and audio and leaves no error behind", async () => {
    const r = await started()
    r.sockets[0].serverFrame({ type: "detached", reason: "ended" })
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: null })
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

  it.each([
    [4429, /Too many/],
    [4404, /no longer exists/],
    [1006, /Voice connection lost/],
  ])("a reconnect that fails (close %i) just after the return is its own failure, not another device suspension", async (code, text) => {
    vi.useFakeTimers()
    const r = await started()
    r.doc.set("hidden")
    r.clock.now += 90_000
    r.sockets[0].drop(1006)
    r.doc.set("visible")
    await vi.advanceTimersByTimeAsync(100)
    expect(r.session.getSnapshot()).toMatchObject({ status: "suspended", needsTap: true })
    const tapped = r.session.resumeFromTap()
    r.clock.now += 500 // still inside the return grace
    await tapped
    r.sockets[1].drop(code)
    const snapshot = r.session.getSnapshot()
    expect(snapshot.status).toBe("off")
    expect(snapshot.error).toMatch(text)
    expect(snapshot.notice).toBeNull()
    expect(r.tracks[0].stopped).toBe(true)
    expect(r.contexts[0].close).toHaveBeenCalled()
  })

  it("a tap after the microphone track ended and could not be taken back asks for a new microphone inside the tap", async () => {
    vi.useFakeTimers()
    const r = await started()
    r.doc.set("hidden")
    r.tracks[0].readyState = "ended"
    r.tracks[0].emit("ended")
    r.micError.value = new DOMException("needs a gesture", "NotAllowedError")
    r.doc.set("visible")
    await vi.advanceTimersByTimeAsync(500)
    expect(r.session.getSnapshot().needsTap).toBe(true)
    r.micError.value = null
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

describe("screen wake lock", () => {
  it("holds a screen lock while voice mode is on and lets it go on stop", async () => {
    const r = await started()
    await vi.waitFor(() => expect(r.wakeLock.request).toHaveBeenCalledWith("screen"))
    await vi.waitFor(() => expect(r.wakeLock.sentinels).toHaveLength(1))
    r.session.stop()
    expect(r.wakeLock.sentinels[0].released).toBe(true)
  })

  it("asks again when the page returns, because the browser dropped the lock while it was hidden", async () => {
    const r = await started()
    await vi.waitFor(() => expect(r.wakeLock.sentinels).toHaveLength(1))
    r.doc.set("hidden")
    r.wakeLock.sentinels[0].drop()
    r.doc.set("visible")
    await vi.waitFor(() => expect(r.wakeLock.sentinels).toHaveLength(2))
    r.session.stop()
    expect(r.wakeLock.sentinels[1].released).toBe(true)
  })

  it("is let go when the gateway detaches the session, and not asked for again", async () => {
    const r = await started()
    await vi.waitFor(() => expect(r.wakeLock.sentinels).toHaveLength(1))
    r.sockets[0].serverFrame({ type: "detached", reason: "taken_over" })
    expect(r.wakeLock.sentinels[0].released).toBe(true)
    r.doc.set("hidden")
    r.doc.set("visible")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(r.wakeLock.sentinels).toHaveLength(1)
  })

  it("voice mode works without the API", async () => {
    const r = rig()
    ;(r.session as unknown as { deps: BrowserVoiceDeps }).deps.wakeLock = undefined
    await r.session.start()
    r.sockets[0].serverFrame(READY)
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
  })
})

describe("paused state and resume without a reload", () => {
  it("a microphone that ends is shown as paused, not as on", async () => {
    const r = await started()
    r.doc.set("hidden")
    r.tracks[0].readyState = "ended"
    r.tracks[0].emit("ended")
    expect(voicePhase(r.session.getSnapshot())).toBe("suspended")
    r.emitCapture(pcm(320)) // a dead mic's frames are not sent as if it were on
    expect(r.sockets[0].audio).toHaveLength(0)
  })

  it("finds a dead microphone on return even though no event arrived", async () => {
    const r = await started()
    r.doc.set("hidden")
    r.tracks[0].readyState = "ended"
    r.doc.set("visible")
    await vi.waitFor(() => expect(r.tracks).toHaveLength(2))
    await vi.waitFor(() => expect(voicePhase(r.session.getSnapshot())).toBe("listening"))
  })

  it("takes the microphone back on return without a tap, and resume follows", async () => {
    const r = await started()
    r.doc.set("hidden")
    r.clock.now += 30_000
    r.tracks[0].readyState = "ended"
    r.tracks[0].emit("ended")
    r.doc.set("visible")
    await vi.waitFor(() => expect(voicePhase(r.session.getSnapshot())).toBe("listening"))
    expect(r.tracks).toHaveLength(2)
    expect(r.tracks[1].readyState).toBe("live")
    expect(r.session.getSnapshot().needsTap).toBe(false)
    expect(r.sockets).toHaveLength(1)
    expect(r.sockets[0].frames).toContainEqual({ type: "resume", suspendedMs: 30_000 })
    r.emitCapture(pcm(320))
    expect(r.sockets[0].audio).toHaveLength(1) // audio flows from the new microphone
  })

  it("a microphone the browser will not hand over without a gesture shows one tap-to-resume", async () => {
    const r = await started()
    r.doc.set("hidden")
    r.tracks[0].readyState = "ended"
    r.tracks[0].emit("ended")
    r.micError.value = new DOMException("needs a gesture", "NotAllowedError")
    r.doc.set("visible")
    await vi.waitFor(() => expect(r.session.getSnapshot().needsTap).toBe(true))
    expect(voicePhase(r.session.getSnapshot())).toBe("suspended")
    expect(r.session.getSnapshot().error).toBeNull()
    r.micError.value = null
    await r.session.resumeFromTap()
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
    expect(r.sockets[0].frames.map((f) => f.type)).toContain("resume")
  })

  it("a microphone request that never settles asks for a tap, and lets a late stream go", async () => {
    vi.useFakeTimers()
    const r = await started({ deferMic: false })
    r.doc.set("hidden")
    r.tracks[0].readyState = "ended"
    r.tracks[0].emit("ended")
    // From here the microphone request stays pending.
    const deps = (r.session as unknown as { deps: BrowserVoiceDeps }).deps
    let grant!: (s: MediaStream) => void
    const late = new FakeTrack()
    deps.requestMicrophone = () => new Promise<MediaStream>((resolve) => { grant = resolve })
    r.doc.set("visible")
    await vi.advanceTimersByTimeAsync(2_500)
    expect(r.session.getSnapshot().needsTap).toBe(true)
    grant({ getTracks: () => [late] } as unknown as MediaStream)
    await vi.advanceTimersByTimeAsync(10)
    expect(late.stopped).toBe(true)
  })

  it("a lost socket still waits for a tap (no reconnect without a gesture) and does not ask for the microphone first", async () => {
    const r = await started()
    r.doc.set("hidden")
    r.tracks[0].readyState = "ended"
    r.tracks[0].emit("ended")
    r.sockets[0].drop(1006)
    r.doc.set("visible")
    await vi.waitFor(() => expect(r.session.getSnapshot().needsTap).toBe(true))
    expect(r.tracks).toHaveLength(1)
    expect(r.sockets).toHaveLength(1)
  })

  it("resuming asks the chat view to re-read, so replies that finished meanwhile appear", async () => {
    const r = await started()
    const before = r.session.getSnapshot().syncTick
    r.doc.set("hidden")
    r.tracks[0].emit("mute")
    r.tracks[0].emit("unmute")
    r.doc.set("visible")
    await vi.waitFor(() => expect(voicePhase(r.session.getSnapshot())).toBe("listening"))
    expect(r.session.getSnapshot().syncTick).toBeGreaterThan(before)
  })

  it("a microphone that stays muted after the page is back is taken back without a tap", async () => {
    vi.useFakeTimers()
    const r = await started({ deferMic: false })
    r.doc.set("hidden")
    r.tracks[0].muted = true
    r.tracks[0].emit("mute")
    r.doc.set("visible")
    expect(voicePhase(r.session.getSnapshot())).toBe("suspended") // no unmute has come
    await vi.advanceTimersByTimeAsync(MUTED_RETURN_WAIT_MS + 50)
    expect(r.tracks).toHaveLength(2)
    expect(r.tracks[0].stopped).toBe(true)
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
    expect(r.session.getSnapshot().needsTap).toBe(false)
    expect(r.sockets[0].frames.map((f) => f.type)).toContain("resume")
  })

  it("a tap on a microphone that is still muted asks for a new one", async () => {
    vi.useFakeTimers()
    const r = await started({ deferMic: false })
    r.doc.set("hidden")
    r.tracks[0].muted = true
    r.tracks[0].emit("mute")
    r.micError.value = new DOMException("needs a gesture", "NotAllowedError")
    r.doc.set("visible")
    await vi.advanceTimersByTimeAsync(MUTED_RETURN_WAIT_MS + 50)
    expect(r.session.getSnapshot().needsTap).toBe(true)
    r.micError.value = null
    await r.session.resumeFromTap()
    expect(r.tracks).toHaveLength(2)
    expect(r.tracks[1].readyState).toBe("live")
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
  })

  it("two returns that each ask for a microphone leave exactly one live, whichever answers first", async () => {
    for (const order of [[1, 2], [2, 1]] as const) {
      const r = rig({ deferMic: true })
      const starting = r.session.start()
      r.micGates[0].open({} as MediaStream)
      await starting
      r.sockets[0].serverFrame(READY)
      r.doc.set("hidden")
      r.tracks[0].readyState = "ended"
      r.tracks[0].emit("ended")
      r.doc.set("visible") // first return: its request is pending
      await vi.waitFor(() => expect(r.micGates).toHaveLength(2))
      r.doc.set("hidden")
      r.doc.set("visible") // second return before the first request answered
      await vi.waitFor(() => expect(r.micGates).toHaveLength(3))
      for (const n of order) { r.micGates[n].open({} as MediaStream); await new Promise((resolve) => setTimeout(resolve, 0)) }
      await vi.waitFor(() => expect(voicePhase(r.session.getSnapshot())).toBe("listening"))
      expect(r.tracks.filter((t) => !t.stopped)).toHaveLength(1)
      r.session.stop()
      expectNothingLive(r)
    }
  })

  it("a stop while the microphone is being taken back leaves no live track", async () => {
    const r = await started()
    r.doc.set("hidden")
    r.tracks[0].readyState = "ended"
    r.tracks[0].emit("ended")
    r.doc.set("visible")
    r.session.stop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(r.tracks.every((t) => t.stopped)).toBe(true)
    expect(voicePhase(r.session.getSnapshot())).toBe("off")
  })

  it("a tap while the automatic microphone request is still pending does not leave a tap asked for once that request times out", async () => {
    const r = rig({ deferMic: true })
    const starting = r.session.start()
    r.micGates[0].open({} as MediaStream)
    await starting
    r.sockets[0].serverFrame(READY)
    r.doc.set("hidden")
    r.tracks[0].readyState = "ended"
    r.tracks[0].emit("ended")
    vi.useFakeTimers()
    try {
      r.doc.set("visible") // request A, made without a tap, is pending
      await vi.advanceTimersByTimeAsync(0)
      expect(r.micGates).toHaveLength(2)
      const tapped = r.session.resumeFromTap() // request B, made inside the tap
      await vi.advanceTimersByTimeAsync(0)
      expect(r.micGates).toHaveLength(3)
      expect(r.session.getSnapshot()).toMatchObject({ status: "on", needsTap: false })
      await vi.advanceTimersByTimeAsync(2_500) // A gives up
      expect(r.session.getSnapshot()).toMatchObject({ status: "on", needsTap: false })
      r.micGates[2].open({} as MediaStream)
      await tapped
      await vi.advanceTimersByTimeAsync(0)
      expect(r.session.getSnapshot()).toMatchObject({ status: "on", needsTap: false })
      expect(voicePhase(r.session.getSnapshot())).toBe("listening")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a stop while the audio context is being woken on return leaves voice off, with no tap asked for", async () => {
    const r = await started()
    let wake: () => void = () => {}
    r.contexts[0].resume = vi.fn(() => new Promise<void>((resolve) => { wake = () => { r.contexts[0].state = "running"; resolve() } }))
    r.doc.set("hidden")
    r.contexts[0].setState("suspended")
    r.doc.set("visible")
    await vi.waitFor(() => expect(r.contexts[0].resume).toHaveBeenCalled())
    r.session.stop()
    wake()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(voicePhase(r.session.getSnapshot())).toBe("off")
    expect(r.session.getSnapshot().needsTap).toBe(false)
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

describe("sound cues", () => {
  const turn = (r: Rig, state: "idle" | "thinking" | "working" | "speaking", tool?: string) =>
    r.sockets[0].serverFrame({ type: "turn", state, ...(tool ? { tool } : {}) })
  const withCues = async (cues?: { enabled: boolean; volume: number }) => {
    const r = rig()
    await r.session.start()
    r.sockets[0].serverFrame({ ...READY, ...(cues ? { cues } : {}) })
    return r
  }
  const speak = (r: Rig, id = 1) => {
    turn(r, "speaking")
    r.sockets[0].serverFrame({ type: "segment_start", segmentId: id, messageId: null, text: "Done." })
    r.sockets[0].serverAudio(id, 12_000)
  }

  it("starts on thinking, switches on the first tool call, and stops on speech", async () => {
    const r = await withCues({ enabled: true, volume: 0.4 })
    expect(r.cues).toEqual([])
    turn(r, "thinking")
    turn(r, "working", "Bash")
    turn(r, "thinking")
    speak(r)
    expect(r.cues).toEqual(["thinking@0.4", "tool@0.4", "thinking@0.4", "stop"])
  })

  it("stops when voice stops", async () => {
    const r = await withCues()
    turn(r, "working", "Read")
    r.session.stop()
    expect(r.cues).toEqual(["tool@0.3", "stop"])
  })

  it("makes no cue player when a late frame arrives after voice stopped", async () => {
    const r = await withCues()
    turn(r, "working", "Read")
    r.session.stop()
    turn(r, "thinking")
    turn(r, "working", "Bash")
    expect(r.cues).toEqual(["tool@0.3", "stop"])
  })

  it("stops when the gateway detaches voice mode", async () => {
    const r = await withCues()
    turn(r, "thinking")
    r.sockets[0].serverFrame({ type: "detached", reason: "disabled" })
    expect(r.cues).toEqual(["thinking@0.3", "stop"])
  })

  it("stops when the turn ends with nothing to say", async () => {
    const r = await withCues()
    turn(r, "thinking")
    turn(r, "idle")
    expect(r.cues).toEqual(["thinking@0.3", "stop"])
  })

  it("never plays when cues are disabled, or at volume zero", async () => {
    for (const cues of [{ enabled: false, volume: 0.3 }, { enabled: true, volume: 0 }]) {
      const r = await withCues(cues)
      turn(r, "thinking")
      turn(r, "working", "Bash")
      speak(r)
      r.session.stop()
      expect(r.cues).toEqual([])
    }
  })

  it("plays at the defaults when the gateway sent no cue settings", async () => {
    const r = await withCues()
    turn(r, "thinking")
    expect(r.cues).toEqual(["thinking@0.3"])
  })

  it("is silent while the user is heard and comes back when they stop", async () => {
    const r = await withCues()
    turn(r, "thinking")
    r.sockets[0].serverFrame({ type: "vad", speaking: true })
    r.sockets[0].serverFrame({ type: "vad", speaking: false })
    expect(r.cues).toEqual(["thinking@0.3", "stop", "thinking@0.3"])
  })

  it("is silent while a live partial transcript is showing", async () => {
    const r = await withCues()
    turn(r, "thinking")
    r.sockets[0].serverFrame({ type: "transcript", utteranceId: "u", text: "wait", final: false })
    expect(r.cues.at(-1)).toBe("stop")
  })

  it("is silent while push-to-talk is held", async () => {
    const r = rig({ mode: "push-to-talk" })
    await r.session.start()
    r.sockets[0].serverFrame(READY)
    turn(r, "thinking")
    r.session.pttDown()
    r.session.pttUp()
    expect(r.cues).toEqual(["thinking@0.3", "stop", "thinking@0.3"])
  })

  it("a holding line spoken over long work silences the tool cue, which resumes when it has played", async () => {
    const r = await withCues()
    turn(r, "working", "Bash")
    r.sockets[0].serverFrame({ type: "holding", text: "Still working." })
    r.sockets[0].serverFrame({ type: "segment_start", segmentId: 4, messageId: null, text: "Still working." })
    r.sockets[0].serverAudio(4, 12_000)
    r.sockets[0].serverFrame({ type: "segment_end", segmentId: 4 })
    expect(r.cues).toEqual(["tool@0.3", "stop"])
    r.contexts[0].sources.at(-1)?.finish()
    expect(r.cues).toEqual(["tool@0.3", "stop", "tool@0.3"])
  })

  it("a tool moved to the background hands over to the thinking cue, and background work after the turn is silent", async () => {
    const r = await withCues()
    turn(r, "working", "Bash")
    r.sockets[0].serverFrame({ type: "background", taskId: "t1", description: "build" })
    expect(r.cues).toEqual(["tool@0.3", "thinking@0.3"])
    turn(r, "thinking")
    turn(r, "idle")
    expect(r.cues).toEqual(["tool@0.3", "thinking@0.3", "stop"])
  })

  it("a new tool call after a backgrounded one gets the tool cue again", async () => {
    const r = await withCues()
    turn(r, "working", "Bash")
    r.sockets[0].serverFrame({ type: "background", taskId: "t1", description: "build" })
    turn(r, "thinking")
    turn(r, "working", "Read")
    expect(r.cues).toEqual(["tool@0.3", "thinking@0.3", "tool@0.3"])
  })

  it("is silent while the device has suspended voice mode", async () => {
    const r = await withCues()
    turn(r, "thinking")
    r.doc.set("hidden")
    r.contexts[0].setState("suspended")
    r.doc.set("visible")
    expect(r.session.getSnapshot().status).toBe("suspended")
    expect(r.cues.at(-1)).toBe("stop")
  })

  it("does not arm the barge-in detector: a loud microphone while a cue plays sends no barge_in", async () => {
    const r = await withCues()
    turn(r, "thinking")
    for (let i = 0; i < 100; i++) r.emitCapture(frameAt(0.2))
    expect(r.sockets[0].types()).not.toContain("barge_in")
    expect(r.sockets[0].audio).toHaveLength(100)
  })

  it("a barge-in over speech does not bring a cue back before the turn asks for one", async () => {
    const r = await withCues()
    turn(r, "thinking")
    speak(r)
    for (let i = 0; i < 15; i++) r.emitCapture(frameAt(0.2))
    expect(r.sockets[0].types()).toContain("barge_in")
    expect(r.cues).toEqual(["thinking@0.3", "stop"])
  })

  it("a barge-in over a holding line brings the tool cue back at once, since the turn is still working and no frame follows", async () => {
    const r = await withCues()
    turn(r, "working", "Bash")
    r.sockets[0].serverFrame({ type: "segment_start", segmentId: 4, messageId: null, text: "Still working." })
    r.sockets[0].serverAudio(4, 12_000)
    for (let i = 0; i < 15; i++) r.emitCapture(frameAt(0.2))
    expect(r.sockets[0].types()).toContain("barge_in")
    expect(r.cues).toEqual(["tool@0.3", "stop", "tool@0.3"])
  })

  it("clamps a volume the gateway sent out of range, so a cue is never louder than the setting allows", async () => {
    const r = await withCues({ enabled: true, volume: 7 })
    turn(r, "thinking")
    expect(r.cues).toEqual(["thinking@1"])
  })
})

describe("starting on a chat that does not exist yet", () => {
  function starter() {
    let resolve!: (id: string) => void
    let reject!: (error: unknown) => void
    const create = vi.fn(() => new Promise<string>((res, rej) => { resolve = res; reject = rej }))
    const discard = vi.fn()
    const order: string[] = []
    const bind = vi.fn((id: string) => { order.push(`bind:${id}`) })
    return { create, bind, discard, order, resolve: (id: string) => resolve(id), reject: (e: unknown) => reject(e), api: { create, bind, discard } satisfies VoiceSessionStarter }
  }

  it("asks for the microphone inside the tap, creates the chat once, then opens the socket on it", async () => {
    const s = starter()
    const r = rig({ sessionId: s.api })
    const run = r.session.start()
    expect(r.calls).toEqual(["context", "resume", "microphone"])
    expect(s.create).toHaveBeenCalledTimes(1)
    expect(r.sockets).toHaveLength(0)
    expect(r.session.boundSessionId()).toBeNull()
    s.resolve("new-1")
    await run
    expect(r.opened).toEqual(["new-1"])
    expect(r.session.boundSessionId()).toBe("new-1")
    expect(s.create).toHaveBeenCalledTimes(1)
    expect(s.bind).toHaveBeenCalledExactlyOnceWith("new-1", r.session)
  })

  it("binds the pane to the chat only once the run is known to be live, before the conversation attaches", async () => {
    const s = starter()
    const r = rig({ sessionId: s.api })
    const deps = (r.session as unknown as { deps: BrowserVoiceDeps }).deps
    const open = deps.openSocket
    deps.openSocket = (id, handlers, mode) => { s.order.push(`socket:${id}`); return open(id, handlers, mode) }
    const run = r.session.start()
    expect(s.bind).not.toHaveBeenCalled()
    s.resolve("new-1")
    await run
    expect(s.order).toEqual(["bind:new-1", "socket:new-1"])
  })

  it("a second start while the chat is being created does nothing", async () => {
    const s = starter()
    const r = rig({ sessionId: s.api })
    const run = r.session.start()
    await r.session.start()
    s.resolve("new-1")
    await run
    expect(s.create).toHaveBeenCalledTimes(1)
    expect(r.sockets).toHaveLength(1)
  })

  it("a creation that fails reports it, opens no socket and releases the microphone", async () => {
    const s = starter()
    const r = rig({ sessionId: s.api })
    const run = r.session.start()
    s.reject(new Error("The gateway refused to start a chat."))
    await run
    await Promise.resolve()
    expect(s.bind).not.toHaveBeenCalled()
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: "The gateway refused to start a chat." })
    expect(r.sockets).toHaveLength(0)
    expect(r.contexts[0].close).toHaveBeenCalled()
    await vi.waitFor(() => expect(r.tracks[0].stopped).toBe(true))
  })

  it("a stop before the chat exists discards the chat that then arrives and keeps the microphone released", async () => {
    const s = starter()
    const r = rig({ sessionId: s.api })
    const run = r.session.start()
    r.session.stop()
    s.resolve("new-1")
    await run
    expect(s.discard).toHaveBeenCalledWith("new-1")
    expect(s.bind).not.toHaveBeenCalled()
    expect(r.session.boundSessionId()).toBeNull()
    expect(r.sockets).toHaveLength(0)
    await vi.waitFor(() => expect(r.tracks[0].stopped).toBe(true))
  })

  it("a stop that lands while the capture is starting releases the capture and the microphone", async () => {
    const s = starter()
    const r = rig({ sessionId: s.api, deferCapture: true })
    const run = r.session.start()
    s.resolve("new-1")
    await vi.waitFor(() => expect(r.captureGates).toHaveLength(1))
    r.session.stop()
    r.captureGates[0].open()
    await run
    expect(r.captureStops).toHaveBeenCalled()
    expectNothingLive(r)
  })

  it("a capture that fails because a stop closed the audio context still releases the microphone, with no error note", async () => {
    const s = starter()
    const r = rig({ sessionId: s.api, deferCapture: true })
    const run = r.session.start()
    s.resolve("new-1")
    await vi.waitFor(() => expect(r.captureGates).toHaveLength(1))
    r.session.stop()
    r.captureGates[0].fail(new DOMException("The AudioContext is closed.", "InvalidStateError"))
    await run
    expectNothingLive(r)
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: null })
  })

  it("a chat that is already there never calls the starter", async () => {
    const s = starter()
    const r = rig({ sessionId: "s1" })
    await r.session.start()
    expect(s.create).not.toHaveBeenCalled()
    expect(r.opened).toEqual(["s1"])
  })
})

/** A connection that dies without a close event: it stays open, says nothing and ignores close(). */
class HalfOpenConnection implements GatewaySocketConnection {
  readyState = GATEWAY_SOCKET_OPEN
  binaryType: BinaryType = "blob"
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  closeCalls = 0
  addEventListener() {}
  send() {}
  close() { this.closeCalls++ }
  receive(data: unknown) { this.onmessage?.(new MessageEvent("message", { data })) }
}

describe("a connection that dies silently (keepalive)", () => {
  afterEach(() => { vi.useRealTimers() })

  /** A session whose socket is the real `VoiceSocket` over a half-open connection. */
  async function silent(keepaliveMs?: number) {
    vi.useFakeTimers()
    const r = rig()
    const connections: HalfOpenConnection[] = []
    const deps = (r.session as unknown as { deps: BrowserVoiceDeps }).deps
    deps.openSocket = (id, handlers, mode) => {
      const connection = new HalfOpenConnection()
      connections.push(connection)
      return VoiceSocket.open(id, handlers, { mode, open: () => connection })
    }
    await r.session.start()
    connections[0].receive(JSON.stringify({ ...READY, ...(keepaliveMs === undefined ? {} : { keepaliveMs }) }))
    return { ...r, connection: connections[0] }
  }

  it("ends voice with 'Voice connection lost.' after the timeout and releases the microphone and audio", async () => {
    const r = await silent(10_000)
    expect(r.session.getSnapshot().status).toBe("on")
    vi.advanceTimersByTime(20_000)
    expect(r.session.getSnapshot().status).toBe("on")
    expect(r.tracks[0].stopped).toBe(false)
    vi.advanceTimersByTime(10_000)
    const state = r.session.getSnapshot()
    expect(state.status).toBe("off")
    expect(state.error).toBe("Voice connection lost.")
    expect(r.tracks[0].stopped).toBe(true)
    expect(r.captureStops).toHaveBeenCalledTimes(1)
    expect(r.contexts[0].close).toHaveBeenCalled()
    expect(r.connection.closeCalls).toBeGreaterThanOrEqual(1)
  })

  it("keeps voice on while keepalive frames arrive", async () => {
    const r = await silent(10_000)
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(10_000)
      r.connection.receive(JSON.stringify({ type: "keepalive" }))
    }
    expect(r.session.getSnapshot().status).toBe("on")
    expect(r.tracks[0].stopped).toBe(false)
  })

  it("without keepaliveMs in ready there is no watchdog", async () => {
    const r = await silent()
    vi.advanceTimersByTime(60 * 60_000)
    expect(r.session.getSnapshot().status).toBe("on")
    expect(r.tracks[0].stopped).toBe(false)
  })

  it("a late tick after the page was suspended does not end voice by itself", async () => {
    const r = await silent(10_000)
    vi.advanceTimersByTime(10_000)
    vi.setSystemTime(Date.now() + 5 * 60_000)
    vi.advanceTimersByTime(5_000)
    expect(r.session.getSnapshot().status).toBe("on")
    expect(r.tracks[0].stopped).toBe(false)
  })
})

describe("start, stop and start again", () => {
  const live = (r: Rig) => r.tracks.filter((t) => t.readyState === "live")

  /** One whole run: tap, ready, the assistant speaks and is heard to the end, tap again. */
  async function oneRun(r: Rig, run: number) {
    await r.session.start()
    const socket = r.sockets[run]
    socket.serverFrame(READY)
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
    expect(live(r)).toHaveLength(1)
    r.emitCapture(frameAt(0.1))
    expect(socket.audio).toHaveLength(1)
    socket.serverFrame({ type: "turn", state: "speaking" })
    socket.serverFrame({ type: "segment_start", segmentId: 1, messageId: null, text: `Reply ${run}.` })
    socket.serverAudio(1, 4_800)
    socket.serverFrame({ type: "segment_end", segmentId: 1 })
    r.session.stop()
    expect(voicePhase(r.session.getSnapshot())).toBe("off")
    expect(socket.types()).toContain("bye")
    expect(live(r)).toHaveLength(0)
    expect(r.contexts[run].close).toHaveBeenCalled()
  }

  it("starts, stops and starts again three times in one chat, each a clean run on its own socket", async () => {
    const r = rig()
    for (let run = 0; run < 3; run += 1) await oneRun(r, run)
    expect(r.sockets).toHaveLength(3)
    expect(r.contexts).toHaveLength(3)
    // Nothing of an earlier run is still talking: the old sockets got only their own audio.
    expect(r.sockets.map((s) => s.audio.length)).toEqual([1, 1, 1])
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: null })
  })

  it("a second chat's own session starts while the first one's has run and stopped before", async () => {
    const first = rig({ sessionId: "s1" })
    await oneRun(first, 0)
    await oneRun(first, 1)
    const other = rig({ sessionId: "s2" })
    await oneRun(other, 0)
    expect(first.sockets).toHaveLength(2)
    expect(other.sockets).toHaveLength(1)
  })

  it("stopping and starting again at once, before the gateway answers, still ends in one live run", async () => {
    const r = rig()
    const firstStart = r.session.start()
    r.session.stop()
    await firstStart
    await r.session.start()
    r.sockets[1].serverFrame(READY)
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
    expect(r.sockets[0].closed).not.toBeNull()
    r.session.stop()
    expect(live(r)).toHaveLength(0)
  })

  it("after an error ends a run (a lost connection, a detach, a refused microphone) a tap starts the next", async () => {
    const r = rig()
    await r.session.start()
    r.sockets[0].serverFrame(READY)
    r.sockets[0].drop(1006)
    expect(r.session.getSnapshot()).toMatchObject({ status: "off", error: "Voice connection lost." })
    await r.session.start()
    r.sockets[1].serverFrame(READY)
    r.sockets[1].serverFrame({ type: "detached", reason: "taken_over" })
    expect(r.session.getSnapshot().status).toBe("off")
    r.micError.value = new DOMException("denied", "NotAllowedError")
    await r.session.start()
    expect(r.session.getSnapshot().error).toBe("Microphone permission was denied.")
    r.micError.value = null
    await r.session.start()
    r.sockets[3].serverFrame(READY)
    expect(voicePhase(r.session.getSnapshot())).toBe("listening")
    expect(live(r)).toHaveLength(1)
    expect(r.session.getSnapshot().error).toBeNull()
  })

  it("after a barge-in the next run starts with nothing left over from it", async () => {
    const r = rig()
    await r.session.start()
    r.sockets[0].serverFrame(READY)
    r.sockets[0].serverFrame({ type: "segment_start", segmentId: 1, messageId: null, text: "Long reply." })
    r.sockets[0].serverAudio(1, 12_000)
    r.sockets[0].serverFrame({ type: "stop_playback", reason: "new_reply" })
    r.session.stop()
    await r.session.start()
    r.sockets[1].serverFrame(READY)
    // A segment of the new run plays: the player of the old run does not swallow it or replay the old one.
    r.sockets[1].serverFrame({ type: "segment_start", segmentId: 1, messageId: null, text: "Fresh reply." })
    r.sockets[1].serverAudio(1, 4_800)
    expect(r.sockets[1].types()).toEqual([])
    r.emitCapture(frameAt(0.001))
    expect(r.sockets[1].audio).toHaveLength(1)
  })

  it("a new reply cuts the old one's playback on the gateway's stop and plays only the new text", async () => {
    const r = await started()
    const socket = r.sockets[0]
    socket.serverFrame({ type: "segment_start", segmentId: 1, messageId: null, text: "Old one." })
    socket.serverAudio(1, 12_000)
    socket.serverFrame({ type: "stop_playback", reason: "new_reply" })
    // Audio of the cut reply that was already in flight is dropped; the new reply's is played.
    socket.serverAudio(1, 4_800)
    socket.serverFrame({ type: "segment_start", segmentId: 2, messageId: null, text: "New answer." })
    socket.serverAudio(2, 4_800)
    const sources = r.contexts[0].sources
    // The old reply's first chunk was stopped; the dropped in-flight chunk made no source; the new text is playing.
    expect(sources).toHaveLength(2)
    expect(sources[0].stoppedAt).toBe(0)
    expect(sources[1].stoppedAt).toBeNull()
    expect(sources[1].startedAt).not.toBeNull()
    expect(socket.types()).not.toContain("barge_in")
  })
})
