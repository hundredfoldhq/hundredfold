/**
 * Detecting that the device suspended voice mode (a locked phone, a browser
 * that left the foreground) and reporting the return. A hidden page is not
 * suspended by itself: Android keeps many going. What counts is a sign that
 * capture or the socket actually stopped: the microphone track muting or
 * ending, the audio context leaving `running`, or the socket closing while
 * the page was hidden (or just brought back, which is when a browser delivers
 * the close it swallowed).
 */

export type SuspendReason = "track-muted" | "track-ended" | "audio-context" | "socket-closed"

export interface SuspendDocument {
  readonly visibilityState: string
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
}

export interface SuspendTrack {
  readonly readyState?: string
  readonly muted?: boolean
  addEventListener(type: "mute" | "unmute" | "ended", listener: () => void): void
  removeEventListener(type: "mute" | "unmute" | "ended", listener: () => void): void
}

export interface SuspendContext {
  readonly state: string
  addEventListener(type: "statechange", listener: () => void): void
  removeEventListener(type: "statechange", listener: () => void): void
}

export interface SuspendCallbacks {
  /** First sign of a suspension. The page may not be visible to show anything yet. */
  onSuspended?(reason: SuspendReason): void
  /** The page is back (or the device handed the microphone back) after a suspension. */
  onReturn(info: { suspendedMs: number; reason: SuspendReason }): void
}

/** A socket close this soon after the page became visible again is the suspension's, not a fresh failure. */
export const RETURN_GRACE_MS = 3_000

export class SuspendWatcher {
  private suspended: { at: number; reason: SuspendReason } | null = null
  private hiddenAt: number | null = null
  private lastHiddenAt: number | null = null
  private lastVisibleAt: number | null = null
  private readonly cleanups: Array<() => void> = []
  private track: SuspendTrack | null = null
  private ctx: SuspendContext | null = null

  constructor(
    private readonly doc: SuspendDocument,
    private readonly callbacks: SuspendCallbacks,
    private readonly now: () => number = Date.now,
  ) {
    if (doc.visibilityState === "hidden") this.hiddenAt = this.lastHiddenAt = now()
    const onVisibility = () => this.visibilityChanged()
    doc.addEventListener("visibilitychange", onVisibility)
    this.cleanups.push(() => doc.removeEventListener("visibilitychange", onVisibility))
  }

  get isSuspended(): boolean {
    return this.suspended !== null
  }

  watchTrack(track: SuspendTrack): void {
    this.track = track
    this.listen(track, "mute", () => this.markSuspended("track-muted"))
    this.listen(track, "ended", () => this.markSuspended("track-ended"))
    this.listen(track, "unmute", () => this.handBack())
  }

  watchContext(ctx: SuspendContext): void {
    this.ctx = ctx
    const changed = () => (ctx.state === "running" ? this.handBack() : this.markSuspendedUnlessClosed(ctx))
    ctx.addEventListener("statechange", changed)
    this.cleanups.push(() => ctx.removeEventListener("statechange", changed))
  }

  /** The socket closed without the user asking. Counts as a suspension only around a hidden page. */
  socketClosed(): boolean {
    if (!this.pageWasAway()) return false
    this.markSuspended("socket-closed")
    return true
  }

  /** Forgets a handled suspension, e.g. after the user tapped to resume. */
  clear(): void {
    this.suspended = null
  }

  stop(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  private listen<T extends SuspendTrack>(target: T, type: "mute" | "unmute" | "ended", listener: () => void): void {
    target.addEventListener(type, listener)
    this.cleanups.push(() => target.removeEventListener(type, listener))
  }

  private markSuspendedUnlessClosed(ctx: SuspendContext): void {
    if (ctx.state !== "closed") this.markSuspended("audio-context")
  }

  private pageWasAway(): boolean {
    if (this.hiddenAt !== null) return true
    return this.lastVisibleAt !== null && this.now() - this.lastVisibleAt <= RETURN_GRACE_MS
  }

  private markSuspended(reason: SuspendReason): void {
    if (this.suspended) return
    const at = this.hiddenAt ?? (this.pageWasAway() ? this.lastHiddenAt : null) ?? this.now()
    this.suspended = { at, reason }
    this.callbacks.onSuspended?.(reason)
    // A muted track or a paused context may come back by itself, which hands back via
    // its own event. An ended track or a lost socket never does, so say so now.
    if (reason === "track-ended" || reason === "socket-closed") this.handBack()
  }

  private visibilityChanged(): void {
    if (this.doc.visibilityState === "hidden") {
      this.hiddenAt = this.lastHiddenAt = this.now()
      return
    }
    this.hiddenAt = null
    this.lastVisibleAt = this.now()
    // A track that is still muted hands back through its own `unmute`, not now.
    this.checkLiveness()
    if (this.suspended?.reason === "track-muted" && this.track?.muted === true) return
    this.handBack()
  }

  /**
   * A browser does not always deliver the `ended` or `mute` event a suspension
   * caused (or delivers it only while the page is hidden), so on return look at
   * the microphone and the audio context directly.
   */
  private checkLiveness(): void {
    if (this.suspended) return
    if (this.track?.readyState === "ended") this.markSuspended("track-ended")
    else if (this.track?.muted === true) this.markSuspended("track-muted")
    else if (this.ctx && this.ctx.state !== "running" && this.ctx.state !== "closed") this.markSuspended("audio-context")
  }

  private handBack(): void {
    if (!this.suspended || this.doc.visibilityState === "hidden") return
    const { at, reason } = this.suspended
    this.suspended = null
    this.callbacks.onReturn({ suspendedMs: Math.max(0, this.now() - at), reason })
  }
}

export interface MediaSessionLike {
  metadata: unknown
  playbackState: string
  setActionHandler(action: string, handler: (() => void) | null): void
}

/**
 * Lock-screen and notification control where the browser offers one: shows
 * that voice mode is on and routes the stop (and pause) action to `onStop`.
 * Returns the function that takes it down again.
 */
export function installMediaSession(
  session: MediaSessionLike | undefined,
  onStop: () => void,
  createMetadata: () => unknown,
): () => void {
  if (!session) return () => undefined
  try {
    session.metadata = createMetadata()
    session.playbackState = "playing"
    session.setActionHandler("stop", onStop)
    session.setActionHandler("pause", onStop)
  } catch {
    return () => undefined
  }
  return () => {
    try {
      session.setActionHandler("stop", null)
      session.setActionHandler("pause", null)
      session.playbackState = "none"
      session.metadata = null
    } catch { /* the browser dropped it already */ }
  }
}
