import {
  VOICE_AUDIO_HEADER_BYTES,
  VOICE_AUDIO_KIND,
  VOICE_MAX_INPUT_FRAME_BYTES,
  VOICE_PROTOCOL_VERSION,
  type VoiceClientFrame,
  type VoiceMode,
  type VoiceServerFrame,
} from "@hundredfold/gateway-events"
import { GATEWAY_SOCKET_OPEN, gatewayTransport, type GatewaySocketConnection } from "@/lib/gateway-transport"

export interface VoiceAudioChunk {
  seq: number
  segmentId: number
  pcm: Int16Array
}

export interface VoiceSocketClose {
  code: number
  reason: string
}

export interface VoiceSocketHandlers {
  onFrame(frame: VoiceServerFrame): void
  onAudio(chunk: VoiceAudioChunk): void
  onClose(close: VoiceSocketClose): void
}

export interface VoiceSocketOptions {
  mode: VoiceMode
  /** Opens the underlying socket; defaults to the active gateway transport, so the native shell works. */
  open?: (path: string) => GatewaySocketConnection
}

/** The `type` of every frame the gateway may send; anything else is ignored rather than trusted. */
const SERVER_FRAME_TYPES: ReadonlySet<string> = new Set([
  "ready", "vad", "transcript", "stop_playback", "turn", "segment_start", "segment_end",
  "holding", "background", "missed", "metrics", "error", "detached",
])

export function parseServerFrame(text: string): VoiceServerFrame | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!value || typeof value !== "object") return null
  const type = (value as { type?: unknown }).type
  return typeof type === "string" && SERVER_FRAME_TYPES.has(type) ? (value as VoiceServerFrame) : null
}

/** Reads a downstream audio frame: `[u8 kind][u8 0][u16 seq][u32 segmentId][PCM16LE]`. */
export function parseAudioFrame(data: ArrayBuffer): VoiceAudioChunk | null {
  if (data.byteLength <= VOICE_AUDIO_HEADER_BYTES) return null
  const view = new DataView(data)
  if (view.getUint8(0) !== VOICE_AUDIO_KIND) return null
  const samples = Math.floor((data.byteLength - VOICE_AUDIO_HEADER_BYTES) / 2)
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) pcm[i] = view.getInt16(VOICE_AUDIO_HEADER_BYTES + i * 2, true)
  return { seq: view.getUint16(2, true), segmentId: view.getUint32(4, true), pcm }
}

/**
 * One connection to `/ws/voice/:sessionId`, opened through the gateway
 * transport. It is single-use on purpose: when it closes it stays closed, and
 * a new one is only made by the caller, from a user gesture (a locked phone
 * must not quietly reopen its microphone).
 */
export class VoiceSocket {
  private closed = false
  private constructor(
    private readonly socket: GatewaySocketConnection,
    private readonly handlers: VoiceSocketHandlers,
  ) {}

  static open(sessionId: string, handlers: VoiceSocketHandlers, options: VoiceSocketOptions): VoiceSocket {
    const path = `/ws/voice/${encodeURIComponent(sessionId)}`
    const raw = options.open ? options.open(path) : gatewayTransport().openSocket(path)
    raw.binaryType = "arraybuffer"
    const voice = new VoiceSocket(raw, handlers)
    raw.onopen = () => voice.send({ type: "hello", protocol: VOICE_PROTOCOL_VERSION, mode: options.mode, client: "web" })
    raw.onmessage = (event) => voice.receive(event.data)
    raw.onclose = (event) => voice.finish(event.code, event.reason)
    // A failed connection is followed by `close`; the close path reports it.
    raw.onerror = () => undefined
    return voice
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === GATEWAY_SOCKET_OPEN
  }

  send(frame: VoiceClientFrame): boolean {
    if (!this.isOpen) return false
    this.socket.send(JSON.stringify(frame))
    return true
  }

  /** One 20 ms PCM16 frame. Oversized frames are refused here rather than closing the socket. */
  sendAudio(pcm: Int16Array): boolean {
    if (!this.isOpen || pcm.byteLength > VOICE_MAX_INPUT_FRAME_BYTES) return false
    this.socket.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
    return true
  }

  close(code = 1000, reason = "bye"): void {
    if (this.closed) return
    try { this.socket.close(code, reason) } catch { /* already closing */ }
    this.finish(code, reason)
  }

  private receive(data: unknown): void {
    if (this.closed) return
    if (typeof data === "string") {
      const frame = parseServerFrame(data)
      if (frame) this.handlers.onFrame(frame)
    } else if (data instanceof ArrayBuffer) {
      const chunk = parseAudioFrame(data)
      if (chunk) this.handlers.onAudio(chunk)
    }
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.handlers.onClose({ code, reason })
  }
}
