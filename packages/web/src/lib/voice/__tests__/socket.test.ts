import { describe, expect, it, vi } from "vitest"
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
})
