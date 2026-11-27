import { describe, expect, it, vi } from "vitest"
import { installMediaSession, MUTED_RETURN_WAIT_MS, RETURN_GRACE_MS, SuspendWatcher, type MediaSessionLike } from "../suspend"

class FakeEmitter {
  private listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, l: () => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(l) }
  removeEventListener(type: string, l: () => void) { this.listeners.get(type)?.delete(l) }
  emit(type: string) { for (const l of [...(this.listeners.get(type) ?? [])]) l() }
  count(type: string) { return this.listeners.get(type)?.size ?? 0 }
}
class FakeDocument extends FakeEmitter {
  visibilityState = "visible"
  set(state: "visible" | "hidden") { this.visibilityState = state; this.emit("visibilitychange") }
}
class FakeContext extends FakeEmitter {
  state = "running"
  set(state: string) { this.state = state; this.emit("statechange") }
}

function setup() {
  let now = 1_000_000
  const doc = new FakeDocument()
  const track = new FakeEmitter()
  const ctx = new FakeContext()
  const callbacks = { onSuspended: vi.fn(), onReturn: vi.fn() }
  const watcher = new SuspendWatcher(doc, callbacks, () => now)
  watcher.watchTrack(track)
  watcher.watchContext(ctx)
  return { doc, track, ctx, callbacks, watcher, tick: (ms: number) => { now += ms } }
}

describe("SuspendWatcher on return, without any event", () => {
  function watched(track: { readyState?: string; muted?: boolean }) {
    let now = 1_000_000
    const doc = new FakeDocument()
    const emitter = Object.assign(new FakeEmitter(), track)
    const ctx = new FakeContext()
    const callbacks = { onSuspended: vi.fn(), onReturn: vi.fn() }
    const watcher = new SuspendWatcher(doc, callbacks, () => now)
    watcher.watchTrack(emitter)
    watcher.watchContext(ctx)
    return { doc, emitter, ctx, callbacks, watcher, tick: (ms: number) => { now += ms } }
  }

  it("finds a microphone track that ended while the page was hidden and reports the return", () => {
    const { doc, emitter, callbacks, tick } = watched({ readyState: "live" })
    doc.set("hidden")
    tick(40_000)
    emitter.readyState = "ended" // no `ended` event reached the page
    doc.set("visible")
    expect(callbacks.onSuspended).toHaveBeenCalledWith("track-ended")
    expect(callbacks.onReturn).toHaveBeenCalledWith({ suspendedMs: 40_000, reason: "track-ended" })
  })

  it("finds a track still muted on return, and waits for its unmute", () => {
    const { doc, emitter, callbacks } = watched({ readyState: "live", muted: false })
    doc.set("hidden")
    emitter.muted = true
    doc.set("visible")
    expect(callbacks.onSuspended).toHaveBeenCalledWith("track-muted")
    expect(callbacks.onReturn).not.toHaveBeenCalled()
    emitter.muted = false
    emitter.emit("unmute")
    expect(callbacks.onReturn).toHaveBeenCalledTimes(1)
  })

  describe("a track that stays muted after return", () => {
    it("is treated as lost once it has had a moment to unmute", () => {
      vi.useFakeTimers()
      try {
        const { doc, emitter, callbacks } = watched({ readyState: "live", muted: false })
        doc.set("hidden")
        emitter.muted = true
        emitter.emit("mute")
        doc.set("visible")
        vi.advanceTimersByTime(MUTED_RETURN_WAIT_MS - 1)
        expect(callbacks.onReturn).not.toHaveBeenCalled()
        vi.advanceTimersByTime(2)
        expect(callbacks.onReturn).toHaveBeenCalledTimes(1)
        expect(callbacks.onReturn).toHaveBeenCalledWith(expect.objectContaining({ reason: "track-muted" }))
      } finally { vi.useRealTimers() }
    })

    it("hands back once when it unmutes first", () => {
      vi.useFakeTimers()
      try {
        const { doc, emitter, callbacks } = watched({ readyState: "live", muted: false })
        doc.set("hidden")
        emitter.muted = true
        emitter.emit("mute")
        doc.set("visible")
        emitter.muted = false
        emitter.emit("unmute")
        vi.advanceTimersByTime(MUTED_RETURN_WAIT_MS * 2)
        expect(callbacks.onReturn).toHaveBeenCalledTimes(1)
      } finally { vi.useRealTimers() }
    })

    it("waits no longer if the page is hidden again, and stopping cancels the wait", () => {
      vi.useFakeTimers()
      try {
        const first = watched({ readyState: "live", muted: false })
        first.doc.set("hidden")
        first.emitter.muted = true
        first.emitter.emit("mute")
        first.doc.set("visible")
        first.doc.set("hidden")
        vi.advanceTimersByTime(MUTED_RETURN_WAIT_MS * 2)
        expect(first.callbacks.onReturn).not.toHaveBeenCalled()
        const second = watched({ readyState: "live", muted: false })
        second.doc.set("hidden")
        second.emitter.muted = true
        second.emitter.emit("mute")
        second.doc.set("visible")
        second.watcher.stop()
        vi.advanceTimersByTime(MUTED_RETURN_WAIT_MS * 2)
        expect(second.callbacks.onReturn).not.toHaveBeenCalled()
      } finally { vi.useRealTimers() }
    })
  })

  it("finds an audio context that is no longer running on return", () => {
    const { doc, ctx, callbacks } = watched({ readyState: "live" })
    doc.set("hidden")
    ctx.state = "interrupted" // no `statechange` reached the page
    doc.set("visible")
    expect(callbacks.onSuspended).toHaveBeenCalledWith("audio-context")
    expect(callbacks.onReturn).toHaveBeenCalledTimes(1)
  })

  it("a track that is fine on return is not a suspension", () => {
    const { doc, callbacks } = watched({ readyState: "live", muted: false })
    doc.set("hidden")
    doc.set("visible")
    expect(callbacks.onSuspended).not.toHaveBeenCalled()
  })
})

