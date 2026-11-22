import { afterEach, describe, expect, it, vi } from "vitest"
import type { VoiceServerFrame } from "@hundredfold/gateway-events"
import { GATEWAY_SOCKET_CLOSED, GATEWAY_SOCKET_OPEN, installGatewayTransport, type GatewaySocketConnection, type GatewayTransport } from "@/lib/gateway-transport"
import { parseAudioFrame, parseServerFrame, VoiceSocket } from "../socket"

class FakeConnection implements GatewaySocketConnection {
  readyState = 0
  binaryType: BinaryType = "blob"
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = []
  addEventListener() {}
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) { this.sent.push(data) }
  close(code = 1000, reason = "") { this.drop(code, reason) }
  open() { this.readyState = GATEWAY_SOCKET_OPEN; this.onopen?.(new Event("open")) }
  receive(data: unknown) { this.onmessage?.(new MessageEvent("message", { data })) }
  drop(code: number, reason = "") { this.readyState = GATEWAY_SOCKET_CLOSED; this.onclose?.({ code, reason } as CloseEvent) }
}

function setup() {
  const connection = new FakeConnection()
  const handlers = { onFrame: vi.fn(), onAudio: vi.fn(), onClose: vi.fn() }
  const socket = VoiceSocket.open("s/1", handlers, { mode: "hands-free", open: () => connection })
  return { connection, handlers, socket }
}

function audioFrame(segmentId: number, seq: number, samples: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(8 + samples.length * 2)
  const view = new DataView(buffer)
  view.setUint8(0, 1)
  view.setUint16(2, seq, true)
  view.setUint32(4, segmentId, true)
  samples.forEach((s, i) => view.setInt16(8 + i * 2, s, true))
  return buffer
}

