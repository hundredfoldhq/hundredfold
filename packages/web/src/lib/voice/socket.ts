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
import { voiceLog, voiceNow } from "@/lib/voice-log"
import { SeqTracker, describeServerFrame, isChattyFrame } from "./trace"

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
/** How long a goodbye for a paused conversation may stay open if the gateway does not close it first. */
const END_SUSPENDED_WAIT_MS = 5_000
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
  private keepaliveMs: number | null = null
  // Diagnostics only: none of this feeds back into behaviour.
  private readonly createdAt = voiceNow()
  private openedAt: number | null = null
  private lastInboundAt = voiceNow()
  private lastKeepaliveAt: number | null = null
  private readonly seq = new SeqTracker()
  private audioIn = { frames: 0, bytes: 0, rejected: 0, odd: 0, gaps: 0, missing: 0, reordered: 0, duplicates: 0 }
  private audioOut = { frames: 0, bytes: 0, dropped: 0 }
  private jsonIn = 0
  private jsonOut = 0
  private constructor(
    private readonly socket: GatewaySocketConnection,
    private readonly handlers: VoiceSocketHandlers,
    private readonly sessionId: string = "",
  ) {}

  static open(sessionId: string, handlers: VoiceSocketHandlers, options: VoiceSocketOptions): VoiceSocket {
    const path = `/ws/voice/${encodeURIComponent(sessionId)}`
    const raw = options.open ? options.open(path) : gatewayTransport().openSocket(path)
    raw.binaryType = "arraybuffer"
    const voice = new VoiceSocket(raw, handlers, sessionId)
    voiceLog.info("socket_connecting", { session: sessionId, mode: options.mode })
    raw.onopen = () => {
      voice.openedAt = voiceNow()
      voiceLog.info("socket_open", { session: sessionId, connect_ms: voice.openedAt - voice.createdAt })
      voice.send({ type: "hello", protocol: VOICE_PROTOCOL_VERSION, mode: options.mode, client: "web" })
    }
    raw.onmessage = (event) => voice.receive(event.data)
    raw.onclose = (event) => voice.finish(event.code, event.reason)
    // A failed connection is followed by `close`; the close path reports it.
    raw.onerror = () => { voiceLog.warn("socket_error", { session: sessionId, open: voice.openedAt !== null }) }
    return voice
  }

  /**
   * Ends the conversation this client left suspended when it paused, as a `bye` would, without attaching: the gateway
   * closes the connection at once, and leaves the conversation alone if another tab or device is using it. Nothing
   * is sent and nothing is heard back.
   */
  static endSuspended(sessionId: string, options: Pick<VoiceSocketOptions, "open"> = {}): void {
    const path = `/ws/voice/${encodeURIComponent(sessionId)}?end=suspended`
    let raw: GatewaySocketConnection
    try {
      raw = options.open ? options.open(path) : gatewayTransport().openSocket(path)
    } catch {
      return // the gateway lets the conversation go when its suspend window runs out
    }
    const timer = setTimeout(() => { try { raw.close(1000, "bye") } catch { /* already closed */ } }, END_SUSPENDED_WAIT_MS)
    raw.onclose = () => clearTimeout(timer)
    raw.onerror = () => undefined
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === GATEWAY_SOCKET_OPEN
  }

  send(frame: VoiceClientFrame): boolean {
    if (!this.isOpen) {
      voiceLog.warn("frame_out_dropped", { type: frame.type, closed: this.closed, ready_state: this.socket.readyState })
      return false
    }
    this.socket.send(JSON.stringify(frame))
    this.jsonOut += 1
    voiceLog.info("frame_out", () => ({ type: frame.type, ...describeClientFrame(frame) }))
    return true
  }

  /** One 20 ms PCM16 frame. Oversized frames are refused here rather than closing the socket. */
  sendAudio(pcm: Int16Array): boolean {
    if (!this.isOpen || pcm.byteLength > VOICE_MAX_INPUT_FRAME_BYTES) {
      this.audioOut.dropped += 1
      // One mic frame every 20 ms: say so the first time and then every 100th.
      if (this.audioOut.dropped === 1 || this.audioOut.dropped % 100 === 0) {
        voiceLog.warn("audio_out_dropped", { bytes: pcm.byteLength, open: this.isOpen, dropped: this.audioOut.dropped })
      }
      return false
    }
    this.socket.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
    this.audioOut.frames += 1
    this.audioOut.bytes += pcm.byteLength
    return true
  }

  close(code = 1000, reason = "bye"): void {
    if (this.closed) return
    voiceLog.info("socket_close_requested", { code, reason })
    try { this.socket.close(code, reason) } catch { /* already closing */ }
    this.finish(code, reason)
  }

  private receive(data: unknown): void {
    if (this.closed) return
    this.lastInbound = Date.now()
    this.noteInbound()
    if (typeof data === "string") {
      const frame = parseServerFrame(data)
      if (!frame) this.logIgnoredText(data)
      else this.logFrame(frame)
      if (frame?.type === "ready") this.armWatchdog(frame.keepaliveMs)
      // A keepalive only proves the connection is alive, which recording the arrival above has done.
      if (frame && frame.type !== "keepalive") this.handlers.onFrame(frame)
    } else if (data instanceof ArrayBuffer) {
      const chunk = parseAudioFrame(data)
      if (chunk) {
        this.logAudio(chunk, data.byteLength)
        this.handlers.onAudio(chunk)
      } else {
        this.logRejectedAudio(data)
      }
    } else {
      voiceLog.warn("frame_ignored", { kind: Object.prototype.toString.call(data) })
    }
  }

  // ── diagnostics ───────────────────────────────────────────────────────────

  /** Any message after a long silence; the watchdog's own timeout is logged separately. */
  private noteInbound(): void {
    const now = voiceNow()
    const gap = now - this.lastInboundAt
    this.lastInboundAt = now
    const limit = this.keepaliveMs === null ? 15_000 : this.keepaliveMs * 1.5
    if (gap > limit) voiceLog.warn("inbound_gap", { gap_ms: gap, limit_ms: limit })
  }

  private logFrame(frame: VoiceServerFrame): void {
    this.jsonIn += 1
    if (frame.type === "keepalive") {
      const now = voiceNow()
      const gap = this.lastKeepaliveAt === null ? null : now - this.lastKeepaliveAt
      this.lastKeepaliveAt = now
      voiceLog.debug("keepalive_in", { gap_ms: gap })
      return
    }
    const fields = () => ({ type: frame.type, ...describeServerFrame(frame) })
    if (isChattyFrame(frame)) voiceLog.debug("frame_in", fields)
    else voiceLog.info("frame_in", fields)
  }

  /** A text frame the client does not act on: bad JSON, or a type it does not know. */
  private logIgnoredText(text: string): void {
    let type: unknown
    try { type = (JSON.parse(text) as { type?: unknown } | null)?.type } catch { type = undefined }
    voiceLog.warn("frame_ignored", { kind: "text", chars: text.length, type: typeof type === "string" ? type : undefined })
  }

  private logAudio(chunk: VoiceAudioChunk, byteLength: number): void {
    const odd = (byteLength - VOICE_AUDIO_HEADER_BYTES) % 2 !== 0
    const step = this.seq.next(chunk.seq)
    const a = this.audioIn
    a.frames += 1
    a.bytes += byteLength
    if (odd) {
      a.odd += 1
      voiceLog.warn("audio_odd_length", { seq: chunk.seq, segment: chunk.segmentId, bytes: byteLength })
    }
    if (step.kind === "gap") {
      a.gaps += 1
      a.missing += step.missing
      voiceLog.warn("audio_seq_gap", { seq: chunk.seq, segment: chunk.segmentId, missing: step.missing })
    } else if (step.kind === "reorder") {
      a.reordered += 1
      voiceLog.warn("audio_seq_reorder", { seq: chunk.seq, segment: chunk.segmentId, behind: step.behind })
    } else if (step.kind === "duplicate") {
      a.duplicates += 1
      voiceLog.warn("audio_seq_duplicate", { seq: chunk.seq, segment: chunk.segmentId })
    }
    voiceLog.debug("audio_in", () => ({ seq: chunk.seq, segment: chunk.segmentId, bytes: byteLength, samples: chunk.pcm.length, odd }))
  }

  /** `parseAudioFrame` returned nothing: an empty frame, or one that is not audio. */
  private logRejectedAudio(data: ArrayBuffer): void {
    this.audioIn.rejected += 1
    const reason = data.byteLength <= VOICE_AUDIO_HEADER_BYTES ? "no_payload" : "bad_kind"
    voiceLog.warn("audio_frame_rejected", {
      bytes: data.byteLength,
      reason,
      kind: data.byteLength > 0 ? new DataView(data).getUint8(0) : undefined,
    })
  }

  private logClose(code: number, reason: string): void {
    const now = voiceNow()
    voiceLog.info("socket_closed", {
      code,
      reason,
      session: this.sessionId,
      open_ms: this.openedAt === null ? null : now - this.openedAt,
      ever_open: this.openedAt !== null,
      json_in: this.jsonIn,
      json_out: this.jsonOut,
      audio_in_frames: this.audioIn.frames,
      audio_in_bytes: this.audioIn.bytes,
      audio_in_rejected: this.audioIn.rejected,
      audio_in_odd: this.audioIn.odd,
      audio_seq_gaps: this.audioIn.gaps,
      audio_seq_missing: this.audioIn.missing,
      audio_seq_reordered: this.audioIn.reordered,
      audio_seq_duplicates: this.audioIn.duplicates,
      audio_out_frames: this.audioOut.frames,
      audio_out_bytes: this.audioOut.bytes,
      audio_out_dropped: this.audioOut.dropped,
      silent_ms: now - this.lastInboundAt,
    })
  }

  /**
   * Browsers do not expose ws pings, so a connection that dies without a close
   * event (a network switch, a sleeping proxy) looks open for ever. Once the
   * gateway says it sends keepalives, silence for 2.5 intervals is a lost
   * connection. A gateway that does not advertise them gets no watchdog.
   */
  private armWatchdog(keepaliveMs: unknown): void {
    this.stopWatchdog()
    if (typeof keepaliveMs !== "number" || !Number.isFinite(keepaliveMs) || keepaliveMs < MIN_KEEPALIVE_MS) {
      voiceLog.info("watchdog_off", { keepalive_ms: typeof keepaliveMs === "number" ? keepaliveMs : null })
      return
    }
    this.keepaliveMs = keepaliveMs
    voiceLog.info("watchdog_armed", { keepalive_ms: keepaliveMs })
    const every = keepaliveMs / WATCHDOG_CHECKS_PER_INTERVAL
    const limit = keepaliveMs * KEEPALIVE_TIMEOUT_INTERVALS
    let lastTick = Date.now()
    this.watchdog = setInterval(() => {
      const now = Date.now()
      const late = now - lastTick - every
      lastTick = now
      // This tick itself came far too late: the page was suspended or its timers throttled, so frames that arrived
      // meanwhile may still be queued behind it. Start the window again rather than judge on a stale clock.
      if (late > keepaliveMs) {
        voiceLog.warn("watchdog_resync", { late_ms: late, keepalive_ms: keepaliveMs })
        this.lastInbound = now
        return
      }
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
    voiceLog.warn("watchdog_lost", { silent_ms: Date.now() - this.lastInbound, keepalive_ms: this.keepaliveMs })
    // Finish first: a real socket's own `close` event arrives later (or never) and must not change the reason.
    this.finish(KEEPALIVE_LOST_CODE, "keepalive timeout")
    try { this.socket.close(1000, "keepalive timeout") } catch { /* already gone */ }
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.stopWatchdog()
    this.logClose(code, reason)
    this.handlers.onClose({ code, reason })
  }
}

/** The loggable facts of a client frame (ids and numbers only). */
function describeClientFrame(frame: VoiceClientFrame): Record<string, string | number | null> {
  switch (frame.type) {
    case "hello": return { protocol: frame.protocol, mode: frame.mode, client: frame.client }
    case "barge_in": return { segment: frame.segmentId, played_ms: frame.playedMs }
    case "played": return { segment: frame.segmentId }
    case "resume": return { suspended_ms: frame.suspendedMs }
    default: return {}
  }
}
