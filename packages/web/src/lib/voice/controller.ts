import { INITIAL_VOICE_STATE, voiceReducer, type VoiceAction, type VoiceUiState } from "./state"

/**
 * How a controller on a chat that does not exist yet gets one: the first tap creates the session, and the
 * conversation attaches to it. `discard` is for a session that was created after the run had already ended.
 */
export interface VoiceSessionStarter {
  create(): Promise<string>
  discard(sessionId: string): void
}

/** What the composer control drives. The browser session and the native shell's session both implement it. */
export interface VoiceController {
  getSnapshot(): VoiceUiState
  /** The chat the controller is attached to, or null while it is still being created. Absent: the one it was made for. */
  boundSessionId?(): string | null
  subscribe(listener: () => void): () => void
  /** Start voice mode. Call it synchronously inside the tap handler: iOS only allows the microphone and audio there. */
  start(): Promise<void>
  stop(): void
  pttDown(): void
  pttUp(): void
  /** Resume after the device suspended voice mode; also a tap, for the same reason as `start`. */
  resumeFromTap(): Promise<void>
  dismissNotice(): void
  /** Forget the backgrounded-work chip's tasks once it has been shown as finished. */
  clearBackground(): void
  /** The control went away (the chat closed): stop capturing. */
  dispose(): void
}

/** A tiny store: state changes through the reducer, listeners hear about each one. */
export class VoiceStore {
  private state: VoiceUiState = INITIAL_VOICE_STATE
  private readonly listeners = new Set<() => void>()

  get snapshot(): VoiceUiState {
    return this.state
  }

  dispatch(action: VoiceAction): void {
    const next = voiceReducer(this.state, action)
    if (next === this.state) return
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
