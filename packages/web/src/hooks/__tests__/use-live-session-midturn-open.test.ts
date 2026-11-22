/**
 * Opening a chat in the middle of a turn. The first read carries the stored partial row of the
 * text still streaming ("Let me check the fi"); the live deltas that follow carry only the tail
 * ("le first."). The live view must end up with the one row a reload shows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

const getSession = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    getSession: (id: string, options?: unknown) => getSession(id, options),
    getSessionMessages: vi.fn(),
  },
}))

import { __clearLiveSessionSnapshotCacheForTests, useLiveSession } from "../use-live-session"
import type { GatewayEvent, GatewayEventListener } from "@hundredfold/gateway-events"

function makeBus() {
  let listener: GatewayEventListener | null = null
  const subscribe = (fn: GatewayEventListener) => {
    listener = fn
    return () => { listener = null }
  }
  const emit = (event: string, payload: unknown) => listener?.({ event, payload } as GatewayEvent)
  return { subscribe, emit }
}

const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

const user = { id: "u1", role: "user", content: "look at the repo", timestamp: 1 }
const partial = { id: "p1", role: "assistant", content: "Let me check the fi", timestamp: 2, partial: true }

const proseRows = (rows: { role: string; content: string; toolCall?: string }[]) =>
  rows.filter((m) => m.role === "assistant" && !m.toolCall).map((m) => m.content)

beforeEach(() => {
  getSession.mockReset()
  __clearLiveSessionSnapshotCacheForTests()
})

describe("a chat opened mid-turn", () => {
  it("holds the stored partial and the streamed tail as one prose row after a tool call and completion", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()

    // Before any delta the stored row is shown as it is.
    expect(proseRows(result.current.messages)).toEqual(["Let me check the fi"])

    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "le first." }) })
    // While streaming, the text is in one place only: the bubble carries all of it.
    expect(result.current.streamingText).toBe("Let me check the file first.")
    expect(proseRows(result.current.messages)).toEqual([])

    act(() => { emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using Read", toolName: "Read" }) })
    expect(result.current.streamingText).toBe("")
    expect(proseRows(result.current.messages)).toEqual(["Let me check the file first."])

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })
    expect(proseRows(result.current.messages)).toEqual(["Let me check the file first.", "Done."])
  })

  it("ends a turn with no tool call on the final reply alone", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()

    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "le first." }) })
    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Let me check the file first." })
      await Promise.resolve()
    })
    expect(proseRows(result.current.messages)).toEqual(["Let me check the file first."])
  })

  it("keeps the stored row when a tool call follows with no text streamed in between", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()

    act(() => { emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using Read", toolName: "Read" }) })
    // The tool call ended the block: the stored text is final, and the next block starts fresh.
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "Next block." }) })
    expect(result.current.streamingText).toBe("Next block.")
    expect(proseRows(result.current.messages)).toEqual(["Let me check the fi"])
  })

  it("lets an authoritative snapshot replace the stored partial", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()

    act(() => { emit("session:delta", { sessionId: "s1", type: "text_snapshot", content: "Let me check the file first." }) })
    expect(result.current.streamingText).toBe("Let me check the file first.")
    expect(proseRows(result.current.messages)).toEqual([])
  })

  it("leaves the stored row alone when the partial is not the tail of the turn", async () => {
    // A tool row after the prose means the text block ended; the live text is a new block.
    getSession.mockResolvedValue({
      status: "running",
      messages: [user, partial, { id: "t1", role: "assistant", content: "Using Read", timestamp: 3, partial: true, toolCall: "Read" }],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()

    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "le first." }) })
    expect(result.current.streamingText).toBe("le first.")
    expect(proseRows(result.current.messages)).toEqual(["Let me check the fi"])
  })

  it("does not seed from a stored row of a session at rest", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [user, { ...partial, partial: undefined }] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()

    act(() => { emit("session:started", { sessionId: "s1" }) })
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "A new turn." }) })
    expect(result.current.streamingText).toBe("A new turn.")
    expect(proseRows(result.current.messages)).toEqual(["Let me check the fi"])
  })

  it("joins the text when the frames land in the same act as the first read", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    // No settle: the read resolves and the frames arrive before React has rendered its result.
    await act(async () => {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      emit("session:delta", { sessionId: "s1", type: "text", content: "le first." })
    })
    expect(result.current.streamingText).toBe("Let me check the file first.")
    expect(proseRows(result.current.messages)).toEqual([])

    act(() => { emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using Read", toolName: "Read" }) })
    expect(proseRows(result.current.messages)).toEqual(["Let me check the file first."])
  })

  it("joins the text when a reload of a mounted view is followed by a delta in the same act", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [user] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()

    getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
    await act(async () => {
      await result.current.reload("s1")
      emit("session:delta", { sessionId: "s1", type: "text", content: "le first." })
    })
    expect(result.current.streamingText).toBe("Let me check the file first.")
    expect(proseRows(result.current.messages)).toEqual([])
  })

  it("takes the text of the fresh read, not of a cached copy of the same row", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [user, { ...partial, content: "Let me" }] })
    const first = makeBus()
    const visit = renderHook(() => useLiveSession("s1", { subscribe: first.subscribe }))
    await settle()
    visit.unmount()

    // Back again: the cache shows the old row while the read returns the same row, grown.
    getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
    const second = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: second.subscribe }))
    await act(async () => {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      second.emit("session:delta", { sessionId: "s1", type: "text", content: "le first." })
    })
    expect(result.current.streamingText).toBe("Let me check the file first.")
    expect(proseRows(result.current.messages)).toEqual([])
  })

  it("seeds nothing from a stale read that the view discards for newer rows of its own", async () => {
    const tool = { id: "t1", role: "assistant", content: "Using Read", timestamp: 3, partial: true, toolCall: "Read" }
    const next = { id: "p3", role: "assistant", content: "Now", timestamp: 4, partial: true }
    getSession.mockResolvedValue({ status: "running", messages: [user, partial, tool, next] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()

    // A read that is older than what is shown: only the first partial row.
    getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
    await act(async () => { await result.current.reload("s1") })
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: " more" }) })
    expect(result.current.streamingText).toBe(" more")
    expect(proseRows(result.current.messages)).toEqual(["Let me check the fi", "Now"])
  })

  it("leaves the stored row and the buffer alone when live text of the block is already shown", async () => {
    // A reconnect read of a mounted view: the buffer already holds the block, the row is its copy.
    getSession.mockResolvedValue({ status: "idle", messages: [user] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()
    act(() => { emit("session:started", { sessionId: "s1" }) })
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "Let me check the fi" }) })

    getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
    await act(async () => { await result.current.reload("s1") })
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "le first." }) })
    // The buffer is the live text exactly: the stored copy is not put in front of it a second time.
    expect(result.current.streamingText).toBe("Let me check the file first.")
    expect(proseRows(result.current.messages)).toEqual(["Let me check the fi"])
  })

  it("keeps the joined row when a reload, its text and the tool call that ends it land in one act", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [user] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()

    getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
    await act(async () => {
      await result.current.reload("s1")
      emit("session:delta", { sessionId: "s1", type: "text", content: "le first." })
      emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using Read", toolName: "Read" })
    })
    expect(result.current.streamingText).toBe("")
    expect(proseRows(result.current.messages)).toEqual(["Let me check the file first."])
  })

  describe("a read that was out while a frame ended or extended the block seeds nothing", () => {
    const toolUse = { type: "tool_use", content: "Using Read", toolName: "Read" }
    const block = {
      type: "block",
      content: "Progress",
      block: { op: "put", block: { id: "plan", type: "task-list", version: 1, payload: {} } },
    }
    const cases: [string, [string, Record<string, unknown>][]][] = [
      ["a main tool call", [["session:delta", toolUse]]],
      ["a block", [["session:delta", block]]],
      ["text, then a tool call that flushes it", [["session:delta", { type: "text", content: "le first." }], ["session:delta", toolUse]]],
      ["a snapshot, then a tool call that flushes it", [["session:delta", { type: "text_snapshot", content: "Let me check the file first." }], ["session:delta", toolUse]]],
      ["a snapshot that empties the block", [["session:delta", { type: "text_snapshot", content: "" }]]],
      ["a new turn", [["session:started", {}]]],
      ["a stop", [["session:stopped", {}]]],
      ["an interruption", [["session:interrupted", {}]]],
    ]
    for (const timing of ["in the act the read lands in", "rendered before the read lands"] as const) {
      for (const [name, frames] of cases) {
        it(`${name}, ${timing}`, async () => {
          getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
          const { subscribe, emit } = makeBus()
          const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
          await settle()

          // The read starts before the frames and returns the old snapshot after them.
          let land!: (session: unknown) => void
          getSession.mockImplementationOnce(() => new Promise((resolve) => { land = resolve }))
          const reload = result.current.reload("s1")
          const send = () => { for (const [event, payload] of frames) emit(event, { sessionId: "s1", ...payload }) }
          if (timing === "rendered before the read lands") act(send)
          await act(async () => {
            if (timing === "in the act the read lands in") send()
            land({ status: "running", messages: [user, partial] })
            await reload
            emit("session:delta", { sessionId: "s1", type: "text", content: "Next block." })
          })
          expect(result.current.streamingText).toBe("Next block.")
          expect(proseRows(result.current.messages)).not.toContain("Let me check the fiNext block.")
          expect(proseRows(result.current.messages).some((row) => row.startsWith("Let me check the fi"))).toBe(true)
        })
      }
    }

    it("a completion, in the act the read lands in, with the read reissued after it", async () => {
      getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
      const { subscribe, emit } = makeBus()
      const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
      await settle()

      let land!: (session: unknown) => void
      getSession.mockImplementationOnce(() => new Promise((resolve) => { land = resolve }))
      const reload = result.current.reload("s1")
      await act(async () => {
        emit("session:completed", { sessionId: "s1", result: "Let me check the fi" })
        land({ status: "running", messages: [user, partial] })
        await reload
        emit("session:delta", { sessionId: "s1", type: "text", content: "Next block." })
      })
      expect(result.current.streamingText).toBe("Next block.")
    })
  })

  describe("the stored tail is not taken after the block or the turn has moved on", () => {
    const openMidTurn = async () => {
      getSession.mockResolvedValue({ status: "running", messages: [user, partial] })
      const bus = makeBus()
      const hook = renderHook(({ id }) => useLiveSession(id, { subscribe: bus.subscribe }), { initialProps: { id: "s1" } })
      await settle()
      return { ...bus, ...hook }
    }
    const expectFreshBlock = (result: { current: { streamingText: string; messages: { role: string; content: string; toolCall?: string }[] } }) => {
      expect(result.current.streamingText).toBe("Next block.")
      expect(proseRows(result.current.messages)).toContain("Let me check the fi")
    }

    it("when a new turn starts", async () => {
      const { emit, result } = await openMidTurn()
      act(() => { emit("session:started", { sessionId: "s1" }) })
      act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "Next block." }) })
      expectFreshBlock(result)
    })

    it("when a block ends the text block", async () => {
      const { emit, result } = await openMidTurn()
      act(() => {
        emit("session:delta", {
          sessionId: "s1",
          type: "block",
          content: "Progress",
          block: { op: "put", block: { id: "plan", type: "task-list", version: 1, payload: {} } },
        })
      })
      act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "Next block." }) })
      expectFreshBlock(result)
    })

    it("when the turn completes", async () => {
      const { emit, result } = await openMidTurn()
      getSession.mockResolvedValue({ status: "idle", messages: [user, { ...partial, partial: undefined }] })
      await act(async () => {
        emit("session:completed", { sessionId: "s1", result: "" })
        await Promise.resolve(); await Promise.resolve()
      })
      act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "Next block." }) })
      expectFreshBlock(result)
    })

    it("when a later read finds the session at rest", async () => {
      const { emit, result } = await openMidTurn()
      getSession.mockResolvedValue({ status: "idle", messages: [user, { ...partial, partial: undefined }] })
      await act(async () => { await result.current.reload("s1") })
      act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "Next block." }) })
      expectFreshBlock(result)
    })

    it("when the view moves to another chat that was shown at rest", async () => {
      const restingOther = { status: "idle", messages: [{ id: "u9", role: "user", content: "other", timestamp: 1 }, { id: "a9", role: "assistant", content: "Done.", timestamp: 2 }] }
      getSession.mockImplementation(async (id: string) => (id === "s2" ? restingOther : { status: "running", messages: [user, partial] }))
      const bus = makeBus()
      const { result, rerender } = renderHook(({ id }) => useLiveSession(id, { subscribe: bus.subscribe }), { initialProps: { id: "s2" } })
      await settle()
      rerender({ id: "s1" })
      await settle()
      rerender({ id: "s2" })
      await settle()
      act(() => { bus.emit("session:delta", { sessionId: "s2", type: "text", content: "Next block." }) })
      expect(result.current.streamingText).toBe("Next block.")
    })
  })
})