describe("SuspendWatcher", () => {
  it("does not treat a hidden page as suspended by itself", () => {
    const { doc, callbacks, tick } = setup()
    doc.set("hidden")
    tick(60_000)
    doc.set("visible")
    expect(callbacks.onSuspended).not.toHaveBeenCalled()
    expect(callbacks.onReturn).not.toHaveBeenCalled()
  })

  it("reports a muted track, and the return when the page is visible and the track unmutes", () => {
    const { doc, track, callbacks, tick } = setup()
    doc.set("hidden")
    tick(30_000)
    track.emit("mute")
    expect(callbacks.onSuspended).toHaveBeenCalledWith("track-muted")
    tick(30_000)
    doc.set("visible")
    expect(callbacks.onReturn).toHaveBeenCalledWith({ suspendedMs: 60_000, reason: "track-muted" })
  })

  it("measures the suspension from when the page was hidden, even if the signal arrives late", () => {
    const { doc, track, callbacks, tick } = setup()
    doc.set("hidden")
    tick(120_000)
    doc.set("visible")
    track.emit("mute") // the browser delivers the swallowed event on return
    expect(callbacks.onReturn).not.toHaveBeenCalled() // a mute may undo itself
    track.emit("unmute")
    expect(callbacks.onReturn.mock.calls[0][0].suspendedMs).toBeGreaterThanOrEqual(120_000)
  })

  it("an ended track on a visible page is reported back at once: it will not return by itself", () => {
    const { track, callbacks } = setup()
    track.emit("ended")
    expect(callbacks.onReturn).toHaveBeenCalledWith(expect.objectContaining({ reason: "track-ended" }))
  })

  it("an audio context that leaves running is a suspension, and running again hands back", () => {
    const { ctx, callbacks } = setup()
    ctx.set("interrupted")
    expect(callbacks.onSuspended).toHaveBeenCalledWith("audio-context")
    ctx.set("running")
    expect(callbacks.onReturn).toHaveBeenCalledTimes(1)
  })

  it("a closed audio context is not a suspension", () => {
    const { ctx, callbacks } = setup()
    ctx.set("closed")
    expect(callbacks.onSuspended).not.toHaveBeenCalled()
  })

  it("a socket close while hidden is a suspension; the return waits for the page", () => {
    const { doc, callbacks, watcher, tick } = setup()
    doc.set("hidden")
    tick(5_000)
    expect(watcher.socketClosed()).toBe(true)
    expect(callbacks.onReturn).not.toHaveBeenCalled()
    tick(5_000)
    doc.set("visible")
    expect(callbacks.onReturn).toHaveBeenCalledWith({ suspendedMs: 10_000, reason: "socket-closed" })
  })

  it("a socket close just after the page returned still counts: that is when the browser delivers it", () => {
    const { doc, watcher, tick, callbacks } = setup()
    doc.set("hidden")
    tick(10_000)
    doc.set("visible")
    tick(RETURN_GRACE_MS - 1)
    expect(watcher.socketClosed()).toBe(true)
    expect(callbacks.onReturn).toHaveBeenCalled()
  })

  it("a socket close on a page that was never away is an ordinary failure", () => {
    const { watcher, callbacks, tick } = setup()
    tick(RETURN_GRACE_MS * 10)
    expect(watcher.socketClosed()).toBe(false)
    expect(callbacks.onSuspended).not.toHaveBeenCalled()
  })

  it("reports a suspension once, and not again after clear() until a new sign", () => {
    const { track, callbacks, watcher } = setup()
    track.emit("mute")
    track.emit("mute")
    expect(callbacks.onSuspended).toHaveBeenCalledTimes(1)
    track.emit("unmute")
    watcher.clear()
    track.emit("mute")
    expect(callbacks.onSuspended).toHaveBeenCalledTimes(2)
  })

  it("stops listening when stopped", () => {
    const { doc, track, ctx, watcher } = setup()
    watcher.stop()
    expect(doc.count("visibilitychange")).toBe(0)
    expect(track.count("mute")).toBe(0)
    expect(ctx.count("statechange")).toBe(0)
  })
})

