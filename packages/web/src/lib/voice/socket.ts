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
  "holding", "background", "missed", "metrics", "error", "detached", "keepalive",
])

/** The connection is lost after this many keepalive intervals with no inbound message of any kind. */
const KEEPALIVE_TIMEOUT_INTERVALS = 2.5
/** The watchdog checks this many times per keepalive interval. */
const WATCHDOG_CHECKS_PER_INTERVAL = 2
/** Below this the advertised interval is not trusted: a tiny value would end voice on ordinary jitter. */
const MIN_KEEPALIVE_MS = 1000
/** A close code for a connection the client gave up on; the browser never reports this one itself. */
const KEEPALIVE_LOST_CODE = 1006

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
  private lastInbound = Date.now()
  private watchdog: ReturnType<typeof setInterval> | null = null
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
    this.lastInbound = Date.now()
    if (typeof data === "string") {
      const frame = parseServerFrame(data)
      if (frame?.type === "ready") this.armWatchdog(frame.keepaliveMs)
      // A keepalive only proves the connection is alive, which recording the arrival above has done.
      if (frame && frame.type !== "keepalive") this.handlers.onFrame(frame)
    } else if (data instanceof ArrayBuffer) {
      const chunk = parseAudioFrame(data)
      if (chunk) this.handlers.onAudio(chunk)
    }
  }

  /**
   * Browsers do not expose ws pings, so a connection that dies without a close
   * event (a network switch, a sleeping proxy) looks open for ever. Once the
   * gateway says it sends keepalives, silence for 2.5 intervals is a lost
   * connection. A gateway that does not advertise them gets no watchdog.
   */
  private armWatchdog(keepaliveMs: unknown): void {
    this.stopWatchdog()
    if (typeof keepaliveMs !== "number" || !Number.isFinite(keepaliveMs) || keepaliveMs < MIN_KEEPALIVE_MS) return
    const every = keepaliveMs / WATCHDOG_CHECKS_PER_INTERVAL
    const limit = keepaliveMs * KEEPALIVE_TIMEOUT_INTERVALS
    let lastTick = Date.now()
    this.watchdog = setInterval(() => {
      const now = Date.now()
      const late = now - lastTick - every
      lastTick = now
      // This tick itself came far too late: the page was suspended or its timers throttled, so frames that arrived
      // meanwhile may still be queued behind it. Start the window again rather than judge on a stale clock.
      if (late > keepaliveMs) { this.lastInbound = now; return }
      if (now - this.lastInbound >= limit) this.lose()
    }, every)
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog)
    this.watchdog = null
  }

  /** No message for too long: close the raw socket if it will still listen, and end through the ordinary close path. */
  private lose(): void {
    this.stopWatchdog()
    if (this.closed) return
    // Finish first: a real socket's own `close` event arrives later (or never) and must not change the reason.
    this.finish(KEEPALIVE_LOST_CODE, "keepalive timeout")
    try { this.socket.close(1000, "keepalive timeout") } catch { /* already gone */ }
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.stopWatchdog()
    this.handlers.onClose({ code, reason })
  }
}
