/**
 * The live view must end a turn showing what a reload shows. A turn the user did not type in
 * this pane (voice, the terminal, a background command's late result) reaches the transcript
 * through re-reads of the stored chat, which can land in the middle of the turn.
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

const FULL = "Hello! A gateway routes requests to the right service, and here it routes your AI organisation's work."
const TRUNCATED = "Hello! A gateway routes requests to the right service, and here it routes your A"

beforeEach(() => {
  getSession.mockReset()
  __clearLiveSessionSnapshotCacheForTests()
})

describe("a turn that ends after a mid-turn re-read", () => {
  it("does not keep the truncated streamed copy of the answer above the final reply", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [{ id: "u0", role: "user", content: "earlier", timestamp: 1 }, { id: "a0", role: "assistant", content: "ok", timestamp: 2 }] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()

    // The user spoke: the turn starts with no send from this pane.
    act(() => { emit("session:started", { sessionId: "s1" }) })
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: TRUNCATED }) })

    // The voice sync re-reads the chat while the answer is still streaming: the stored
    // partial row holds the text streamed so far.
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "u0", role: "user", content: "earlier", timestamp: 1 },
        { id: "a0", role: "assistant", content: "ok", timestamp: 2 },
        { id: "u1", role: "user", content: "Hello! What does a gateway do?", timestamp: 3 },
        { id: "p1", role: "assistant", content: TRUNCATED, timestamp: 4, partial: true },
      ],
    })
    await act(async () => { await result.current.reload("s1") })

    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: FULL.slice(TRUNCATED.length) }) })
    await act(async () => { emit("session:completed", { sessionId: "s1", result: FULL }); await Promise.resolve() })

    expect(result.current.messages.map((m) => m.content)).toEqual(["earlier", "ok", "Hello! What does a gateway do?", FULL])

    // The stored chat after the turn: the partial row is gone, the final reply stands.
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "u0", role: "user", content: "earlier", timestamp: 1 },
        { id: "a0", role: "assistant", content: "ok", timestamp: 2 },
        { id: "u1", role: "user", content: "Hello! What does a gateway do?", timestamp: 3 },
        { id: "f1", role: "assistant", content: FULL, timestamp: 5 },
      ],
    })
    await act(async () => { await result.current.reload("s1") })
    expect(result.current.messages.map((m) => m.content)).toEqual(["earlier", "ok", "Hello! What does a gateway do?", FULL])
  })

  it("still keeps interim prose that a tool call followed", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()
    act(() => { emit("session:started", { sessionId: "s1" }) })
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "u1", role: "user", content: "do it", timestamp: 1 },
        { id: "p1", role: "assistant", content: "Checking first.", timestamp: 2, partial: true },
        { id: "p2", role: "assistant", content: "Using Bash", timestamp: 3, partial: true, toolCall: "Bash" },
        { id: "p3", role: "assistant", content: "All good", timestamp: 4, partial: true },
      ],
    })
    await act(async () => { await result.current.reload("s1") })
    await act(async () => { emit("session:completed", { sessionId: "s1", result: "All good, nothing to fix." }); await Promise.resolve() })
    expect(result.current.messages.map((m) => m.content)).toEqual(["do it", "Checking first.", "Used Bash", "All good, nothing to fix."])
  })

  it("drops the streamed prefix when only a sub-agent's tool call was stored after it", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()
    act(() => { emit("session:started", { sessionId: "s1" }) })
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "u1", role: "user", content: "q?", timestamp: 1 },
        { id: "p1", role: "assistant", content: "Hello world, this is", timestamp: 2, partial: true },
        { id: "p2", role: "assistant", content: "Using Task", timestamp: 3, partial: true, toolCall: "Task", meta: { sidechain: true } },
      ],
    })
    await act(async () => { await result.current.reload("s1") })
    await act(async () => { emit("session:completed", { sessionId: "s1", result: "Hello world, this is the full answer." }); await Promise.resolve() })
    expect(result.current.messages.map((m) => m.content)).toEqual(["q?", "Used Task", "Hello world, this is the full answer."])
  })

  describe("the stored copy of the text still streaming", () => {
    const U = { id: "u1", role: "user", content: "q?", timestamp: 1 }
    const rows = (r: { current: { messages: Array<{ content: string; toolCall?: string }> } }) =>
      r.current.messages.map((m) => (m.toolCall ? `[tool] ${m.content}` : m.content))

    async function midTurn() {
      getSession.mockResolvedValue({ status: "idle", messages: [] })
      const bus = makeBus()
      const { result } = renderHook(() => useLiveSession("s1", { subscribe: bus.subscribe }))
      await settle()
      act(() => { bus.emit("session:started", { sessionId: "s1" }) })
      return { ...bus, result }
    }

    it("is replaced by the full text when a main-thread tool call ends the block", async () => {
      const { emit, result } = await midTurn()
      act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "Let me check the fi" }) })
      getSession.mockResolvedValue({ status: "running", messages: [U, { id: "p1", role: "assistant", content: "Let me check the fi", timestamp: 2, partial: true }] })
      await act(async () => { await result.current.reload("s1") })
      act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "le first." }) })
      act(() => { emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "Bash", toolId: "t1" }) })
      act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "All fine." }) })
      await act(async () => { emit("session:completed", { sessionId: "s1", result: "All fine." }); await Promise.resolve() })
      expect(rows(result)).toEqual(["q?", "Let me check the file first.", "[tool] Used Bash", "All fine."])
    })

    it("is dropped at completion when a notification landed after it", async () => {
      const { emit, result } = await midTurn()
      getSession.mockResolvedValue({ status: "running", messages: [U, { id: "p1", role: "assistant", content: "Hello wor", timestamp: 2, partial: true }] })
      await act(async () => { await result.current.reload("s1") })
      act(() => { emit("session:notification", { sessionId: "s1", message: "Background work finished", messageId: "n1" }) })
      await act(async () => { emit("session:completed", { sessionId: "s1", result: "Hello world." }); await Promise.resolve() })
      expect(rows(result)).toEqual(["q?", "Background work finished", "Hello world."])
    })

    it("is kept when the final reply does not start with it", async () => {
      const { emit, result } = await midTurn()
      getSession.mockResolvedValue({ status: "running", messages: [U, { id: "p1", role: "assistant", content: "Draft wording", timestamp: 2, partial: true }] })
      await act(async () => { await result.current.reload("s1") })
      await act(async () => { emit("session:completed", { sessionId: "s1", result: "Reworded answer." }); await Promise.resolve() })
      expect(rows(result)).toEqual(["q?", "Draft wording", "Reworded answer."])
    })

    it("is only ever a partial row: settled prose at the end of the snapshot is kept", async () => {
      const { emit, result } = await midTurn()
      getSession.mockResolvedValue({ status: "running", messages: [U,
        { id: "p1", role: "assistant", content: "Using Read", timestamp: 2, partial: true, toolCall: "Read", meta: { sidechain: true } },
        { id: "a1", role: "assistant", content: "Hello wor", timestamp: 3 },
      ] })
      await act(async () => { await result.current.reload("s1") })
      await act(async () => { emit("session:completed", { sessionId: "s1", result: "Hello world." }); await Promise.resolve() })
      expect(rows(result)).toEqual(["q?", "[tool] Used Read", "Hello wor", "Hello world."])
    })

    it("is final once a main-thread tool call ends the block, even with nothing streamed since", async () => {
      const { emit, result } = await midTurn()
      getSession.mockResolvedValue({ status: "running", messages: [U, { id: "p1", role: "assistant", content: "Checking", timestamp: 2, partial: true }] })
      await act(async () => { await result.current.reload("s1") })
      act(() => { emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "Bash", toolId: "t1" }) })
      await act(async () => { emit("session:completed", { sessionId: "s1", result: "Checking done." }); await Promise.resolve() })
      expect(rows(result)).toEqual(["q?", "Checking", "[tool] Used Bash", "Checking done."])
    })

    it("is only the last text block: earlier prose that a tool call ended is kept", async () => {
      const { emit, result } = await midTurn()
      getSession.mockResolvedValue({ status: "running", messages: [U,
        { id: "p1", role: "assistant", content: "All", timestamp: 2, partial: true },
        { id: "p2", role: "assistant", content: "Using Bash", timestamp: 3, partial: true, toolCall: "Bash" },
        { id: "p3", role: "assistant", content: "All good", timestamp: 4, partial: true },
        { id: "p4", role: "assistant", content: "Using Read", timestamp: 5, partial: true, toolCall: "Read", meta: { sidechain: true } },
      ] })
      await act(async () => { await result.current.reload("s1") })
      await act(async () => { emit("session:completed", { sessionId: "s1", result: "All good, done." }); await Promise.resolve() })
      expect(rows(result)).toEqual(["q?", "All", "[tool] Used Bash", "[tool] Used Read", "All good, done."])
    })
  })
})
