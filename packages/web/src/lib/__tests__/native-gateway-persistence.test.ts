import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HundredfoldNativeBridge, NativeResponsePayload } from "@/platform/native-bridge"
import { createNativeGatewayProfiles } from "../native-gateway-profiles"
import { restoreNativeGatewayRecord } from "../native-gateway-restore"
import { MemoryStorage, bridgeFixture, response } from "./native-gateway-fixtures"

const ALPHA = "http://127.0.0.1:7779"
const BETA = "http://127.0.0.1:7780"
const KEY = "hundredfold.native.gateway-profiles.v1"

/**
 * A WebView's localStorage: a write is readable at once but reaches disk later.
 * `kill()` is the OS ending the app before that happens: whatever was not
 * flushed is gone, and the next launch sees the last flushed state.
 */
class WebViewStorage extends MemoryStorage {
  readonly #disk: Map<string, string>
  constructor(disk = new Map<string, string>()) {
    super()
    this.#disk = new Map(disk)
    for (const [key, value] of disk) super.setItem(key, value)
  }
  flush() {
    for (let index = 0; index < this.length; index++) {
      const key = this.key(index)!
      this.#disk.set(key, this.getItem(key)!)
    }
  }
  kill(): WebViewStorage {
    return new WebViewStorage(this.#disk)
  }
}

/** A promise settled by hand, either way. */
function held<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** The shell's file: what a write has returned for is on disk. */
function shellFile() {
  const file: { record: string | null; writes: string[] } = { record: null, writes: [] }
  return {
    file,
    methods: {
      readWorkspaceState: vi.fn(async () => file.record),
      writeWorkspaceState: vi.fn(async ({ document }: { document: string }) => { file.record = document; file.writes.push(document) }),
    },
  }
}

function launch(bridge: HundredfoldNativeBridge, storage: Storage, durable = true) {
  return createNativeGatewayProfiles({
    bridge,
    storage,
    durable: durable && bridge.writeWorkspaceState ? (document) => bridge.writeWorkspaceState!({ document }) : undefined,
  })
}

async function pairTwo(bridge: HundredfoldNativeBridge, storage: Storage) {
  const first = launch(bridge, storage)
  const alpha = await first.pair(ALPHA, "a", { activate: true })
  const beta = await first.pair(BETA, "b")
  return { first, alpha, beta }
}

beforeEach(() => vi.restoreAllMocks())

describe("the active workspace survives the app being killed", () => {
  it("is lost when only the WebView's storage holds it (the defect)", async () => {
    const { bridge } = bridgeFixture()
    const webview = new WebViewStorage()
    const { first, alpha, beta } = await pairTwo(bridge, webview)
    webview.flush() // alpha active, both paired, all on disk
    await first.select(beta.id) // the selection the OS kills the app right after
    const relaunched = launch(bridge, webview.kill(), false)
    expect(relaunched.snapshot().activeId).toBe(alpha.id)
  })

  it("is kept when the shell holds a copy: select, kill, relaunch, again and again", async () => {
    const { bridge } = bridgeFixture()
    const shell = shellFile()
    Object.assign(bridge, shell.methods)
    let webview = new WebViewStorage()
    const { first, alpha, beta } = await pairTwo(bridge, webview)
    webview.flush()

    let current = first
    for (const target of [beta, alpha, beta, beta, alpha]) {
      await current.select(target.id)
      webview = webview.kill() // killed straight after the selection: the WebView flushed nothing
      await restoreNativeGatewayRecord(bridge, webview)
      current = launch(bridge, webview)
      expect(current.snapshot().activeId).toBe(target.id)
      expect(current.snapshot().profiles.map((profile) => profile.id)).toEqual([alpha.id, beta.id])
    }
  })

  it("does not show a selection as made until the shell has it on disk", async () => {
    const { bridge } = bridgeFixture()
    const write = held<void>()
    Object.assign(bridge, {
      readWorkspaceState: vi.fn(async () => null),
      writeWorkspaceState: vi.fn(() => write.promise),
    })
    const profiles = launch(bridge, new MemoryStorage())
    const listener = vi.fn()
    profiles.subscribe(listener)
    const pending = profiles.pair(ALPHA, "a", { activate: true })
    await vi.waitFor(() => expect(bridge.writeWorkspaceState).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 30))
    const before = listener.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(listener.mock.calls.length).toBe(before)
    write.resolve()
    await pending
    expect(listener.mock.calls.length).toBeGreaterThan(before)
    expect(profiles.snapshot().activeId).toBe("native:" + ALPHA)
  })

  it("does not hold a switch for a shell that never answers", async () => {
    vi.useFakeTimers()
    try {
      const { bridge } = bridgeFixture()
      Object.assign(bridge, {
        readWorkspaceState: vi.fn(async () => null),
        writeWorkspaceState: vi.fn(() => new Promise<void>(() => {})),
      })
      const profiles = launch(bridge, new MemoryStorage())
      const pending = profiles.pair(ALPHA, "a", { activate: true })
      await vi.advanceTimersByTimeAsync(10_000)
      await pending
      expect(profiles.snapshot().activeId).toBe("native:" + ALPHA)
    } finally {
      vi.useRealTimers()
    }
  })

  it("writes to the shell one at a time and in order, so a slow earlier write cannot land after a later one", async () => {
    const { bridge } = bridgeFixture()
    const landed: number[] = []
    const gates = [held<void>(), held<void>()]
    let started = 0
    Object.assign(bridge, {
      readWorkspaceState: vi.fn(async () => null),
      writeWorkspaceState: vi.fn(async ({ document }: { document: string }) => {
        await gates[started++]?.promise
        landed.push((JSON.parse(document) as { revision: number }).revision)
      }),
    })
    const profiles = launch(bridge, new MemoryStorage())
    const pairing = profiles.pair(ALPHA, "a", { activate: true })
    await vi.waitFor(() => expect(started).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(started).toBe(1) // the second record waits for the first
    gates[0]!.resolve()
    await vi.waitFor(() => expect(started).toBe(2))
    gates[1]!.resolve()
    await pairing
    expect(landed).toEqual([1, 2])
  })
})

describe("restoring at startup", () => {
  async function savedByShell() {
    const { bridge } = bridgeFixture()
    const shell = shellFile()
    Object.assign(bridge, shell.methods)
    const { first, alpha, beta } = await pairTwo(bridge, new MemoryStorage())
    await first.select(beta.id)
    return { bridge, shell, alpha, beta }
  }

  it("opens on the page's own record when the shell never answers", async () => {
    vi.useFakeTimers()
    try {
      const { bridge, alpha } = await savedByShell()
      Object.assign(bridge, { readWorkspaceState: vi.fn(() => new Promise<string | null>(() => {})) })
      const storage = new MemoryStorage()
      storage.setItem(KEY, JSON.stringify({ version: 1, revision: 1, activeId: alpha.id, profiles: [alpha] }))
      const restoring = restoreNativeGatewayRecord(bridge, storage, 2500)
      await vi.advanceTimersByTimeAsync(2500)
      await expect(restoring).resolves.toBe("page-copy")
      expect(launch(bridge, storage).snapshot().activeId).toBe(alpha.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it("opens on the page's own record when the shell's read fails", async () => {
    const { bridge, alpha } = await savedByShell()
    Object.assign(bridge, { readWorkspaceState: vi.fn(async () => { throw { code: "state-store" } }) })
    const storage = new MemoryStorage()
    storage.setItem(KEY, JSON.stringify({ version: 1, revision: 1, activeId: alpha.id, profiles: [alpha] }))
    await expect(restoreNativeGatewayRecord(bridge, storage)).resolves.toBe("page-copy")
    expect(launch(bridge, storage).snapshot().activeId).toBe(alpha.id)
  })

  it("keeps the page's record when it is newer than the shell's, and brings the shell up to date", async () => {
    const { bridge, shell, beta } = await savedByShell()
    const newer = JSON.parse(shell.file.record!) as { revision: number }
    const storage = new MemoryStorage()
    storage.setItem(KEY, JSON.stringify({ ...newer, revision: newer.revision + 5 }))
    shell.file.writes.length = 0
    await expect(restoreNativeGatewayRecord(bridge, storage)).resolves.toBe("page-copy")
    expect(shell.file.writes).toHaveLength(1)
    expect((JSON.parse(shell.file.record!) as { revision: number }).revision).toBe(newer.revision + 5)
    expect(launch(bridge, storage).snapshot().activeId).toBe(beta.id)
  })

  it("takes the shell's record into an empty WebView and into an older one", async () => {
    const { bridge, beta, alpha } = await savedByShell()
    const empty = new MemoryStorage()
    await expect(restoreNativeGatewayRecord(bridge, empty)).resolves.toBe("adopted")
    expect(launch(bridge, empty).snapshot().activeId).toBe(beta.id)

    const older = new MemoryStorage()
    older.setItem(KEY, JSON.stringify({ version: 1, revision: 1, activeId: alpha.id, profiles: [alpha] }))
    await expect(restoreNativeGatewayRecord(bridge, older)).resolves.toBe("adopted")
    expect(launch(bridge, older).snapshot().activeId).toBe(beta.id)
  })

  it("leaves a shell that has no workspace record alone", async () => {
    const { bridge } = bridgeFixture()
    const storage = new MemoryStorage()
    await expect(restoreNativeGatewayRecord(bridge, storage)).resolves.toBe("unavailable")
  })
})

describe("a slow or failed gateway check at startup", () => {
  it("never moves the selection: it stays on the gateway that was open, through repeated launches", async () => {
    const { bridge, requests } = bridgeFixture()
    const storage = new MemoryStorage()
    const { first, alpha, beta } = await pairTwo(bridge, storage)
    await first.select(beta.id)
    const recorded = storage.getItem(KEY)

    for (let launchNumber = 0; launchNumber < 4; launchNumber++) {
      const profiles = launch(bridge, storage, false)
      expect(profiles.snapshot().activeId).toBe(beta.id)
      const answer = held<NativeResponsePayload>()
      requests.mockImplementationOnce(() => answer.promise)
      const check = profiles.verifyActive()
      // Slow: while the check is in flight the selection is still the saved one.
      expect(profiles.snapshot()).toMatchObject({ activeId: beta.id, status: "checking" })
      if (launchNumber % 2 === 0) answer.reject(new TypeError("connection refused"))
      else answer.resolve(response({}, 503))
      await check
      // Failed: reported against the saved gateway, never a switch to the other one.
      expect(profiles.snapshot()).toMatchObject({ activeId: beta.id, status: "unreachable", failedProfileId: beta.id })
      expect(profiles.snapshot().activeId).not.toBe(alpha.id)
    }
    expect(storage.getItem(KEY)).toBe(recorded)
  })

  it("ignores a startup answer that arrives after the selection moved on", async () => {
    const { bridge, requests } = bridgeFixture()
    const storage = new MemoryStorage()
    const { alpha, beta } = await pairTwo(bridge, storage)

    const profiles = launch(bridge, storage, false)
    expect(profiles.snapshot().activeId).toBe(alpha.id)
    const slow = held<NativeResponsePayload>()
    requests.mockImplementationOnce(() => slow.promise)
    const check = profiles.verifyActive() // asks alpha
    await profiles.select(beta.id)
    expect(profiles.snapshot()).toMatchObject({ activeId: beta.id, status: "ready", activeReachable: true })
    slow.reject(new TypeError("connection refused"))
    await check
    // The late failure was about alpha. It says nothing about beta.
    expect(profiles.snapshot()).toMatchObject({ activeId: beta.id, status: "ready", failedProfileId: undefined, activeReachable: true })
  })

  it("does not rewrite the saved record just by loading it, so an unreadable record is not replaced by an empty one", async () => {
    const { bridge } = bridgeFixture()
    const storage = new MemoryStorage()
    const { alpha } = await pairTwo(bridge, storage)
    const recorded = storage.getItem(KEY)
    const setItem = vi.spyOn(storage, "setItem")
    const failing = vi.spyOn(storage, "getItem").mockImplementation(() => { throw new Error("storage unavailable") })
    const profiles = launch(bridge, storage, false)
    expect(profiles.snapshot().profiles).toEqual([])
    failing.mockRestore()
    expect(setItem).not.toHaveBeenCalled()
    expect(storage.getItem(KEY)).toBe(recorded)
    expect(launch(bridge, storage, false).snapshot().activeId).toBe(alpha.id)
  })
})

describe("a fallback is deliberate and visible", () => {
  it("says so at startup when the saved workspace is no longer paired, and does not pick another", async () => {
    const { bridge } = bridgeFixture()
    const storage = new MemoryStorage()
    const { beta } = await pairTwo(bridge, storage)
    const record = JSON.parse(storage.getItem(KEY)!) as { activeId: string }
    storage.setItem(KEY, JSON.stringify({ ...record, activeId: "native:http://127.0.0.1:9999" }))

    const profiles = launch(bridge, storage, false)
    expect(profiles.snapshot().activeId).toBeUndefined()
    expect(profiles.snapshot().notice).toMatch(/no longer paired/i)
    expect(profiles.snapshot().profiles.map((profile) => profile.id)).toContain(beta.id)
    await profiles.select(beta.id)
    expect(profiles.snapshot()).toMatchObject({ activeId: beta.id, notice: undefined })
  })

  it("names both workspaces when removing the one in use moves the app to another", async () => {
    const { bridge } = bridgeFixture()
    const { first, alpha, beta } = await pairTwo(bridge, new MemoryStorage())
    await first.remove(alpha.id)
    expect(first.snapshot().activeId).toBe(beta.id)
    expect(first.snapshot().notice).toBe(`Switched to ${beta.name} because ${alpha.name} was removed.`)
    first.dismissNotice()
    expect(first.snapshot().notice).toBeUndefined()
  })

  it("says nothing when an inactive workspace is removed", async () => {
    const { bridge } = bridgeFixture()
    const { first, alpha, beta } = await pairTwo(bridge, new MemoryStorage())
    await first.remove(beta.id)
    expect(first.snapshot()).toMatchObject({ activeId: alpha.id, notice: undefined })
  })
})
