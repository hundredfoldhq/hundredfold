import type { VoiceClientFrame, VoiceMode, VoiceServerFrame } from "@hundredfold/gateway-events"
import { startCapture, requestMicrophone } from "./capture-worklet"
import { VoiceStore, dropHandoff, type VoiceController, type VoiceSessionStarter } from "./controller"
import { OnsetDetector } from "./onset"
import { rms } from "./pcm"
import { VoicePlayer, type PlayerAudioContext } from "./player"
import { VoiceSocket, type VoiceAudioChunk, type VoiceSocketClose, type VoiceSocketHandlers } from "./socket"
import {
  installMediaSession,
  SuspendWatcher,
  type MediaSessionLike,
  type SuspendContext,
  type SuspendDocument,
  type SuspendTrack,
} from "./suspend"
import type { VoiceUiState } from "./state"

export interface VoiceAudioContext extends PlayerAudioContext, SuspendContext {
  resume(): Promise<void>
  close(): Promise<void>
}

export interface VoiceSocketLike {
  readonly isOpen: boolean
  send(frame: VoiceClientFrame): boolean
  sendAudio(pcm: Int16Array): boolean
  close(code?: number, reason?: string): void
}

export interface VoicePlayerLike {
  beginSegment(segmentId: number): void
  enqueue(segmentId: number, pcm: Int16Array): void
  endSegment(segmentId: number): void
  isActive(): boolean
  flush(): { segmentId: number | null; playedMs: number } | null
  dispose(): void
}

export interface VoiceTrack extends SuspendTrack {
  readonly readyState: string
}

export interface VoiceCaptureHandle {
  readonly track: VoiceTrack | null
  stop(): void
}

/** Everything the session touches in the outside world, so tests can script it. */
export interface BrowserVoiceDeps {
  openSocket(sessionId: string, handlers: VoiceSocketHandlers, mode: VoiceMode): VoiceSocketLike
  createContext(): VoiceAudioContext
  requestMicrophone(): Promise<MediaStream>
  startCapture(ctx: VoiceAudioContext, stream: MediaStream, onFrame: (pcm: Int16Array) => void): Promise<VoiceCaptureHandle>
  createPlayer(ctx: VoiceAudioContext, onPlayed: (segmentId: number) => void): VoicePlayerLike
  doc: SuspendDocument
  mediaSession?: MediaSessionLike
  createMediaMetadata?: () => unknown
  now(): number
}

export interface BrowserVoiceOptions {
  /** The chat, or how to create one when the control is on a new chat. */
  sessionId: string | VoiceSessionStarter
  mode: VoiceMode
  /** `bargeIn.enabled` from the voice config. */
  bargeIn: boolean
}

/** How long to wait for an AudioContext to run again before asking for a tap. */
const CONTEXT_RESUME_WAIT_MS = 300

