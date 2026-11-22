import { INITIAL_VOICE_STATE, voiceReducer, type VoiceAction, type VoiceUiState } from "./state"

/** What the composer control drives. The browser session and the native shell's session both implement it. */
export interface VoiceController {
  getSnapshot(): VoiceUiState
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
