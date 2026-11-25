/**
 * The model's reasoning arrives as `thinking` deltas and is stored as `thinking` rows. Live, on a
 * re-read, after switching away and back, and on a reload it must be the same rows: one per block,
 * in the order the model produced them, with no text twice and none lost.
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
import type { Message } from "@/lib/conversations"
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

const think = (emit: (e: string, p: unknown) => void, blockId: number, content: string, extra: object = {}) =>
  act(() => { emit("session:delta", { sessionId: "s1", type: "thinking", streamBlock: blockId, content, ...extra }) })

const shape = (messages: Message[]) => messages.map((m) => `${m.role}:${m.toolCall ?? m.content}`)

async function midTurn() {
  getSession.mockResolvedValue({ status: "idle", messages: [] })
  const bus = makeBus()
  const hook = renderHook(() => useLiveSession("s1", { subscribe: bus.subscribe }))
  await settle()
  act(() => { bus.emit("session:started", { sessionId: "s1" }) })
  return { ...bus, ...hook }
}

describe("live thinking deltas", () => {
  it("appends the chunks of one block to one row and opens a new row for a new block", async () => {
    const { emit, result } = await midTurn()
    think(emit, 1, "Let me ")
    think(emit, 1, "look at the file.")
    expect(shape(result.current.messages)).toEqual(["thinking:Let me look at the file."])

    think(emit, 2, "Now the tests.")
    expect(shape(result.current.messages)).toEqual(["thinking:Let me look at the file.", "thinking:Now the tests."])
  })

  it("keeps a thinking block's id apart from the text blocks around it", async () => {
    const { emit, result } = await midTurn()
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "Before.", streamBlock: 1, offset: 0 }) })
    think(emit, 2, "Reasoning.")
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "After.", streamBlock: 3, offset: 0 }) })
    expect(shape(result.current.messages)).toEqual(["assistant:Before.", "thinking:Reasoning."])
    expect(result.current.streamingText).toBe("After.")
  })

  it("puts the text already streamed into its own row ahead of the reasoning that follows it", async () => {
    const { emit, result } = await midTurn()
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "I will check." }) })
    expect(result.current.streamingText).toBe("I will check.")
    think(emit, 1, "Hmm, which file?")
    expect(result.current.streamingText).toBe("")
    expect(shape(result.current.messages)).toEqual(["assistant:I will check.", "thinking:Hmm, which file?"])

    // Text that comes after the reasoning streams below it.
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "Found it." }) })
    expect(result.current.streamingText).toBe("Found it.")
    expect(shape(result.current.messages)).toEqual(["assistant:I will check.", "thinking:Hmm, which file?"])
  })

  it("keeps reasoning between tool calls in stream order, and a block after a call is a new row", async () => {
    const { emit, result } = await midTurn()
    think(emit, 1, "first")
    act(() => { emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "Read", toolId: "t1" }) })
    think(emit, 1, " again")
    expect(shape(result.current.messages)).toEqual(["thinking:first", "assistant:Read", "thinking: again"])
  })

  it("ignores an empty chunk and a sub-agent's reasoning", async () => {
    const { emit, result } = await midTurn()
    think(emit, 1, "")
    think(emit, 2, "not mine", { sidechain: true })
    expect(result.current.messages).toEqual([])
  })

  it("does not show a reasoning chunk as the answer, and keeps the row once the turn completes", async () => {
    const { emit, result } = await midTurn()
    think(emit, 1, "Considering the request.")
    act(() => { emit("session:completed", { sessionId: "s1", result: "Done." }) })
    expect(shape(result.current.messages)).toEqual(["thinking:Considering the request.", "assistant:Done."])
    expect(result.current.messages[0].partial).toBeUndefined()
  })
})

describe("thinking rows read back from the gateway", () => {
  it("loads stored thinking rows as they are, in order beside the prose and tool rows", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "u1", role: "user", content: "go", timestamp: 1 },
        { id: "k1", role: "thinking", content: "Plan the change.", timestamp: 2 },
        { id: "a1", role: "assistant", content: "On it.", timestamp: 3 },
        { id: "t1", role: "assistant", content: "Used Read", timestamp: 4, toolCall: "Read" },
        { id: "k2", role: "thinking", content: "Looks fine.", timestamp: 5 },
        { id: "a2", role: "assistant", content: "Done.", timestamp: 6 },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()
    expect(shape(result.current.messages)).toEqual([
      "user:go", "thinking:Plan the change.", "assistant:On it.", "assistant:Read", "thinking:Looks fine.", "assistant:Done.",
    ])
  })

  it("is not a final response: a turn with reasoning and no answer is still pending", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "u1", role: "user", content: "go", timestamp: 1 },
        { id: "k1", role: "thinking", content: "Working it out.", timestamp: 2 },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await settle()
    expect(result.current.turnPending).toBe(true)
  })

  it("takes a re-read mid-turn without a second row: the stored copy keeps the live row's id, and the stream goes on into it", async () => {
    const { emit, result } = await midTurn()
    think(emit, 1, "Let me think")
    const liveId = result.current.messages[0].id

    // The gateway stored a little more than this view has seen (" about it"): its copy is ahead.
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "u1", role: "user", content: "go", timestamp: 1 },
        { id: "k1", role: "thinking", content: "Let me think about it", timestamp: 2, partial: true },
      ],
    })
    await act(async () => { await result.current.reload("s1") })
    expect(shape(result.current.messages.filter((m) => m.role === "thinking"))).toEqual(["thinking:Let me think about it"])
    expect(result.current.messages.find((m) => m.role === "thinking")?.id).toBe(liveId)

    // The stream then repeats the tail the read already had, and brings what is new.
    think(emit, 1, " about")
    think(emit, 1, " it, then")
    think(emit, 1, " act.")
    expect(shape(result.current.messages.filter((m) => m.role === "thinking"))).toEqual(["thinking:Let me think about it, then act."])
  })

  it("keeps the view's longer text when the stored copy lags the stream", async () => {
    const { emit, result } = await midTurn()
    think(emit, 1, "Let me think about it")
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "u1", role: "user", content: "go", timestamp: 1 },
        { id: "k1", role: "thinking", content: "Let me think", timestamp: 2, partial: true },
      ],
    })
    await act(async () => { await result.current.reload("s1") })
    think(emit, 1, " carefully")
    expect(shape(result.current.messages.filter((m) => m.role === "thinking"))).toEqual(["thinking:Let me think about it carefully"])
  })

  it("restores the same rows after switching away mid-stream and back, and the next chunk extends the block", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const first = makeBus()
    const hook = renderHook(() => useLiveSession("s1", { subscribe: first.subscribe }))
    await settle()
    act(() => { first.emit("session:started", { sessionId: "s1" }) })
    think(first.emit, 1, "Weighing the options")
    hook.unmount()

    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "u1", role: "user", content: "go", timestamp: 1 },
        { id: "k1", role: "thinking", content: "Weighing the options", timestamp: 2, partial: true },
      ],
    })
    const second = makeBus()
    const back = renderHook(() => useLiveSession("s1", { subscribe: second.subscribe }))
    await settle()
    expect(shape(back.result.current.messages.filter((m) => m.role === "thinking"))).toEqual(["thinking:Weighing the options"])

    think(second.emit, 1, " carefully")
    expect(shape(back.result.current.messages.filter((m) => m.role === "thinking"))).toEqual(["thinking:Weighing the options carefully"])
  })
})
