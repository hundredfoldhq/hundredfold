/**
 * A tool call's card is built from the stream and from a re-read of the stored chat, and both
 * must give the same card: the input the call was made with, what it returned and whether it failed.
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
import { toolDetailOf } from "@/lib/tool-summary"
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

beforeEach(() => {
  getSession.mockReset()
  __clearLiveSessionSnapshotCacheForTests()
})

async function midTurn() {
  getSession.mockResolvedValue({ status: "idle", messages: [] })
  const bus = makeBus()
  const { result } = renderHook(() => useLiveSession("s1", { subscribe: bus.subscribe }))
  await settle()
  act(() => { bus.emit("session:started", { sessionId: "s1" }) })
  return { ...bus, result }
}

const tool = (result: { current: { messages: Array<{ toolCall?: string; content: string; meta?: Record<string, unknown> }> } }, name: string) => {
  const row = result.current.messages.find((m) => m.toolCall === name)
  return { row, detail: row ? toolDetailOf(row) : undefined }
}

describe("a live tool call's detail", () => {
  it("takes the input with the call and the output and failure with its result", async () => {
    const { emit, result } = await midTurn()
    act(() => { emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "Bash", toolId: "t1", toolDetail: { input: { command: "ls" } } }) })
    expect(tool(result, "Bash").detail).toEqual({ input: { command: "ls" } })
    expect(tool(result, "Bash").row?.content).toBe("Using Bash")

    act(() => { emit("session:delta", { sessionId: "s1", type: "tool_result", toolName: "Bash", toolId: "t1", toolDetail: { output: "exit 2", isError: true } }) })
    expect(tool(result, "Bash").row?.content).toBe("Used Bash")
    expect(tool(result, "Bash").detail).toEqual({ input: { command: "ls" }, output: "exit 2", isError: true })
  })

  it("adds the input an update brings to the call it names, and ignores one for a call it never saw", async () => {
    const { emit, result } = await midTurn()
    act(() => { emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "Read", toolId: "t1" }) })
    expect(tool(result, "Read").detail).toBeUndefined()

    act(() => { emit("session:delta", { sessionId: "s1", type: "tool_update", toolName: "Read", toolId: "t-other", toolDetail: { input: { file_path: "/nope" } } }) })
    expect(tool(result, "Read").detail).toBeUndefined()
    act(() => { emit("session:delta", { sessionId: "s1", type: "tool_update", toolName: "Read", toolId: "t1", toolDetail: { input: { file_path: "/a.ts" } } }) })
    expect(tool(result, "Read").detail).toEqual({ input: { file_path: "/a.ts" } })
    expect(result.current.messages.filter((m) => m.toolCall)).toHaveLength(1)
  })

  it("draws the same detail from a stored row as from the stream, and still loads a row with none", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "u1", role: "user", content: "go", timestamp: 1 },
        { id: "t1", role: "assistant", content: "Used Bash", timestamp: 2, toolCall: "Bash", toolId: "c1", meta: { tool: { input: { command: "ls" }, output: "a" } } },
        { id: "t2", role: "assistant", content: "Used Read", timestamp: 3, toolCall: "Read", toolId: "c2" },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()
    expect(tool(result, "Bash").detail).toEqual({ input: { command: "ls" }, output: "a" })
    expect(tool(result, "Read").detail).toBeUndefined()
  })
})