export function defaultBrowserDeps(): BrowserVoiceDeps {
  return {
    openSocket: (sessionId, handlers, mode) => VoiceSocket.open(sessionId, handlers, { mode }),
    createContext: () => new AudioContext({ latencyHint: "interactive" }) as unknown as VoiceAudioContext,
    requestMicrophone: () => requestMicrophone(),
    startCapture: (ctx, stream, onFrame) => startCapture(ctx as unknown as AudioContext, stream, onFrame),
    createPlayer: (ctx, onPlayed) => new VoicePlayer(ctx, { onPlayed }),
    doc: document,
    mediaSession: typeof navigator !== "undefined" && "mediaSession" in navigator ? (navigator.mediaSession as unknown as MediaSessionLike) : undefined,
    createMediaMetadata: () => new MediaMetadata({ title: "Voice mode is on", artist: "Hundredfold" }),
    now: () => Date.now(),
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

function microphoneMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone permission was denied."
  if (name === "NotFoundError") return "No microphone was found."
  return error instanceof Error && error.message ? `Microphone unavailable: ${error.message}` : "Microphone unavailable."
}

/**
 * Voice mode in a browser: microphone → worklet → socket up, socket → player
 * down, with the onset detector between them so speech over playback stops it
 * at once. One instance serves one tap-to-tap run on one chat.
 */
export class BrowserVoiceSession implements VoiceController {
  private readonly store = new VoiceStore()
  private ctx: VoiceAudioContext | null = null
  private socket: VoiceSocketLike | null = null
  private player: VoicePlayerLike | null = null
  private capture: VoiceCaptureHandle | null = null
  private watcher: SuspendWatcher | null = null
  private detector: OnsetDetector | null = null
  private removeMediaSession: (() => void) | null = null
  private closing = false
  /** Bumped on every start and every teardown; an await that resumes under a different value belongs to a run that is over. */
  private generation = 0
  private talking = false
  private pendingResumeMs: number | null = null
  private session: string | null

  constructor(
    private readonly options: BrowserVoiceOptions,
    private readonly deps: BrowserVoiceDeps = defaultBrowserDeps(),
  ) {
    this.session = typeof options.sessionId === "string" ? options.sessionId : null
  }

  boundSessionId = (): string | null => this.session

  getSnapshot = (): VoiceUiState => this.store.snapshot
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  start(): Promise<void> {
    if (this.store.snapshot.status !== "off") return Promise.resolve()
    this.store.dispatch({ type: "connecting", mode: this.options.mode })
    this.closing = false
    const generation = ++this.generation
    // The three calls iOS requires inside the tap, before any await.
    const ctx = this.deps.createContext()
    void ctx.resume().catch(() => undefined)
    const microphone = this.deps.requestMicrophone()
    this.ctx = ctx
    if (this.session !== null) {
      this.openSocket(this.session)
      return this.attachMicrophone(microphone, generation)
    }
    return this.createThenAttach(microphone, generation)
  }

  /** A new chat: the session is created once, now that the microphone request is in flight, and the socket opens on it. */
  private async createThenAttach(microphone: Promise<MediaStream>, generation: number): Promise<void> {
    const starter = this.options.sessionId as VoiceSessionStarter
    let id: string
    try {
      id = await starter.create()
    } catch (error) {
      this.releaseMicrophone(microphone)
      if (generation === this.generation) this.failStart(error instanceof Error && error.message ? error.message : "Couldn't start a chat for voice mode.")
      return
    }
    if (generation !== this.generation || !this.ctx) {
      this.releaseMicrophone(microphone)
      starter.discard(id)
      return
    }
    this.session = id
    this.openSocket(id)
    return this.attachMicrophone(microphone, generation)
  }

  stop(): void {
    if (this.store.snapshot.status === "off" && !this.ctx) return
    this.closing = true
    dropHandoff(this)
    this.socket?.send({ type: "bye" })
    this.socket?.close(1000, "bye")
    this.teardown()
    this.store.dispatch({ type: "stopped" })
  }

  dispose(): void {
    this.stop()
  }

  pttDown(): void {
    if (this.options.mode !== "push-to-talk" || this.store.snapshot.status !== "on" || this.talking) return
    this.talking = true
    this.socket?.send({ type: "ptt_down" })
  }

  pttUp(): void {
    if (!this.talking) return
    this.talking = false
    this.socket?.send({ type: "ptt_up" })
  }

  dismissNotice(): void {
    this.store.dispatch({ type: "dismiss-notice" })
  }

  clearBackground(): void {
    this.store.dispatch({ type: "background-cleared" })
  }

  resumeFromTap(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.session === null) return this.start()
    void ctx.resume().catch(() => undefined)
    const trackLive = this.capture?.track?.readyState === "live"
    const microphone = trackLive ? null : this.deps.requestMicrophone()
    this.watcher?.clear()
    if (this.socket?.isOpen) {
      this.store.dispatch({ type: "resumed" })
      this.sendResume()
    } else {
      // A new attachment: it is `ready` again before audio goes up, and the `resume` follows then.
      this.store.dispatch({ type: "connecting", mode: this.options.mode })
      this.openSocket(this.session as string)
    }
    return microphone ? this.replaceMicrophone(microphone, this.generation) : Promise.resolve()
  }

  // ── socket ────────────────────────────────────────────────────────────────

  private openSocket(sessionId: string): void {
    this.socket = this.deps.openSocket(sessionId, {
      onFrame: (frame) => this.onFrame(frame),
      onAudio: (chunk) => this.onAudio(chunk),
      onClose: (close) => this.onClose(close),
    }, this.options.mode)
  }

  private onFrame(frame: VoiceServerFrame): void {
    this.store.dispatch({ type: "frame", frame, now: this.deps.now() })
    this.applyToAudio(frame)
  }

  private applyToAudio(frame: VoiceServerFrame): void {
    switch (frame.type) {
      case "ready": this.onReady(frame); break
      case "segment_start": this.player?.beginSegment(frame.segmentId); break
      case "segment_end": this.player?.endSegment(frame.segmentId); break
      case "stop_playback": this.player?.flush(); break
      case "detached": this.onDetached(); break
      default: break
    }
  }

  /** The gateway ended this attachment: release the microphone and audio now, keeping its reason on screen. */
  private onDetached(): void {
    this.closing = true
    this.socket?.close(1000, "detached")
    this.teardown()
  }

  private onReady(frame: Extract<VoiceServerFrame, { type: "ready" }>): void {
    this.detector = this.options.bargeIn ? new OnsetDetector(frame.onset) : null
    this.removeMediaSession ??= installMediaSession(this.deps.mediaSession, () => this.stop(), this.deps.createMediaMetadata ?? (() => null))
    this.sendResume()
  }

  private sendResume(): void {
    if (this.pendingResumeMs === null || this.store.snapshot.status !== "on" || !this.socket?.isOpen) return
    this.socket.send({ type: "resume", suspendedMs: this.pendingResumeMs })
    this.pendingResumeMs = null
  }

  private onAudio(chunk: VoiceAudioChunk): void {
    this.player?.enqueue(chunk.segmentId, chunk.pcm)
  }

  private onClose(close: VoiceSocketClose): void {
    this.socket = null
    if (this.closing) return
    // Only an established socket can be suspended. One that never reached `ready` (a failed reconnect) failed on its own.
    const suspended = this.store.snapshot.status !== "connecting" && (this.watcher?.socketClosed() ?? false)
    this.store.dispatch({ type: "closed", code: close.code, reason: close.reason, requested: false })
    if (!suspended && this.store.snapshot.status === "off") this.teardown()
  }

  // ── microphone ────────────────────────────────────────────────────────────

  /** A microphone request nobody will use: the stream, once granted, is stopped. */
  private releaseMicrophone(microphone: Promise<MediaStream>): void {
    void microphone.then(stopTracks, () => undefined)
  }

  private async attachMicrophone(microphone: Promise<MediaStream>, generation: number): Promise<void> {
    try {
      const stream = await microphone
      await this.beginCapture(stream, generation)
    } catch (error) {
      // A run that was stopped (or replaced by a new start) has nobody left to tell.
      if (generation === this.generation) this.failStart(microphoneMessage(error))
    }
  }

  private async replaceMicrophone(microphone: Promise<MediaStream>, generation: number): Promise<void> {
    try {
      this.capture?.stop()
      const stream = await microphone
      await this.beginCapture(stream, generation)
    } catch (error) {
      if (generation === this.generation) this.failStart(microphoneMessage(error))
    }
  }

  /**
   * Every await that can outlive the run re-checks the generation: a stop or a
   * newer start while the prompt or the worklet was pending must leave no live track.
   */
  private async beginCapture(stream: MediaStream, generation: number): Promise<void> {
    const ctx = this.ctx
    if (generation !== this.generation || !ctx) { stopTracks(stream); return }
    this.player ??= this.deps.createPlayer(ctx, (segmentId) => this.socket?.send({ type: "played", segmentId }))
    let handle: VoiceCaptureHandle
    try {
      handle = await this.deps.startCapture(ctx, stream, (pcm) => this.onCaptureFrame(pcm))
    } catch (error) {
      stopTracks(stream)
      throw error
    }
    if (generation !== this.generation) { handle.stop(); stopTracks(stream); return }
    this.capture = handle
    this.watchForSuspension(ctx)
  }

  private watchForSuspension(ctx: VoiceAudioContext): void {
    this.watcher?.stop()
    const watcher = new SuspendWatcher(this.deps.doc, {
      onSuspended: () => this.store.dispatch({ type: "suspended" }),
      onReturn: ({ suspendedMs }) => { void this.handleReturn(suspendedMs) },
    }, this.deps.now)
    const track = this.capture?.track
    if (track) watcher.watchTrack(track)
    watcher.watchContext(ctx)
    this.watcher = watcher
  }

  private onCaptureFrame(pcm: Int16Array): void {
    const state = this.store.snapshot
    if (state.status !== "on") return
    const player = this.player
    if (this.detector && player && this.detector.feed(rms(pcm), player.isActive())) this.bargeIn(player)
    if (this.options.mode === "hands-free" || this.talking) this.socket?.sendAudio(pcm)
  }

  /** Playback stops on this thread, then the gateway is told where it stopped. */
  private bargeIn(player: VoicePlayerLike): void {
    const cut = player.flush()
    this.socket?.send({ type: "barge_in", segmentId: cut?.segmentId ?? null, playedMs: cut?.playedMs ?? 0 })
  }

  // ── suspension ────────────────────────────────────────────────────────────

  private async handleReturn(suspendedMs: number): Promise<void> {
    this.pendingResumeMs = suspendedMs
    const ctx = this.ctx
    if (!ctx || this.closing) return
    if (ctx.state !== "running") await this.tryResumeContext(ctx)
    if (!this.recovered(ctx)) {
      this.store.dispatch({ type: "needs-tap" })
      return
    }
    this.watcher?.clear()
    this.store.dispatch({ type: "resumed" })
    this.sendResume()
  }

  /** Socket open, microphone live and audio running: nothing needs a gesture. */
  private recovered(ctx: VoiceAudioContext): boolean {
    return this.socket?.isOpen === true && this.capture?.track?.readyState === "live" && ctx.state === "running"
  }

  private async tryResumeContext(ctx: VoiceAudioContext): Promise<void> {
    const wait = new Promise<void>((resolve) => setTimeout(resolve, CONTEXT_RESUME_WAIT_MS))
    await Promise.race([ctx.resume().catch(() => undefined), wait])
  }

  // ── teardown ──────────────────────────────────────────────────────────────

  private failStart(message: string): void {
    this.closing = true
    dropHandoff(this)
    this.socket?.close(1000, "bye")
    this.teardown()
    this.store.dispatch({ type: "failed", message })
  }

  private teardown(): void {
    this.generation++
    this.talking = false
    this.pendingResumeMs = null
    this.capture?.stop()
    this.capture = null
    this.player?.dispose()
    this.player = null
    this.watcher?.stop()
    this.watcher = null
    this.detector = null
    this.removeMediaSession?.()
    this.removeMediaSession = null
    const ctx = this.ctx
    this.ctx = null
    this.socket = null
    if (ctx) void ctx.close().catch(() => undefined)
  }
}
