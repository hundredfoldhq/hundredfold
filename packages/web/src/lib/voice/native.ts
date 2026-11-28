import type { VoiceMode } from "@hundredfold/gateway-events"
import type { HundredfoldNativeBridge, NativeStateEvent } from "@/platform/native-bridge"
import { errorFields, voiceLog, voiceNow } from "@/lib/voice-log"
import { parseServerFrame } from "./socket"
import { describeServerFrame, isChattyFrame } from "./trace"
import { VoiceStore, dropHandoff, type VoiceController, type VoiceSessionStarter } from "./controller"
import type { VoiceUiState } from "./state"

export interface NativeVoiceOptions {
  /** The chat, or how to create one when the control is on a new chat. */
  sessionId: string | VoiceSessionStarter
  mode: VoiceMode
  origin: string
}

/** The native voice commands, when the shell offers them. */
export type NativeVoiceBridge = HundredfoldNativeBridge & Required<Pick<HundredfoldNativeBridge, "voiceStart" | "voiceStop" | "voicePtt">>

export function nativeVoiceBridge(bridge: HundredfoldNativeBridge | undefined): NativeVoiceBridge | null {
  if (!bridge || !bridge.voiceStart || !bridge.voiceStop || !bridge.voicePtt) return null
  return bridge as NativeVoiceBridge
}

/** Only these two are worth a specific sentence; every other code (unsupported, voice-busy, ...) is the generic one. */
const START_ERRORS: Record<string, string> = {
  "permission-denied": "Microphone permission was denied. Allow it in the phone's settings for this app.",
  "not-paired": "This app is not paired with the gateway.",
}
const GENERIC_START_ERROR = "Couldn't start voice mode on this device."

/** The shell's native errors are kebab-case (`permission-denied`); an underscored spelling means the same. */
function kebab(code: string): string {
  return code.trim().toLowerCase().replaceAll("_", "-")
}

function errorCode(error: unknown): string {
  if (typeof error === "string") return kebab(error)
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string") return kebab(code)
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return kebab(message)
  }
  return ""
}

export function nativeStartMessage(error: unknown): string {
  const code = errorCode(error)
  return Object.hasOwn(START_ERRORS, code) ? START_ERRORS[code] : GENERIC_START_ERROR
}

const NATIVE_STATES = new Set(["connecting", "running", "paused", "stopped"])

/** The shell's own state object, whether forwarded parsed or as a string. */
export function asNativeState(raw: unknown): NativeStateEvent | null {
  let value = raw
  if (typeof raw === "string") {
    try { value = JSON.parse(raw) } catch { return null }
  }
  if (!value || typeof value !== "object") return null
  const event = value as { type?: unknown; state?: unknown; code?: unknown }
  if (event.type !== "native_state" || typeof event.state !== "string" || !NATIVE_STATES.has(event.state)) return null
  // `code` is only meaningful as a number; anything else is dropped rather than trusted.
  return typeof event.code === "number" ? (value as NativeStateEvent) : ({ ...(value as NativeStateEvent), code: undefined })
}

/**
 * Voice mode in the mobile shell: the shell opens the voice socket and owns
 * the microphone and speaker, so this side only starts and stops it and
 * renders the gateway's frames, which are forwarded unchanged. That keeps it
 * running with the screen locked, when a WebView's JavaScript may not be.
 */
export class NativeVoiceSession implements VoiceController {
  private readonly store = new VoiceStore()
  private stopping = false
  private talking = false
  // Diagnostics only.
  private startedAt = 0
  private forwarded = 0
  private lastForwardedAt = 0
  private pttAt = 0

  private session: string | null

  constructor(
    private readonly bridge: NativeVoiceBridge,
    private readonly options: NativeVoiceOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.session = typeof options.sessionId === "string" ? options.sessionId : null
  }

  boundSessionId = (): string | null => this.session

  getSnapshot = (): VoiceUiState => this.store.snapshot
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  start(): Promise<void> {
    if (this.store.snapshot.status !== "off") return Promise.resolve()
    this.stopping = false
    this.talking = false
    this.startedAt = voiceNow()
    voiceLog.info("session_start", { kind: "native", mode: this.options.mode, session: this.session, new_chat: this.session === null })
    this.store.dispatch({ type: "connecting", mode: this.options.mode })
    if (this.session === null) return this.createThenStart()
    return this.startShell(this.session)
  }