describe("installMediaSession", () => {
  function fakeSession() {
    const handlers = new Map<string, (() => void) | null>()
    const session: MediaSessionLike = { metadata: null, playbackState: "none", setActionHandler: (a, h) => { handlers.set(a, h) } }
    return { session, handlers }
  }

  const actions = () => ({ onStop: vi.fn(), onPause: vi.fn(), onPlay: vi.fn() })

  it("shows voice mode as on and routes stop, pause and play to their own actions", () => {
    const { session, handlers } = fakeSession()
    const a = actions()
    installMediaSession(session, a, () => ({ title: "Voice mode is on" }))
    expect(session.metadata).toEqual({ title: "Voice mode is on" })
    expect(session.playbackState).toBe("playing")
    handlers.get("stop")?.()
    handlers.get("pause")?.()
    handlers.get("play")?.()
    expect([a.onStop.mock.calls.length, a.onPause.mock.calls.length, a.onPlay.mock.calls.length]).toEqual([1, 1, 1])
  })

  it("keeps the playback state current, so the headset button sends play once paused", () => {
    const { session } = fakeSession()
    const media = installMediaSession(session, actions(), () => ({}))
    media.setPlaying(false)
    expect(session.playbackState).toBe("paused")
    media.setPlaying(true)
    expect(session.playbackState).toBe("playing")
  })

  it("takes the handlers down again", () => {
    const { session, handlers } = fakeSession()
    installMediaSession(session, actions(), () => ({})).remove()
    expect(handlers.get("stop")).toBeNull()
    expect(session.metadata).toBeNull()
  })

  it("does nothing where the browser has no media session", () => {
    expect(() => { const m = installMediaSession(undefined, actions(), () => ({})); m.setPlaying(false); m.remove() }).not.toThrow()
  })
})
