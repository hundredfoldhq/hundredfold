import { VOICE_AUDIO_HEADER_BYTES, VOICE_INPUT_SAMPLE_RATE, VOICE_OUTPUT_SAMPLE_RATE, type VoiceClientFrame, type VoiceCueSettings, type VoiceMode, type VoiceOnsetSettings, type VoiceServerFrame } from "@hundredfold/gateway-events"
import { contextFields, errorFields, traceContextState, voiceLog, voiceNow } from "@/lib/voice-log"
import { startCapture, requestMicrophone } from "./capture-worklet"
import { DEFAULT_CUE_SETTINGS, VoiceCuePlayer, wantedCue, type CueAudioContext, type CueInputs, type VoiceCuePlayerLike } from "./cues"
import { VoiceStore, dropHandoff, type VoiceController, type VoiceSessionStarter } from "./controller"
import { OnsetDetector } from "./onset"
import { rms } from "./pcm"
import { VoicePlayer } from "./player"
import { VoiceSocket, type VoiceAudioChunk, type VoiceSocketClose, type VoiceSocketHandlers } from "./socket"
import {
  installMediaSession,
  SuspendWatcher,
  type MediaSessionLike,
  type SuspendContext,
  type SuspendDocument,
  type SuspendTrack,
} from "./suspend"
import type { VoiceAction, VoiceUiState } from "./state"
import { SeqTracker, SegmentTrace } from "./trace"
import { ScreenWakeLock, type WakeLockLike } from "./wake-lock"