describe("VoiceSocket", () => {
  it("opens /ws/voice/:id through the active gateway transport", () => {
    const opened: string[] = []
    const connection = new FakeConnection()
    const transport = { openSocket: (path: string) => { opened.push(path); return connection } } as unknown as GatewayTransport
    const restore = installGatewayTransport(transport)
    try {
      VoiceSocket.open("a b", { onFrame() {}, onAudio() {}, onClose() {} }, { mode: "push-to-talk" })
    } finally {
      restore()
    }
    expect(opened).toEqual(["/ws/voice/a%20b"])
    expect(connection.binaryType).toBe("arraybuffer")
  })

  it("sends hello first, with the protocol, mode and a web client", () => {
    const { connection } = setup()
    connection.open()
    expect(JSON.parse(connection.sent[0] as string)).toEqual({ type: "hello", protocol: 1, mode: "hands-free", client: "web" })
  })

  it("delivers server frames and ignores unknown or malformed ones", () => {
    const { connection, handlers } = setup()
    connection.open()
    connection.receive(JSON.stringify({ type: "vad", speaking: true }))
    connection.receive(JSON.stringify({ type: "from-the-future" }))
    connection.receive("not json")
    connection.receive("42")
    expect(handlers.onFrame.mock.calls.map(([f]) => (f as VoiceServerFrame).type)).toEqual(["vad"])
  })

  it("decodes downstream audio: header fields and little-endian PCM16", () => {
    const { connection, handlers } = setup()
    connection.open()
    connection.receive(audioFrame(0x01020304, 513, [1, -2, 32767]))
    const chunk = handlers.onAudio.mock.calls[0][0]
    expect(chunk.segmentId).toBe(0x01020304)
    expect(chunk.seq).toBe(513)
    expect(Array.from(chunk.pcm)).toEqual([1, -2, 32767])
  })

  it("drops audio frames with a wrong kind or no payload", () => {
    const wrong = audioFrame(1, 1, [1])
    new DataView(wrong).setUint8(0, 9)
    expect(parseAudioFrame(wrong)).toBeNull()
    expect(parseAudioFrame(new ArrayBuffer(8))).toBeNull()
    expect(parseServerFrame('{"type":"ready"}')?.type).toBe("ready")
  })

  it("sends audio as raw PCM bytes and refuses oversized frames", () => {
    const { connection, socket } = setup()
    connection.open()
    expect(socket.sendAudio(new Int16Array([1, 2, 3]))).toBe(true)
    const sent = connection.sent.at(-1) as ArrayBuffer
    expect(Array.from(new Int16Array(sent))).toEqual([1, 2, 3])
    expect(socket.sendAudio(new Int16Array(4096))).toBe(false)
  })

  it("sends nothing before it is open or after it closed", () => {
    const { connection, socket } = setup()
    expect(socket.send({ type: "bye" })).toBe(false)
    connection.open()
    connection.drop(1006)
    expect(socket.send({ type: "bye" })).toBe(false)
    expect(socket.sendAudio(new Int16Array(10))).toBe(false)
  })

  it("reports a close once, with its code and reason, and never reconnects by itself", () => {
    vi.useFakeTimers()
    try {
      let opens = 0
      const connection = new FakeConnection()
      const handlers = { onFrame: vi.fn(), onAudio: vi.fn(), onClose: vi.fn() }
      VoiceSocket.open("s", handlers, { mode: "hands-free", open: () => { opens++; return connection } })
      connection.open()
      connection.drop(4409, "in_use")
      connection.drop(4409, "in_use")
      vi.advanceTimersByTime(10 * 60_000)
      expect(handlers.onClose).toHaveBeenCalledTimes(1)
      expect(handlers.onClose).toHaveBeenCalledWith({ code: 4409, reason: "in_use" })
      expect(opens).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("closes on request without waiting for the peer", () => {
    const { connection, handlers, socket } = setup()
    connection.open()
    socket.close(1000, "bye")
    expect(handlers.onClose).toHaveBeenCalledWith({ code: 1000, reason: "bye" })
    expect(socket.isOpen).toBe(false)
  })

  it("accepts keepalive frames without passing them on", () => {
    expect(parseServerFrame('{"type":"keepalive"}')?.type).toBe("keepalive")
    const { connection, handlers } = setup()
    connection.open()
    connection.receive(JSON.stringify({ type: "keepalive" }))
    expect(handlers.onFrame).not.toHaveBeenCalled()
  })
})

const READY_WITH = (keepaliveMs: unknown) => JSON.stringify({ type: "ready", protocol: 1, sessionId: "s", ...(keepaliveMs === null ? {} : { keepaliveMs }) })

/** A connection that dies silently: it stays "open", never closes by itself and ignores close(). */
class HalfOpenConnection extends FakeConnection {
  closeCalls: Array<[number | undefined, string | undefined]> = []
  override close(code?: number, reason?: string) { this.closeCalls.push([code, reason]) }
}

function watched(keepaliveMs: number | null | string = 10_000) {
  vi.useFakeTimers()
  const connection = new HalfOpenConnection()
  const handlers = { onFrame: vi.fn(), onAudio: vi.fn(), onClose: vi.fn() }
  const socket = VoiceSocket.open("s", handlers, { mode: "hands-free", open: () => connection })
  connection.open()
  connection.receive(READY_WITH(keepaliveMs))
  return { connection, handlers, socket }
}

describe("VoiceSocket keepalive watchdog", () => {
  afterEach(() => { vi.useRealTimers() })

  it("declares the connection lost after 2.5 intervals of silence, with no close event from the peer", () => {
    const { connection, handlers, socket } = watched()
    vi.advanceTimersByTime(24_000)
    expect(handlers.onClose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(6_000)
    expect(handlers.onClose).toHaveBeenCalledTimes(1)
    expect(handlers.onClose).toHaveBeenCalledWith({ code: 1006, reason: "keepalive timeout" })
    expect(connection.closeCalls).toHaveLength(1)
    expect(socket.isOpen).toBe(false)
    expect(socket.send({ type: "bye" })).toBe(false)
    vi.advanceTimersByTime(10 * 60_000)
    expect(handlers.onClose).toHaveBeenCalledTimes(1)
  })

  it("is kept alive by frames of any kind: keepalive, text and audio", () => {
    const { connection, handlers } = watched()
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(10_000)
      connection.receive(i % 3 === 0 ? JSON.stringify({ type: "keepalive" }) : i % 3 === 1 ? JSON.stringify({ type: "vad", speaking: false }) : audioFrame(1, i, [1, 2]))
    }
    expect(handlers.onClose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30_000)
    expect(handlers.onClose).toHaveBeenCalledTimes(1)
  })

  it("arms no watchdog when ready carries no keepaliveMs (an older gateway)", () => {
    const { handlers } = watched(null)
    vi.advanceTimersByTime(60 * 60_000)
    expect(handlers.onClose).not.toHaveBeenCalled()
  })

  it("ignores an advertised interval too small to trust, or not a number", () => {
    for (const bad of [0, -5, 10, "10000"]) {
      const { handlers } = watched(bad)
      vi.advanceTimersByTime(60_000)
      expect(handlers.onClose).not.toHaveBeenCalled()
      vi.useRealTimers()
    }
  })

  it("does not judge on a stale clock: a tick that fires far too late restarts the window", () => {
    const { handlers } = watched()
    vi.advanceTimersByTime(10_000)
    // The page is suspended for a minute: the next tick fires once, long after it was due.
    vi.setSystemTime(Date.now() + 60_000)
    vi.advanceTimersByTime(5_000)
    expect(handlers.onClose).not.toHaveBeenCalled()
    // Still silent after a whole fresh window: now it is lost.
    vi.advanceTimersByTime(30_000)
    expect(handlers.onClose).toHaveBeenCalledTimes(1)
  })

  it("counts frames queued behind a late tick before declaring loss", () => {
    const { connection, handlers } = watched()
    vi.advanceTimersByTime(10_000)
    vi.setSystemTime(Date.now() + 60_000)
    connection.receive(JSON.stringify({ type: "keepalive" }))
    vi.advanceTimersByTime(20_000)
    expect(handlers.onClose).not.toHaveBeenCalled()
  })

  it("stops watching once closed on request or by the peer", () => {
    const first = watched()
    first.socket.close(1000, "bye")
    vi.advanceTimersByTime(5 * 60_000)
    expect(first.handlers.onClose).toHaveBeenCalledTimes(1)
    expect(first.handlers.onClose).toHaveBeenCalledWith({ code: 1000, reason: "bye" })
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    const second = watched()
    second.connection.drop(1006)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5 * 60_000)
    expect(second.handlers.onClose).toHaveBeenCalledTimes(1)
  })
})