  /** A new chat: the shell needs the id, so the session is created first and the shell started on it. */
  private async createThenStart(): Promise<void> {
    const starter = this.options.sessionId as VoiceSessionStarter
    let id: string
    try {
      id = await starter.create()
    } catch (error) {
      this.store.dispatch({ type: "failed", message: error instanceof Error && error.message ? error.message : GENERIC_START_ERROR })
      return
    }
    if (this.stopping || this.store.snapshot.status === "off") {
      starter.discard(id)
      return
    }
    this.session = id
    starter.bind(id, this)
    return this.startShell(id)
  }

  private startShell(sessionId: string): Promise<void> {
    // The shell command is invoked inside the tap when the chat exists; its result is awaited afterwards.
    const started = this.bridge.voiceStart(
      { target: { origin: this.options.origin }, sessionId, mode: this.options.mode },
      (raw) => this.onForwarded(raw),
    )
    return started.then(
      (result) => {
        voiceLog.info("native_voice_started", { ok: result.ok, wait_ms: voiceNow() - this.startedAt })
        if (!result.ok) this.store.dispatch({ type: "failed", message: nativeStartMessage("unsupported") })
      },
      (error: unknown) => {
        voiceLog.warn("native_voice_start_failed", { code: errorCode(error), wait_ms: voiceNow() - this.startedAt, ...errorFields(error) })
        this.store.dispatch({ type: "failed", message: nativeStartMessage(error) })
      },
    )
  }

  stop(): void {
    if (this.store.snapshot.status === "off") return
    this.stopping = true
    this.talking = false
    voiceLog.info("session_stop", { kind: "native", status: this.store.snapshot.status, run_ms: Math.round(voiceNow() - this.startedAt), forwarded: this.forwarded })
    dropHandoff(this)
    void this.bridge.voiceStop().catch(() => undefined)
    this.store.dispatch({ type: "stopped" })
  }

  dispose(): void {
    this.stop()
  }

  pttDown(): void {
    if (this.options.mode !== "push-to-talk" || this.store.snapshot.status !== "on" || this.talking) return
    this.talking = true
    this.pttAt = voiceNow()
    void this.bridge.voicePtt({ down: true }).catch(() => undefined)
  }

  pttUp(): void {
    if (!this.talking) return
    this.talking = false
    voiceLog.info("ptt_held", { held_ms: voiceNow() - this.pttAt, kind: "native" })
    void this.bridge.voicePtt({ down: false }).catch(() => undefined)
  }

  /** The shell resumes by itself after a lock or an interruption; there is nothing for a tap to do. */
  resumeFromTap(): Promise<void> {
    return Promise.resolve()
  }

  dismissNotice(): void {
    this.store.dispatch({ type: "dismiss-notice" })
  }

  clearBackground(): void {
    this.store.dispatch({ type: "background-cleared" })
  }

  private onForwarded(raw: unknown): void {
    if (this.stopping) {
      voiceLog.debug("native_frame_after_stop", { kind: typeof raw })
      return
    }
    const native = asNativeState(raw)
    const frame = native ? null : parseServerFrame(typeof raw === "string" ? raw : JSON.stringify(raw))
    this.logForwarded(raw, native, frame)
    if (native) this.store.dispatch({ type: "native-state", state: native.state, reason: native.reason, code: native.code })
    else if (frame) this.store.dispatch({ type: "frame", frame, now: this.now() })
    // A run the shell or gateway ended while the button was held leaves nothing held.
    if (this.store.snapshot.status === "off") this.talking = false
  }

  /** What the shell forwarded and what the web side made of it. The shell's audio never passes through here. */
  private logForwarded(raw: unknown, native: NativeStateEvent | null, frame: ReturnType<typeof parseServerFrame>): void {
    const at = voiceNow()
    const gap = this.lastForwardedAt === 0 ? null : at - this.lastForwardedAt
    this.lastForwardedAt = at
    this.forwarded += 1
    if (native) {
      voiceLog.info("native_state", { state: native.state, reason: native.reason, code: native.code, status: this.store.snapshot.status, gap_ms: gap })
    } else if (frame) {
      const fields = () => ({ via: "native", type: frame.type, gap_ms: gap, ...describeServerFrame(frame) })
      if (isChattyFrame(frame)) voiceLog.debug("frame_in", fields)
      else voiceLog.info("frame_in", fields)
    } else {
      voiceLog.warn("native_frame_ignored", { kind: typeof raw, chars: typeof raw === "string" ? raw.length : undefined })
    }
  }
}