export interface VoiceAudioContext extends CueAudioContext, SuspendContext {
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
  createCuePlayer(ctx: VoiceAudioContext): VoiceCuePlayerLike
  doc: SuspendDocument
  mediaSession?: MediaSessionLike
  /** `navigator.wakeLock`, where the browser has one. */
  wakeLock?: WakeLockLike
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

/** How long a microphone request made without a tap may take before the tap is asked for instead. */
const MICROPHONE_REACQUIRE_WAIT_MS = 2_000

/** Audio for an unknown segment this soon after a cut is the cut reply's frames still in flight, so it is logged at debug. */
const AFTER_CUT_GRACE_MS = 2_000

/** How long a cut segment's id is remembered, so its late audio is logged at debug too. */
const CUT_MEMORY_MS = 30_000

export function defaultBrowserDeps(): BrowserVoiceDeps {
  return {
    openSocket: (sessionId, handlers, mode) => VoiceSocket.open(sessionId, handlers, { mode }),
    createContext: () => new AudioContext({ latencyHint: "interactive" }) as unknown as VoiceAudioContext,
    requestMicrophone: () => requestMicrophone(),
    startCapture: (ctx, stream, onFrame) => startCapture(ctx as unknown as AudioContext, stream, onFrame),
    createPlayer: (ctx, onPlayed) => new VoicePlayer(ctx, { onPlayed }),
    createCuePlayer: (ctx) => new VoiceCuePlayer(ctx),
    doc: document,
    mediaSession: typeof navigator !== "undefined" && "mediaSession" in navigator ? (navigator.mediaSession as unknown as MediaSessionLike) : undefined,
    wakeLock: typeof navigator !== "undefined" && "wakeLock" in navigator ? (navigator.wakeLock as unknown as WakeLockLike) : undefined,
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
  private cuePlayer: VoiceCuePlayerLike | null = null
  private removeMediaSession: (() => void) | null = null
  private wakeLock: ScreenWakeLock | null = null
  private closing = false
  /** Bumped on every start and every teardown; an await that resumes under a different value belongs to a run that is over. */
  private generation = 0
  private talking = false
  private pendingResumeMs: number | null = null
  private session: string | null
  // Diagnostics only: none of this feeds back into behaviour.
  private runStartedAt = 0
  private onset: VoiceOnsetSettings | null = null
  private readonly traces = new Map<number, SegmentTrace>()
  private readonly audioSeq = new SeqTracker()
  /** Segments a local barge-in or a stop_playback just cut, by when: their in-flight audio is expected, not a fault. */
  private readonly cutAt = new Map<number, number>()
  private lastCutAtMs: number | null = null
  private stopContextTrace: (() => void) | null = null
  private pttAt = 0

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
    this.apply({ type: "connecting", mode: this.options.mode })
    this.closing = false
    const generation = ++this.generation
    // The three calls iOS requires inside the tap, before any await.
    const ctx = this.deps.createContext()
    void ctx.resume().catch(() => undefined)
    const microphone = this.deps.requestMicrophone()
    this.ctx = ctx
    this.runStartedAt = voiceNow()
    this.stopContextTrace = traceContextState(ctx, "voice")
    voiceLog.info("session_start", { kind: "browser", mode: this.options.mode, barge_in: this.options.bargeIn, session: this.session, new_chat: this.session === null, ...contextFields(ctx) })
    this.wakeLock = new ScreenWakeLock(this.deps.wakeLock, this.deps.doc)
    this.wakeLock.acquire()
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
    starter.bind(id, this)
    this.openSocket(id)
    return this.attachMicrophone(microphone, generation)
  }

  stop(): void {
    if (this.store.snapshot.status === "off" && !this.ctx) return
    voiceLog.info("session_stop", { kind: "browser", status: this.store.snapshot.status, run_ms: this.runMs() })
    this.closing = true
    dropHandoff(this)
    this.socket?.send({ type: "bye" })
    this.socket?.close(1000, "bye")
    this.teardown()
    this.apply({ type: "stopped" })
  }

  dispose(): void {
    this.stop()
  }

  pttDown(): void {
    if (this.options.mode !== "push-to-talk" || this.store.snapshot.status !== "on" || this.talking) return
    this.talking = true
    this.pttAt = voiceNow()
    this.socket?.send({ type: "ptt_down" })
    this.syncCue()
  }

  pttUp(): void {
    if (!this.talking) return
    this.talking = false
    voiceLog.info("ptt_held", { held_ms: voiceNow() - this.pttAt })
    this.socket?.send({ type: "ptt_up" })
    this.syncCue()
  }

  dismissNotice(): void {
    this.apply({ type: "dismiss-notice" })
  }

  clearBackground(): void {
    this.apply({ type: "background-cleared" })
  }

  resumeFromTap(): Promise<void> {
    voiceLog.info("resume_from_tap", { status: this.store.snapshot.status, socket_open: this.socket?.isOpen === true, mic_live: this.microphoneLive(), ctx_state: this.ctx?.state })
    const ctx = this.ctx
    if (!ctx || this.session === null) return this.start()
    void ctx.resume().catch(() => undefined)
    const microphone = this.microphoneLive() ? null : this.deps.requestMicrophone()
    this.watcher?.clear()
    if (this.socket?.isOpen) {
      this.apply({ type: "resumed" })
      this.sendResume()
    } else {
      // A new attachment: it is `ready` again before audio goes up, and the `resume` follows then.
      this.apply({ type: "connecting", mode: this.options.mode })
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
    this.syncCue()
  }

  /** Every state change goes through here, so the cue is re-decided from the state it leaves. */
  private apply(action: VoiceAction): void {
    this.store.dispatch(action)
    this.syncCue()
  }

  /**
   * Plays the cue the gateway's state calls for, or none. The cue never plays while speech is audible (the player
   * has an open segment, which starts at `segment_start`, before its first audio) or while the user is heard.
   */
  private syncCue(): void {
    const state = this.store.snapshot
    const settings = state.ready?.cues ?? DEFAULT_CUE_SETTINGS
    const cue = wantedCue(this.cueInputs(state, settings))
    if (!cue && !this.cuePlayer) return
    this.cuePlayer ??= this.ctx ? this.deps.createCuePlayer(this.ctx) : null
    this.cuePlayer?.set(cue, settings.volume)
  }

  private cueInputs(state: VoiceUiState, settings: VoiceCueSettings): CueInputs {
    return {
      settings,
      running: state.status === "on",
      turn: state.turn,
      hearing: state.vadSpeaking || state.partial !== "" || this.talking,
      speechAudible: this.player?.isActive() === true,
      toolBackgrounded: state.toolBackgrounded,
    }
  }

  private applyToAudio(frame: VoiceServerFrame): void {
    switch (frame.type) {
      case "ready": this.onReady(frame); break
      case "segment_start": this.traceSegmentStart(frame); this.player?.beginSegment(frame.segmentId); break
      case "segment_end": this.traceSegmentEnd(frame.segmentId); this.player?.endSegment(frame.segmentId); break
      case "stop_playback": this.onStopPlayback(frame.reason); break
      case "detached": this.onDetached(); break
      default: break
    }
  }

  /** The gateway ended this attachment: release the microphone and audio now, keeping its reason on screen. */
  private onDetached(): void {
    voiceLog.info("session_detached", { run_ms: this.runMs() })
    this.closing = true
    this.socket?.close(1000, "detached")
    this.teardown()
  }

  private onReady(frame: Extract<VoiceServerFrame, { type: "ready" }>): void {
    this.detector = this.options.bargeIn ? new OnsetDetector(frame.onset) : null
    this.onset = frame.onset
    this.logReady(frame)
    this.removeMediaSession ??= installMediaSession(this.deps.mediaSession, () => this.stop(), this.deps.createMediaMetadata ?? (() => null))
    this.sendResume()
  }

  private sendResume(): void {
    if (this.pendingResumeMs === null || this.store.snapshot.status !== "on" || !this.socket?.isOpen) return
    this.socket.send({ type: "resume", suspendedMs: this.pendingResumeMs })
    this.pendingResumeMs = null
  }

  private onAudio(chunk: VoiceAudioChunk): void {
    this.traceAudio(chunk)
    this.player?.enqueue(chunk.segmentId, chunk.pcm)
  }

  private onClose(close: VoiceSocketClose): void {
    this.socket = null
    voiceLog.info("session_socket_closed", { code: close.code, reason: close.reason, requested: this.closing, status: this.store.snapshot.status, run_ms: this.runMs(), open_segments: this.traces.size })
    if (this.closing) return
    // Only an established socket can be suspended. One that never reached `ready` (a failed reconnect) failed on its own.
    const suspended = this.store.snapshot.status !== "connecting" && (this.watcher?.socketClosed() ?? false)
    this.apply({ type: "closed", code: close.code, reason: close.reason, requested: false })
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
    this.player ??= this.deps.createPlayer(ctx, (segmentId) => {
      this.traceSegmentFinished(segmentId, "played")
      this.socket?.send({ type: "played", segmentId })
      this.syncCue()
    })
    let handle: VoiceCaptureHandle
    try {
      handle = await this.deps.startCapture(ctx, stream, (pcm) => this.onCaptureFrame(pcm))
    } catch (error) {
      stopTracks(stream)
      throw error
    }
    if (generation !== this.generation) { handle.stop(); stopTracks(stream); return }
    // A return and a tap can both have asked for a microphone: the later one wins, the earlier is let go.
    this.capture?.stop()
    this.capture = handle
    voiceLog.info("capture_attached", { track_state: handle.track?.readyState, track_muted: handle.track?.muted, ...contextFields(ctx) })
    this.watchForSuspension(ctx)
  }

  private watchForSuspension(ctx: VoiceAudioContext): void {
    this.watcher?.stop()
    const watcher = new SuspendWatcher(this.deps.doc, {
      onSuspended: () => this.apply({ type: "suspended" }),
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
    if (this.detector && player) {
      const active = player.isActive()
      const level = rms(pcm)
      if (active) this.traceMic(level)
      if (this.detector.feed(level, active)) this.bargeIn(player, level)
    }
    if (this.options.mode === "hands-free" || this.talking) this.socket?.sendAudio(pcm)
  }

  /** Playback stops on this thread, then the gateway is told where it stopped. */
  private bargeIn(player: VoicePlayerLike, level: number): void {
    const cut = player.flush()
    this.logBargeIn(level, cut)
    this.socket?.send({ type: "barge_in", segmentId: cut?.segmentId ?? null, playedMs: cut?.playedMs ?? 0 })
    this.syncCue()
  }

  // ── suspension ────────────────────────────────────────────────────────────

  /**
   * The page is back after a suspension. Put back whatever the device took,
   * without a tap where the browser allows it: the audio context and the
   * microphone. A lost socket, or a microphone the browser will not hand
   * over without a gesture, is left for the one tap-to-resume.
   */
  private async handleReturn(suspendedMs: number): Promise<void> {
    this.pendingResumeMs = suspendedMs
    const ctx = this.ctx
    const generation = this.generation
    if (!ctx || this.closing) return
    voiceLog.info("return_from_suspend", { suspended_ms: suspendedMs, ...contextFields(ctx), socket_open: this.socket?.isOpen === true, mic_live: this.microphoneLive() })
    if (!(await this.putBackAudio(ctx, generation))) return
    if (!this.recovered(ctx)) {
      voiceLog.warn("return_needs_tap", { ...contextFields(ctx), socket_open: this.socket?.isOpen === true, mic_live: this.microphoneLive() })
      // A tap made meanwhile already resumed the session and is bringing the microphone back itself; only a session still paused asks for one.
      if (this.store.snapshot.status === "suspended") this.apply({ type: "needs-tap" })
      return
    }
    this.watcher?.clear()
    voiceLog.info("return_recovered", { suspended_ms: suspendedMs })
    this.apply({ type: "resumed" })
    this.sendResume()
  }

  /** The audio context, then the microphone. False when the run ended meanwhile. */
  private async putBackAudio(ctx: VoiceAudioContext, generation: number): Promise<boolean> {
    if (ctx.state !== "running") await this.tryResumeContext(ctx)
    if (generation !== this.generation) return false
    // A lost socket is only reopened inside a tap, and that tap asks for the microphone too, so don't ask twice.
    if (this.socket?.isOpen && !this.microphoneLive()) await this.reacquireMicrophone(generation)
    return generation === this.generation
  }

  /** A microphone that died with the suspension, asked for again with no tap. A refusal or a wait leaves the tap to do it. */
  private async reacquireMicrophone(generation: number): Promise<void> {
    this.capture?.stop()
    this.capture = null
    const microphone = this.deps.requestMicrophone()
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MICROPHONE_REACQUIRE_WAIT_MS) })
    try {
      const stream = await Promise.race([microphone, wait])
      voiceLog.info("mic_reacquire", { got_stream: Boolean(stream), waited_ms: MICROPHONE_REACQUIRE_WAIT_MS })
      if (!stream) {
        // Too slow: the tap asks again, so whatever this request yields later is let go.
        void microphone.then(stopTracks, () => undefined)
        return
      }
      await this.beginCapture(stream, generation)
    } catch (error) {
      voiceLog.warn("mic_reacquire_failed", errorFields(error))
      /* refused or failed: it needs a tap */
    } finally {
      clearTimeout(timer)
    }
  }

  /** A microphone that is neither ended nor muted by the device. */
  private microphoneLive(): boolean {
    const track = this.capture?.track
    return track?.readyState === "live" && track.muted !== true
  }

  /** Socket open, microphone live and audio running: nothing needs a gesture. */
  private recovered(ctx: VoiceAudioContext): boolean {
    return this.socket?.isOpen === true && this.microphoneLive() && ctx.state === "running"
  }

  private async tryResumeContext(ctx: VoiceAudioContext): Promise<void> {
    const wait = new Promise<void>((resolve) => setTimeout(resolve, CONTEXT_RESUME_WAIT_MS))
    const before = ctx.state
    const at = voiceNow()
    await Promise.race([ctx.resume().catch(() => undefined), wait])
    voiceLog.info("context_resume_attempt", { from: before, to: ctx.state, waited_ms: voiceNow() - at, limit_ms: CONTEXT_RESUME_WAIT_MS })
  }

  // ── teardown ──────────────────────────────────────────────────────────────

  private failStart(message: string): void {
    voiceLog.warn("session_start_failed", { message_chars: message.length, run_ms: this.runMs() })
    this.closing = true
    dropHandoff(this)
    this.socket?.close(1000, "bye")
    this.teardown()
    this.apply({ type: "failed", message })
  }

  private teardown(): void {
    this.finishTraces("cut", "teardown", null)
    this.stopContextTrace?.()
    this.stopContextTrace = null
    voiceLog.info("session_teardown", { run_ms: this.runMs() })
    this.generation++
    this.talking = false
    this.pendingResumeMs = null
    this.capture?.stop()
    this.capture = null
    this.cuePlayer?.dispose()
    this.cuePlayer = null
    this.player?.dispose()
    this.player = null
    this.watcher?.stop()
    this.watcher = null
    this.detector = null
    this.removeMediaSession?.()
    this.removeMediaSession = null
    this.wakeLock?.release()
    this.wakeLock = null
    const ctx = this.ctx
    this.ctx = null
    this.socket = null
    if (ctx) void ctx.close().catch(() => undefined)
  }
  // ── diagnostics ───────────────────────────────────────────────────────────

  private runMs(): number {
    return this.runStartedAt === 0 ? 0 : Math.round(voiceNow() - this.runStartedAt)
  }

  private logReady(frame: Extract<VoiceServerFrame, { type: "ready" }>): void {
    voiceLog.info("session_ready", {
      run_ms: this.runMs(),
      output_rate: frame.output?.sampleRate,
      input_rate: frame.input?.sampleRate,
      player_rate: VOICE_OUTPUT_SAMPLE_RATE,
      capture_rate: VOICE_INPUT_SAMPLE_RATE,
      barge_in: this.detector !== null,
      ...contextFields(this.ctx),
    })
    // The player and the capture worklet use the fixed protocol rates, not what the gateway advertised.
    if (frame.output?.sampleRate !== VOICE_OUTPUT_SAMPLE_RATE) {
      voiceLog.warn("output_rate_mismatch", { advertised: frame.output?.sampleRate, used: VOICE_OUTPUT_SAMPLE_RATE })
    }
    if (frame.input?.sampleRate !== VOICE_INPUT_SAMPLE_RATE) {
      voiceLog.warn("input_rate_mismatch", { advertised: frame.input?.sampleRate, used: VOICE_INPUT_SAMPLE_RATE })
    }
  }

  private traceSegmentStart(frame: Extract<VoiceServerFrame, { type: "segment_start" }>): void {
    if (this.traces.has(frame.segmentId)) voiceLog.warn("segment_restart", { segment: frame.segmentId })
    this.traces.set(frame.segmentId, new SegmentTrace(frame.segmentId, voiceNow(), frame.text?.length ?? 0))
  }

  private traceSegmentEnd(segmentId: number): void {
    const trace = this.traces.get(segmentId)
    if (!trace) {
      voiceLog.warn("segment_end_unknown", { segment: segmentId })
      return
    }
    trace.end(voiceNow())
    if (trace.frames === 0) voiceLog.warn("segment_end_without_audio", { segment: segmentId, since_start_ms: voiceNow() - trace.startedAtMs })
  }

  private traceAudio(chunk: VoiceAudioChunk): void {
    const now = voiceNow()
    const trace = this.traces.get(chunk.segmentId)
    const step = this.audioSeq.next(chunk.seq)
    if (!trace) {
      const fields = { segment: chunk.segmentId, seq: chunk.seq, samples: chunk.pcm.length }
      const cutAt = this.cutAt.get(chunk.segmentId) ?? this.lastCutAtMs
      if (cutAt !== null && (this.cutAt.has(chunk.segmentId) || now - cutAt < AFTER_CUT_GRACE_MS)) {
        voiceLog.debug("audio_after_cut", () => ({ ...fields, since_cut_ms: Math.round(now - cutAt) }))
      } else {
        voiceLog.warn("audio_without_segment", fields)
      }
      return
    }
    if (trace.ended) voiceLog.warn("audio_after_segment_end", { segment: chunk.segmentId, seq: chunk.seq, late_ms: now - (trace.endedAtMs ?? now) })
    if (trace.frames === 0) {
      voiceLog.info("segment_first_audio", { segment: chunk.segmentId, since_start_ms: now - trace.startedAtMs, seq: chunk.seq, samples: chunk.pcm.length })
    }
    trace.frame(step, VOICE_AUDIO_HEADER_BYTES + chunk.pcm.length * 2, chunk.pcm.length, now)
  }

  /** Microphone level while speech is audible: the figure the onset detector sees, for judging echo against the threshold. */
  private traceMic(level: number): void {
    for (const trace of this.traces.values()) trace.micLevel(level)
    const threshold = this.onset?.threshold
    if (threshold !== undefined && level >= threshold) voiceLog.debug("onset_level", { level, threshold })
  }

  private logBargeIn(level: number, cut: { segmentId: number | null; playedMs: number } | null): void {
    const threshold = this.onset?.threshold
    const minSpeechMs = this.onset?.minSpeechMs
    voiceLog.info("barge_in_local", { level, threshold, min_speech_ms: minSpeechMs, segment: cut?.segmentId ?? null, played_ms: cut?.playedMs ?? 0, mic_live: this.microphoneLive() })
    this.finishTraces("cut", "barge_in", cut?.segmentId ?? null)
  }

  private onStopPlayback(reason: string): void {
    const cut = this.player?.flush() ?? null
    voiceLog.info("playback_cut", { reason: "stop_playback", cause: reason, segment: cut?.segmentId ?? null, played_ms: cut?.playedMs ?? 0 })
    this.finishTraces("cut", `stop_playback_${reason}`, cut?.segmentId ?? null)
  }

  private traceSegmentFinished(segmentId: number, outcome: "played" | "cut", reason?: string, cutSegment?: number | null): void {
    const trace = this.traces.get(segmentId)
    if (!trace) return
    this.traces.delete(segmentId)
    voiceLog.info("segment_summary", { ...trace.summary(outcome, voiceNow(), VOICE_OUTPUT_SAMPLE_RATE), reason, cut_here: cutSegment === segmentId })
  }

  /** The player dropped everything: each segment still open ends as cut. */
  private finishTraces(outcome: "played" | "cut", reason: string, cutSegment: number | null): void {
    if (outcome === "cut") this.rememberCut([...this.traces.keys()])
    for (const id of [...this.traces.keys()]) this.traceSegmentFinished(id, outcome, reason, cutSegment)
  }

  /** The segments just cut, so the audio still in flight for them is logged at debug, as the player does. */
  private rememberCut(ids: number[]): void {
    const now = voiceNow()
    this.lastCutAtMs = now
    for (const [id, at] of this.cutAt) if (now - at >= CUT_MEMORY_MS) this.cutAt.delete(id)
    for (const id of ids) this.cutAt.set(id, now)
  }
}
