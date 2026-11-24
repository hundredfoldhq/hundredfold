import { describe, expect, it, vi } from "vitest"
import { ScreenWakeLock, type WakeLockSentinelLike } from "../wake-lock"

class FakeSentinel implements WakeLockSentinelLike {
  released = false
  private listeners: Array<() => void> = []
  release = vi.fn(async () => { this.released = true })
  addEventListener(_type: "release", l: () => void) { this.listeners.push(l) }
  /** The browser drops the lock, e.g. because the page hid. */
  drop() { this.released = true; for (const l of this.listeners) l() }
}

class FakeDocument {
  visibilityState = "visible"
  private listeners = new Set<() => void>()
  addEventListener(_type: "visibilitychange", l: () => void) { this.listeners.add(l) }
  removeEventListener(_type: "visibilitychange", l: () => void) { this.listeners.delete(l) }
  set(state: "visible" | "hidden") { this.visibilityState = state; for (const l of [...this.listeners]) l() }
  get listenerCount() { return this.listeners.size }
}

function setup() {
  const sentinels: FakeSentinel[] = []
  const api = { request: vi.fn(async (_type: "screen") => { const s = new FakeSentinel(); sentinels.push(s); return s }) }
  const doc = new FakeDocument()
  return { api, doc, sentinels, lock: new ScreenWakeLock(api, doc) }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("ScreenWakeLock", () => {
  it("asks for a screen lock while held", async () => {
    const { api, lock } = setup()
    lock.acquire()
    await settle()
    expect(api.request).toHaveBeenCalledWith("screen")
  })

  it("asks again when the page is visible again after the browser dropped the lock", async () => {
    const { api, doc, sentinels, lock } = setup()
    lock.acquire()
    await settle()
    doc.set("hidden")
    sentinels[0].drop()
    expect(api.request).toHaveBeenCalledTimes(1) // a hidden page cannot get one
    doc.set("visible")
    await settle()
    expect(api.request).toHaveBeenCalledTimes(2)
  })

  it("does not ask again while it still holds one", async () => {
    const { api, doc, lock } = setup()
    lock.acquire()
    await settle()
    doc.set("hidden")
    doc.set("visible")
    await settle()
    expect(api.request).toHaveBeenCalledTimes(1)
  })

  it("releases the lock and stops listening on release", async () => {
    const { api, doc, sentinels, lock } = setup()
    lock.acquire()
    await settle()
    lock.release()
    expect(sentinels[0].release).toHaveBeenCalled()
    expect(doc.listenerCount).toBe(0)
    doc.set("hidden")
    doc.set("visible")
    await settle()
    expect(api.request).toHaveBeenCalledTimes(1)
  })

  it("lets go of a lock that arrives after release", async () => {
    const { doc, lock } = setup()
    let grant!: (s: FakeSentinel) => void
    const late = new FakeSentinel()
    const pending = new ScreenWakeLock({ request: () => new Promise<FakeSentinel>((resolve) => { grant = resolve }) }, doc)
    pending.acquire()
    pending.release()
    grant(late)
    await settle()
    expect(late.release).toHaveBeenCalled()
    lock.release()
  })

  it("carries on when the API is missing or refuses", async () => {
    const doc = new FakeDocument()
    expect(() => { const none = new ScreenWakeLock(undefined, doc); none.acquire(); none.release() }).not.toThrow()
    const refusing = new ScreenWakeLock({ request: () => Promise.reject(new DOMException("denied", "NotAllowedError")) }, doc)
    refusing.acquire()
    await settle()
    expect(() => refusing.release()).not.toThrow()
  })
})
