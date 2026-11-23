import { INITIAL_VOICE_STATE, voiceReducer, type VoiceAction, type VoiceUiState } from "./state"

/**
 * How a controller on a chat that does not exist yet gets one: the first tap creates the session, and the
 * conversation attaches to it. `create` only makes the session. `bind` is called once the controller knows its run is
 * still live, before the conversation attaches: the pane moves onto the chat then, never earlier. `discard` is for a
 * session that was created after the run had already ended; it was never bound.
 */
export interface VoiceSessionStarter {
  create(): Promise<string>
  bind(sessionId: string, controller: VoiceController): void
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

/**
 * A controller that created its chat is handed to the pane that binds to it, even when the pane remounts to do so (the
 * tabbed layout keys a pane by its chat). The remount renders before the old pane's cleanup runs, so the new pane claims
 * the controller while rendering and the old pane's cleanup then leaves it running. Claiming is idempotent (strict
 * mode renders twice); the new pane releases the claim once mounted, and from then on disposes it like any controller.
 */
const handoffs = new Map<string, { controller: VoiceController; claimed: boolean }>()

export function offerHandoff(sessionId: string, controller: VoiceController): void {
  handoffs.set(sessionId, { controller, claimed: false })
}

const adopted = new WeakSet<VoiceController>()

/** How long a pane that is going away waits for the pane that replaces it to claim the controller. */
export const HANDOFF_GRACE_MS = 3_000

export function claimHandoff(sessionId: string): VoiceController | undefined {
  const entry = handoffs.get(sessionId)
  if (!entry) return undefined
  entry.claimed = true
  adopted.add(entry.controller)
  return entry.controller
}

/** Whether the controller has been offered and nobody has claimed it yet. */
export function awaitsClaim(controller: VoiceController): boolean {
  for (const entry of handoffs.values()) if (entry.controller === controller) return !entry.claimed
  return false
}

/** Whether a pane claimed the controller at some point since it was offered. */
export function wasAdopted(controller: VoiceController): boolean {
  return adopted.has(controller)
}

export function isClaimed(controller: VoiceController): boolean {
  for (const entry of handoffs.values()) if (entry.controller === controller) return entry.claimed
  return false
}

/** The claim is over: the claiming pane has mounted and owns the controller. */
export function releaseClaim(controller: VoiceController): void {
  for (const [id, entry] of handoffs) if (entry.controller === controller && entry.claimed) handoffs.delete(id)
}

/** The run ended: nothing is left to hand over. */
export function dropHandoff(controller: VoiceController): void {
  for (const [id, entry] of handoffs) if (entry.controller === controller) handoffs.delete(id)
  adopted.delete(controller)
}
