import type { VoiceMode } from "@hundredfold/gateway-events"
import type { HundredfoldNativeBridge, NativeStateEvent } from "@/platform/native-bridge"
import { parseServerFrame } from "./socket"
import { VoiceStore, type VoiceController } from "./controller"
import type { VoiceUiState } from "./state"

export interface NativeVoiceOptions {
  sessionId: string
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

  constructor(
    private readonly bridge: NativeVoiceBridge,
    private readonly options: NativeVoiceOptions,
    private readonly now: () => number = Date.now,
  ) {}

  getSnapshot = (): VoiceUiState => this.store.snapshot
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  start(): Promise<void> {
    if (this.store.snapshot.status !== "off") return Promise.resolve()
    this.stopping = false
    this.talking = false
    this.store.dispatch({ type: "connecting", mode: this.options.mode })
    // The shell command is invoked inside the tap; its result is awaited afterwards.
    const started = this.bridge.voiceStart(
      { target: { origin: this.options.origin }, sessionId: this.options.sessionId, mode: this.options.mode },
      (raw) => this.onForwarded(raw),
    )
    return started.then(
      (result) => { if (!result.ok) this.store.dispatch({ type: "failed", message: nativeStartMessage("unsupported") }) },
      (error: unknown) => { this.store.dispatch({ type: "failed", message: nativeStartMessage(error) }) },
    )
  }

  stop(): void {
    if (this.store.snapshot.status === "off") return
    this.stopping = true
    this.talking = false
    void this.bridge.voiceStop().catch(() => undefined)
    this.store.dispatch({ type: "stopped" })
  }

  dispose(): void {
    this.stop()
  }

  pttDown(): void {
    if (this.options.mode !== "push-to-talk" || this.store.snapshot.status !== "on" || this.talking) return
    this.talking = true
    void this.bridge.voicePtt({ down: true }).catch(() => undefined)
  }

  pttUp(): void {
    if (!this.talking) return
    this.talking = false
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
    if (this.stopping) return
    const native = asNativeState(raw)
    const frame = native ? null : parseServerFrame(typeof raw === "string" ? raw : JSON.stringify(raw))
    if (native) this.store.dispatch({ type: "native-state", state: native.state, reason: native.reason, code: native.code })
    else if (frame) this.store.dispatch({ type: "frame", frame, now: this.now() })
    // A run the shell or gateway ended while the button was held leaves nothing held.
    if (this.store.snapshot.status === "off") this.talking = false
  }
}
