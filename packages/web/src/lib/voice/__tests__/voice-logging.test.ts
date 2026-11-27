import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearDebugLog, getDebugLog } from "@/lib/debug-log"
import { GATEWAY_SOCKET_CLOSED, GATEWAY_SOCKET_OPEN, type GatewaySocketConnection } from "@/lib/gateway-transport"
import { resetVoiceLog, setVoiceDebug } from "@/lib/voice-log"
import { VoicePlayer } from "../player"
import { VoiceSocket } from "../socket"
import { FakeAudioContext, pcm } from "./fakes"

class FakeConnection implements GatewaySocketConnection {
  readyState = 0
  binaryType: BinaryType = "blob"
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  addEventListener() {}
  send() {}
  close(code = 1000, reason = "") { this.drop(code, reason) }
  open() { this.readyState = GATEWAY_SOCKET_OPEN; this.onopen?.(new Event("open")) }
  receive(data: unknown) { this.onmessage?.(new MessageEvent("message", { data })) }
  drop(code: number, reason = "") { this.readyState = GATEWAY_SOCKET_CLOSED; this.onclose?.({ code, reason } as CloseEvent) }
}

function audioFrame(segmentId: number, seq: number, bytes: number): ArrayBuffer {
  const buffer = new ArrayBuffer(8 + bytes)
  const view = new DataView(buffer)
  view.setUint8(0, 1)
  view.setUint16(2, seq, true)
  view.setUint32(4, segmentId, true)
  return buffer
}

function lines(): string[] {
  return getDebugLog().split("\n").filter((l) => l.includes("[voice]"))
}

beforeEach(() => {
  clearDebugLog()
  resetVoiceLog()
  localStorage.clear()
  for (const level of ["info", "warn", "debug"] as const) vi.spyOn(console, level).mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("voice socket logging", () => {
  function open() {
    const connection = new FakeConnection()
    VoiceSocket.open("s1", { onFrame() {}, onAudio() {}, onClose() {} }, { mode: "hands-free", open: () => connection })
    connection.open()
    return connection
  }

  it("logs the lifecycle, frames and a close summary without any reply text", () => {
    const connection = open()
    connection.receive(JSON.stringify({ type: "segment_start", segmentId: 3, messageId: "m1", text: "the secret sentence" }))
    connection.receive(audioFrame(3, 10, 480))
    connection.receive(audioFrame(3, 11, 480))
    connection.drop(1006, "gone")
    const text = getDebugLog()
    expect(text).toContain("event=socket_connecting session=s1")
    expect(text).toContain("event=socket_open session=s1")
    expect(text).toContain("event=frame_out type=hello protocol=1 mode=hands-free client=web")
    expect(text).toContain("event=frame_in type=segment_start segment=3 message=m1 text_chars=19")
    expect(text).toContain("event=socket_closed code=1006 reason=gone session=s1")
    expect(text).toContain("audio_in_frames=2 audio_in_bytes=976")
    expect(text).not.toContain("secret")
  })

  it("warns on a sequence gap, a reorder, an odd payload and a rejected frame, and counts them at close", () => {
    const connection = open()
    connection.receive(audioFrame(1, 100, 480))
    connection.receive(audioFrame(1, 103, 480))
    connection.receive(audioFrame(1, 102, 481))
    connection.receive(new ArrayBuffer(8))
    connection.receive("not json")
    connection.drop(1000, "bye")
    const text = getDebugLog()
    expect(text).toContain("event=audio_seq_gap seq=103 segment=1 missing=2")
    expect(text).toContain("event=audio_seq_reorder seq=102 segment=1 behind=1")
    expect(text).toContain("event=audio_odd_length seq=102 segment=1 bytes=489")
    expect(text).toContain("event=audio_frame_rejected bytes=8 reason=no_payload")
    expect(text).toContain("event=frame_ignored kind=text chars=8")
    expect(text).toContain("audio_in_rejected=1 audio_in_odd=1 audio_seq_gaps=1 audio_seq_missing=2 audio_seq_reordered=1")
  })

  it("logs one line per audio frame only when debug is on", () => {
    const connection = open()
    connection.receive(audioFrame(1, 1, 480))
    expect(lines().some((l) => l.includes("event=audio_in "))).toBe(false)
    setVoiceDebug(true)
    connection.receive(audioFrame(1, 2, 480))
    expect(lines().filter((l) => l.includes("event=audio_in ")).length).toBe(1)
  })

  it("warns when a client frame is dropped because the socket is closed", () => {
    const connection = new FakeConnection()
    const socket = VoiceSocket.open("s1", { onFrame() {}, onAudio() {}, onClose() {} }, { mode: "hands-free", open: () => connection })
    expect(socket.send({ type: "played", segmentId: 4 })).toBe(false)
    expect(getDebugLog()).toContain("event=frame_out_dropped type=played closed=0 ready_state=0")
  })
})

describe("voice player logging", () => {
  it("warns about an underrun inside a segment and summarises the segment", () => {
    const ctx = new FakeAudioContext()
    const player = new VoicePlayer(ctx, { onPlayed() {} })
    player.beginSegment(1)
    player.enqueue(1, pcm(12_000))
    ctx.currentTime = 2
    player.enqueue(1, pcm(12_000))
    player.endSegment(1)
    for (const source of ctx.sources) source.finish()
    const text = getDebugLog()
    expect(text).toContain("event=playback_underrun segment=1 chunk=2")
    expect(text).toMatch(/event=player_segment_done segment=1 outcome=played chunks=2 audio_ms=1000 .*underruns=1/)
  })

  it("logs a flush and the segments it cut, and drops after it quietly", () => {
    const ctx = new FakeAudioContext()
    const player = new VoicePlayer(ctx, { onPlayed() {} })
    player.beginSegment(2)
    player.enqueue(2, pcm(12_000))
    const cut = player.flush()
    expect(cut?.segmentId).toBeNull()
    expect(getDebugLog()).toContain("event=player_flush")
    expect(getDebugLog()).toContain("event=player_segment_done segment=2 outcome=cut")
    clearDebugLog()
    player.enqueue(2, pcm(100))
    expect(getDebugLog()).not.toContain("player_chunk_dropped")
  })

  it("warns when audio arrives for a segment that was never opened", () => {
    const player = new VoicePlayer(new FakeAudioContext(), {})
    player.enqueue(9, pcm(100))
    expect(getDebugLog()).toContain("event=player_chunk_dropped segment=9 reason=no_segment samples=100 after_flush=0")
  })
})
