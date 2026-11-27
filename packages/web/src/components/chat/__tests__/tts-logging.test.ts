/**
 * The read-aloud path writes diagnostics a listener of a cut-off or garbled
 * message can be traced with: undecodable and stale chunks, a stream that ends
 * mid-frame or drops, and the controller's phase changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearDebugLog, getDebugLog } from "@/lib/debug-log"
import { resetVoiceLog } from "@/lib/voice-log"
import { WavChunkPlayer } from "../audio-player"
import { TtsController } from "../tts-controller"
import { createTtsStart, type StreamPlayer, type TtsEngineDeps } from "../tts-engine"

class FakeSource {
  onended: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn()
  connect = vi.fn()
  disconnect = vi.fn()
  buffer: unknown = null
}

let decode: (data: ArrayBuffer) => Promise<AudioBuffer>

class FakeContext {
  state = "running"
  currentTime = 0
  sampleRate = 24000
  destination = {}
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  createGain() { return { gain: { value: 1 }, connect: vi.fn() } }
  createBufferSource() { return new FakeSource() }
  decodeAudioData(data: ArrayBuffer) { return decode(data) }
}

beforeEach(() => {
  clearDebugLog()
  resetVoiceLog()
  for (const level of ["info", "warn", "debug"] as const) vi.spyOn(console, level).mockImplementation(() => undefined)
  decode = async () => ({ duration: 0.1, sampleRate: 24000, numberOfChannels: 1 }) as unknown as AudioBuffer
  ;(window as unknown as { AudioContext: unknown }).AudioContext = function () { return new FakeContext() } as unknown as typeof AudioContext
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function settle(player: WavChunkPlayer) {
  for (let i = 0; i < 6; i++) {
    await (player as unknown as { chain: Promise<void> }).chain
    await Promise.resolve()
  }
}

describe("WavChunkPlayer logging", () => {
  it("warns with the WAV header facts when a chunk does not decode", async () => {
    decode = async () => { throw new DOMException("bad data", "EncodingError") }
    const player = new WavChunkPlayer()
    player.enqueueBuffer(new Uint8Array(64).buffer)
    await settle(player)
    expect(getDebugLog()).toContain("event=wav_decode_failed bytes=64")
    expect(getDebugLog()).toContain("err=EncodingError")
    expect(getDebugLog()).toContain("problem=not_riff")
    expect(getDebugLog()).toContain("outcome=drained")
    expect(getDebugLog()).toContain("decode_failed=1")
  })

  it("flags a chunk that was queued before a reset and still gets scheduled", async () => {
    // A suspended context holds the chain at its resume step, where the reset overtakes it.
    let release: () => void = () => undefined
    const player = new WavChunkPlayer()
    void player.resume()
    const ctx = (player as unknown as { ctx: FakeContext }).ctx
    ctx.state = "suspended"
    ctx.resume = vi.fn(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined) }))
    player.enqueueBuffer(new Uint8Array(16).buffer)
    const queued = (player as unknown as { chain: Promise<void> }).chain
    player.reset()
    for (let i = 0; i < 4; i++) await Promise.resolve()
    release()
    await queued
    expect(getDebugLog()).toContain("event=wav_run outcome=reset")
    expect(getDebugLog()).toMatch(/event=wav_stale_chunk bytes=16 enqueued_under=0 now_gen=1/)
  })
})

function frameOf(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, false)
  out.set(body, 4)
  return out
}

function engineDeps(stream: ReadableStream<Uint8Array>): { d: TtsEngineDeps; player: StreamPlayer } {
  const player = {
    enqueueBuffer: vi.fn(),
    onStart: vi.fn(),
    onIdle: vi.fn(),
    reset: vi.fn(),
    playing: false,
  } as unknown as StreamPlayer
  const d: TtsEngineDeps = {
    checkAvailable: async () => true,
    openStream: async () => stream,
    getPlayer: () => player,
    speak: () => () => undefined,
  }
  return { d, player }
}

async function pump() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
}

describe("tts-engine logging", () => {
  it("records leftover bytes when the stream ends in the middle of a frame, and never the text", async () => {
    const whole = frameOf(new Uint8Array(30))
    const cut = frameOf(new Uint8Array(50)).slice(0, 20)
    const bytes = new Uint8Array(whole.length + cut.length)
    bytes.set(whole)
    bytes.set(cut, whole.length)
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } })
    const { d } = engineDeps(stream)
    await createTtsStart(d)("a private sentence", { onPlaying: vi.fn(), onEnd: vi.fn(), onError: vi.fn() })
    await pump()
    const text = getDebugLog()
    expect(text).toContain("event=tts_request req=")
    expect(text).toContain("raw_chars=18")
    expect(text).toMatch(/event=tts_stream_end .*frames=1 .*bytes=54 leftover_bytes=20/)
    expect(text).toContain("event=tts_frame_bad")
    expect(text).not.toContain("private")
  })

  it("warns when the stream errors after some audio", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(frameOf(new Uint8Array(30))) },
      pull(c) { c.error(new TypeError("network error at https://host.example/x?token=1")) },
    })
    const { d } = engineDeps(stream)
    await createTtsStart(d)("hello", { onPlaying: vi.fn(), onEnd: vi.fn(), onError: vi.fn() })
    await pump()
    const text = getDebugLog()
    expect(text).toContain("event=tts_stream_error")
    expect(text).toContain("aborted=0")
    expect(text).toContain("err=TypeError")
    expect(text).not.toContain("token=1")
    expect(text).toContain("ended_by=error")
  })

  it("logs the fallback to speech synthesis when the engine is unavailable", async () => {
    const { d } = engineDeps(new ReadableStream())
    d.checkAvailable = async () => false
    await createTtsStart(d)("hello", { onPlaying: vi.fn(), onEnd: vi.fn(), onError: vi.fn() })
    expect(getDebugLog()).toContain("event=tts_fallback_speech_synthesis req=")
    expect(getDebugLog()).toContain("reason=kokoro_unavailable")
  })
})

describe("TtsController logging", () => {
  it("logs the toggle, the phase changes and how it ended", async () => {
    let cbs: { onPlaying: () => void; onEnd: () => void } | undefined
    const controller = new TtsController(async (_text, c) => { cbs = c; return () => undefined })
    controller.toggle("m1", "some text")
    await Promise.resolve()
    cbs?.onPlaying()
    cbs?.onEnd()
    const text = getDebugLog()
    expect(text).toContain("event=tts_toggle message=m1 action=start chars=9")
    expect(text).toContain("event=tts_phase message=m1 from=idle to=loading")
    expect(text).toContain("event=tts_phase message=m1 from=loading to=playing")
    expect(text).toContain("event=tts_ended message=m1 stale=0")
    expect(text).toContain("event=tts_phase message=m1 from=playing to=idle")
  })
})
