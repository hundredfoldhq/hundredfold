/**
 * Keeps the screen on while voice mode runs, so a phone does not dim and lock
 * on its own in the middle of a conversation. The browser drops the lock
 * whenever the page hides, so it is asked for again when the page is visible.
 * Where the API is missing, or a request fails (low battery, no permission),
 * voice mode carries on without it.
 */

export interface WakeLockSentinelLike {
  release(): Promise<void>
  addEventListener(type: "release", listener: () => void): void
}

export interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>
}

export interface WakeLockDocument {
  readonly visibilityState: string
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
}

export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null
  private requesting = false
  private held = false

  constructor(
    private readonly api: WakeLockLike | undefined,
    private readonly doc: WakeLockDocument,
  ) {}

  private readonly onVisibility = (): void => {
    if (this.doc.visibilityState === "visible") void this.request()
  }

  /** Starts holding the lock until `release`. Safe to call more than once. */
  acquire(): void {
    if (this.held || !this.api) return
    this.held = true
    this.doc.addEventListener("visibilitychange", this.onVisibility)
    if (this.doc.visibilityState === "visible") void this.request()
  }

  release(): void {
    if (!this.held) return
    this.held = false
    this.doc.removeEventListener("visibilitychange", this.onVisibility)
    const sentinel = this.sentinel
    this.sentinel = null
    if (sentinel) void sentinel.release().catch(() => undefined)
  }

  private async request(): Promise<void> {
    if (!this.api || !this.held || this.sentinel || this.requesting) return
    this.requesting = true
    try {
      const sentinel = await this.api.request("screen")
      // Released while the request was pending: nobody wants it any more.
      if (!this.held) { void sentinel.release().catch(() => undefined); return }
      sentinel.addEventListener("release", () => { if (this.sentinel === sentinel) this.sentinel = null })
      this.sentinel = sentinel
    } catch {
      /* the browser refused; voice mode does not need the lock to work */
    } finally {
      this.requesting = false
    }
  }
}
