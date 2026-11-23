/**
 * Opening a chat in the middle of a turn. The gateway stores the text block being streamed only
 * every so often, stamps each text delta with its block and offset, and reports the block being
 * streamed (with all its text so far) on a read of a running session. Whenever the view mounts,
 * whenever the read is answered and whenever it lands, the view must show what a reload shows:
 * every block once and whole, and every tool call once.
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

import { __cacheLiveSessionSnapshotForTests, __clearLiveSessionSnapshotCacheForTests, useLiveSession } from "../use-live-session"
import type { GatewayEvent, GatewayEventListener } from "@hundredfold/gateway-events"

interface Row {
  id: string
  role: string
  content: string
  timestamp: number
  partial?: boolean
  toolCall?: string
  blocks?: unknown[]
}

/** The gateway's side of one running turn, as far as the live view can tell. */
class FakeGateway {
  rows: Row[] = [{ id: "u1", role: "user", content: "look at the repo", timestamp: 1 }]
  block = 100
  text = ""
  rowId: string | null = null
  // What a reload shows, in order: prose blocks and tool calls.
  done: string[] = []
  private n = 0
  listener: GatewayEventListener | null = null
  // Frames broadcast while muted never reach the view, as across a dropped connection.
  muted = false

  subscribe = (fn: GatewayEventListener) => {
    this.listener = fn
    return () => { if (this.listener === fn) this.listener = null }
  }

  emit(event: string, payload: Record<string, unknown>) {
    if (this.muted) return
    this.listener?.({ event, payload: { sessionId: "s1", ...payload } } as GatewayEvent)
  }

  word(content: string) {
    const offset = this.text.length
    this.text += content
    this.emit("session:delta", { type: "text", content, streamBlock: this.block, offset })
  }

  /** The debounced write of the block's text to its stored row. */
  flush() {
    if (!this.text.trim()) return
    const row = this.rowId ? this.rows.find((r) => r.id === this.rowId) : undefined
    if (row) {
      row.content = this.text
      return
    }
    this.rowId = `t${++this.n}`
    this.rows.push({ id: this.rowId, role: "assistant", content: this.text, timestamp: Date.now() + this.n, partial: true })
  }

  tool(name: string) {
    this.flush()
    this.rows.push({ id: `tool${++this.n}`, role: "assistant", content: `Using ${name}`, timestamp: Date.now() + this.n, partial: true, toolCall: name })
    this.emit("session:delta", { type: "tool_use", content: `Using ${name}`, toolName: name, streamBlock: this.block })
    if (this.text) this.done.push(this.text)
    this.done.push(`tool:${name}`)
    this.block += 1
    this.text = ""
    this.rowId = null
  }

  /** A block the gateway stores and sends outside the turn's stream: unstamped, and the text
   *  block goes on past it as the one row it is. */
  outOfBand(title: string) {
    const block = { id: `b${++this.n}`, type: "task-list", version: 1, payload: { title, items: [] } }
    this.rows.push({ id: `row-${block.id}`, role: "assistant", content: title, timestamp: Date.now() + this.n, blocks: [block] } as Row)
    this.emit("session:delta", { type: "block", content: title, block: { op: "put", block } })
  }

  complete() {
    this.emit("session:completed", { result: this.text })
  }

  read() {
    return {
      status: "running",
      messages: this.rows.map((r) => (r.id === this.rowId ? { ...r, content: this.text } : { ...r })),
      liveStream: { block: this.block, text: this.text, messageId: this.rowId },
    }
  }

  truth(): string[] {
    return this.text ? [...this.done, this.text] : [...this.done]
  }
}

type Step = ["w", string] | ["f"] | ["t", string]

const SCRIPT: Step[] = [
  ["w", "Let "], ["w", "me "], ["f"], ["w", "check "], ["w", "the "], ["w", "fi"], ["f"], ["w", "le "], ["w", "first."],
  ["t", "Read"],
  ["w", "It "], ["w", "says "], ["f"], ["w", "hello."],
  ["t", "Grep"],
  ["w", "Done"], ["w", "."],
]

function runStep(gateway: FakeGateway, step: Step) {
  if (step[0] === "w") gateway.word(step[1])
  else if (step[0] === "f") gateway.flush()
  else gateway.tool(step[1])
}

type View = { messages: { role: string; content: string; toolCall?: string }[]; streamingText: string }

/** The view as a reload would list it: assistant prose and tool calls, streaming text last. */
function shown(view: View): string[] {
  const rows = view.messages
    .filter((m) => m.role === "assistant")
    .map((m) => (m.toolCall ? `tool:${m.toolCall}` : m.content))
  return view.streamingText ? [...rows, view.streamingText] : rows
}

const settle = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }) }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Reads after the first are answered at once, with what the gateway holds when they are sent. */
function answerLaterReadsAtOnce(gateway: FakeGateway) {
  getSession.mockImplementation((_id: string, options?: { messages?: boolean }) =>
    Promise.resolve(options?.messages === false ? { status: "idle" } : gateway.read()))
}

function messageReads() {
  return getSession.mock.calls.filter(([, options]) => (options as { messages?: boolean } | undefined)?.messages !== false).length
}

beforeEach(() => {
  getSession.mockReset()
  __clearLiveSessionSnapshotCacheForTests()
})

describe("a chat opened mid-turn, against every mount, answer and landing point", () => {
  const cases: { mount: number; answer: number; land: number }[] = []
  for (let mount = 0; mount <= SCRIPT.length; mount += 1) {
    for (let land = mount; land <= SCRIPT.length; land += 1) {
      cases.push({ mount, answer: mount, land })
      if (land > mount) cases.push({ mount, answer: land, land })
    }
  }

  it.each(cases)("mounted before step $mount, read answered before step $answer, landing before step $land", async ({ mount, answer, land }) => {
    const gateway = new FakeGateway()
    for (let k = 0; k < mount; k += 1) runStep(gateway, SCRIPT[k])

    const first = deferred<unknown>()
    answerLaterReadsAtOnce(gateway)
    getSession.mockImplementationOnce(() => first.promise)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))

    let answered: unknown = null
    let landed = false
    const answerAndLand = async (k: number) => {
      if (k === answer) answered = gateway.read()
      if (k === land) {
        await act(async () => { first.resolve(answered) })
        await settle()
        landed = true
      }
    }

    for (let k = mount; k < SCRIPT.length; k += 1) {
      await answerAndLand(k)
      const step = SCRIPT[k]
      act(() => { runStep(gateway, step) })
      await settle()
      // Once every read is in, each word and each tool call leaves the view as a reload shows it.
      if (landed && step[0] !== "f") expect(shown(result.current)).toEqual(gateway.truth())
    }
    await answerAndLand(SCRIPT.length)
    expect(shown(result.current)).toEqual(gateway.truth())

    const final = gateway.text
    await act(async () => { gateway.complete() })
    await settle()
    expect(shown(result.current)).toEqual([...gateway.done, final])
  })
})

describe("principal QA probes, against a gateway that stamps its deltas", () => {
  it("a word lands while the first read is out", async () => {
    const gateway = new FakeGateway()
    for (const word of ["Let ", "me ", "check ", "the ", "fi"]) gateway.word(word)
    gateway.flush()
    const first = deferred<unknown>()
    answerLaterReadsAtOnce(gateway)
    getSession.mockImplementationOnce(() => first.promise)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    const answered = gateway.read()

    act(() => { gateway.word("le") })
    await act(async () => { first.resolve(answered) })
    await settle()
    act(() => { gateway.word(" first.") })
    expect(result.current.streamingText).toBe("Let me check the file first.")
    act(() => { gateway.tool("Read") })
    expect(shown(result.current)).toEqual(["Let me check the file first.", "tool:Read"])
  })

  it("words streamed between the last store and the mount come from the read", async () => {
    const gateway = new FakeGateway()
    for (const word of ["Let ", "me ", "check ", "the ", "fi"]) gateway.word(word)
    gateway.flush()
    gateway.word("le") // broadcast before the view existed, and not stored yet
    answerLaterReadsAtOnce(gateway)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()

    act(() => { gateway.word(" first.") })
    act(() => { gateway.tool("Read") })
    expect(shown(result.current)).toEqual(["Let me check the file first.", "tool:Read"])
  })
})

describe("reads overtaken by the turn", () => {
  it("reads again when a tool call lands while the read is out, and applies the fresh read", async () => {
    const gateway = new FakeGateway()
    gateway.word("Looking ")
    gateway.flush()
    const first = deferred<unknown>()
    answerLaterReadsAtOnce(gateway)
    getSession.mockImplementationOnce(() => first.promise)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    const answered = gateway.read()

    act(() => { gateway.word("now.") })
    act(() => { gateway.tool("Read") })
    await act(async () => { first.resolve(answered) })
    await settle()

    expect(messageReads()).toBe(2)
    expect(shown(result.current)).toEqual(["Looking now.", "tool:Read"])
  })

  it("reads again when a block lands while the read is out", async () => {
    const gateway = new FakeGateway()
    gateway.word("Hello")
    gateway.flush()
    const first = deferred<unknown>()
    answerLaterReadsAtOnce(gateway)
    getSession.mockImplementationOnce(() => first.promise)
    renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    const answered = gateway.read()

    act(() => {
      gateway.emit("session:delta", {
        type: "block",
        block: { op: "put", block: { id: "b1", type: "task-list", version: 1, payload: { items: [] } } },
        streamBlock: gateway.block,
      })
    })
    await act(async () => { first.resolve(answered) })
    await settle()
    expect(messageReads()).toBe(2)
  })

  it("does not read again for a sub-agent's tool call", async () => {
    const gateway = new FakeGateway()
    const first = deferred<unknown>()
    answerLaterReadsAtOnce(gateway)
    getSession.mockImplementationOnce(() => first.promise)
    renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    const answered = gateway.read()
    act(() => { gateway.emit("session:delta", { type: "tool_use", toolName: "Grep", content: "Using Grep", sidechain: true }) })
    await act(async () => { first.resolve(answered) })
    await settle()
    expect(messageReads()).toBe(1)
  })

  it("reads again at most twice, then applies the read it has", async () => {
    const gateway = new FakeGateway()
    gateway.word("Step one")
    gateway.flush()
    // Every read is answered while a block streams and overtaken by the tool call that ends it.
    let n = 0
    getSession.mockImplementation((_id: string, options?: { messages?: boolean }) => {
      if (options?.messages === false) return Promise.resolve({ status: "idle" })
      gateway.word(` w${++n}`)
      const answered = gateway.read()
      return new Promise((resolve) => {
        queueMicrotask(() => {
          act(() => { gateway.tool("Read") })
          resolve(answered)
        })
      })
    })
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()
    await settle()
    expect(messageReads()).toBe(3)
    // The last read reports a block the view has seen end: it is not streamed again, so the next
    // block's text starts clean.
    expect(result.current.streamingText).toBe("")
    act(() => { gateway.word("Next") })
    expect(result.current.streamingText).toBe("Next")
  })

  it("does not read again for a session the read finds at rest", async () => {
    const gateway = new FakeGateway()
    const first = deferred<unknown>()
    answerLaterReadsAtOnce(gateway)
    getSession.mockImplementationOnce(() => first.promise)
    renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    act(() => { gateway.tool("Read") })
    await act(async () => { first.resolve({ status: "idle", messages: gateway.rows }) })
    await settle()
    expect(messageReads()).toBe(1)
  })
})

describe("joining a read to the stream", () => {
  it("reads once for the head of a block the view is missing, and joins to that read", async () => {
    const gateway = new FakeGateway()
    answerLaterReadsAtOnce(gateway)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()
    expect(messageReads()).toBe(1)
    gateway.muted = true
    gateway.word("The answer ")
    gateway.flush()
    gateway.muted = false
    act(() => { gateway.word("is 42.") })
    await settle()
    expect(messageReads()).toBe(2)
    expect(shown(result.current)).toEqual(["The answer is 42."])
    act(() => { gateway.word(" Done.") })
    await settle()
    expect(messageReads()).toBe(2)
    expect(shown(result.current)).toEqual(["The answer is 42. Done."])
  })

  it("reads once per block even when that read cannot fill the gap", async () => {
    const gateway = new FakeGateway()
    answerLaterReadsAtOnce(gateway)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()
    gateway.muted = true
    gateway.word("Missed ")
    gateway.muted = false
    // The gap read is answered with a read from before the missed words.
    getSession.mockResolvedValueOnce({ status: "running", messages: gateway.rows.map((r) => ({ ...r })), liveStream: { block: gateway.block, text: "", messageId: null } })
    act(() => { gateway.word("seen") })
    await settle()
    act(() => { gateway.word(" too") })
    await settle()
    expect(messageReads()).toBe(2)
    // Nothing is glued across the gap: the view shows what it received.
    expect(shown(result.current)).toEqual(["seen too"])
  })

  it("changes nothing for a read reporting a block the view has seen end", async () => {
    const gateway = new FakeGateway()
    answerLaterReadsAtOnce(gateway)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()
    act(() => { gateway.word("First block.") })
    const stale = gateway.read()
    act(() => { gateway.tool("Read") })
    gateway.muted = true
    gateway.word("Sec")
    gateway.muted = false
    // The gap read for the second block is answered with the first block still streaming.
    getSession.mockResolvedValueOnce(stale)
    act(() => { gateway.word("ond") })
    await settle()
    act(() => { gateway.word(" block.") })
    await settle()
    expect(result.current.streamingText).toBe("ond block.")
    expect(shown(result.current).filter((r) => r.includes("First block.")).length).toBeLessThanOrEqual(1)
  })

  it("lets a snapshot of the block replace the read's stored row of it", async () => {
    const gateway = new FakeGateway()
    gateway.word("draft with a secret")
    gateway.flush()
    answerLaterReadsAtOnce(gateway)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()
    expect(shown(result.current)).toEqual(["draft with a secret"])
    act(() => {
      gateway.emit("session:delta", { type: "text_snapshot", content: "draft with a [redacted]", streamBlock: gateway.block, offset: 0 })
    })
    expect(shown(result.current)).toEqual(["draft with a [redacted]"])
  })

  it("streams on past a block sent out of band, as the gateway keeps the text block whole", async () => {
    const gateway = new FakeGateway()
    answerLaterReadsAtOnce(gateway)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()
    act(() => { gateway.word("Before ") })
    act(() => { gateway.outOfBand("Tasks") })
    act(() => { gateway.word("and after.") })
    expect(result.current.streamingText).toBe("Before and after.")
    act(() => { gateway.tool("Read") })
    expect(shown(result.current)).toEqual(["Tasks", "Before and after.", "tool:Read"])
  })

  it("joins a read sent again after a block out of band to the whole text block", async () => {
    const gateway = new FakeGateway()
    gateway.word("Head of the block ")
    gateway.flush()
    const first = deferred<unknown>()
    answerLaterReadsAtOnce(gateway)
    getSession.mockImplementationOnce(() => first.promise)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    const answered = gateway.read()
    act(() => { gateway.word("tail one") })
    act(() => { gateway.outOfBand("Tasks") })
    act(() => { gateway.word(" tail two") })
    await act(async () => { first.resolve(answered) })
    await settle()
    expect(messageReads()).toBe(2)
    expect(shown(result.current)).toEqual(["Tasks", "Head of the block tail one tail two"])
  })

  it("still splits text the gateway did not stamp at a block", async () => {
    const gateway = new FakeGateway()
    answerLaterReadsAtOnce(gateway)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()
    act(() => { gateway.emit("session:delta", { type: "text", content: "Before" }) })
    act(() => { gateway.outOfBand("Tasks") })
    expect(result.current.streamingText).toBe("")
    expect(shown(result.current)).toEqual(["Before", "Tasks"])
  })

  it("joins reads again in a turn after the gateway restarted and its block ids began again", async () => {
    const gateway = new FakeGateway()
    gateway.block = 1
    answerLaterReadsAtOnce(gateway)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()
    // The old turn's block 1 ends, after a gap in it was read for.
    gateway.muted = true
    gateway.word("Old ")
    gateway.muted = false
    act(() => { gateway.word("turn.") })
    await settle()
    expect(messageReads()).toBe(2)
    act(() => { gateway.tool("Read") })
    await act(async () => { gateway.complete() })
    await settle()
    // A new gateway process: its blocks are numbered from the start.
    gateway.block = 1
    act(() => { gateway.emit("session:started", {}) })
    gateway.muted = true
    gateway.word("Hello ")
    gateway.flush()
    gateway.muted = false
    act(() => { gateway.word("there") })
    await settle()
    expect(messageReads()).toBe(3)
    expect(result.current.streamingText).toBe("Hello there")
  })

  it("reads again when the read that lands is too old for the head the view is missing", async () => {
    const gateway = new FakeGateway()
    gateway.word("Start ")
    gateway.flush()
    const first = deferred<unknown>()
    answerLaterReadsAtOnce(gateway)
    getSession.mockImplementationOnce(() => first.promise)
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    const answered = gateway.read()
    // Words sent after the read was answered but before the view's connection was up.
    gateway.muted = true
    gateway.word("of the ")
    gateway.muted = false
    act(() => { gateway.word("answer") })
    expect(messageReads()).toBe(1)
    await act(async () => { first.resolve(answered) })
    await settle()
    expect(messageReads()).toBe(2)
    expect(shown(result.current)).toEqual(["Start of the answer"])
  })

  it("keeps the old behaviour for a gateway that does not stamp its deltas", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "u1", role: "user", content: "look at the repo", timestamp: 1 },
        { id: "p1", role: "assistant", content: "Let me check the fi", timestamp: 2, partial: true },
      ],
    })
    const gateway = new FakeGateway()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()
    act(() => { gateway.emit("session:delta", { type: "text", content: "le first." }) })
    expect(result.current.streamingText).toBe("le first.")
  })

  it("forgets a read's block when the view moves to another chat", async () => {
    const gateway = new FakeGateway()
    gateway.word("Chat one text")
    gateway.flush()
    answerLaterReadsAtOnce(gateway)
    const { result, rerender } = renderHook(({ id }) => useLiveSession(id, { subscribe: gateway.subscribe }), { initialProps: { id: "s1" } })
    await settle()
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    rerender({ id: "s2" })
    await settle()
    act(() => { gateway.emit("session:delta", { sessionId: "s2", type: "text", content: "other", streamBlock: gateway.block, offset: gateway.text.length }) })
    expect(result.current.streamingText).toBe("other")
  })
})


describe("switching away from a streaming chat and back", () => {
  const WORDS = ["Let ", "me ", "check ", "the ", "file ", "first, ", "then ", "edit ", "here ", "and ", "decide ", "what ", "to ", "do."]

  /** Stream a block in a view of the chat, leave it for another chat, and let the turn go on
   *  (frames for a chat that is not open never reach the view) until the view comes back. */
  async function leaveAndReturn(awayWords: string[], answer: "before" | "after") {
    const gateway = new FakeGateway()
    answerLaterReadsAtOnce(gateway)
    const { result, rerender } = renderHook(({ id }) => useLiveSession(id, { subscribe: gateway.subscribe }), { initialProps: { id: "s1" } })
    await settle()
    for (const word of WORDS.slice(0, 5)) act(() => { gateway.word(word) })
    gateway.flush()
    await settle()
    expect(result.current.streamingText).toBe("Let me check the file ")

    getSession.mockResolvedValue({ status: "idle", messages: [] })
    rerender({ id: "s2" })
    await settle()
    gateway.muted = true
    for (const word of awayWords) gateway.word(word)
    gateway.muted = false
    answerLaterReadsAtOnce(gateway)
    const back = deferred<unknown>()
    if (answer === "after") getSession.mockImplementationOnce(() => back.promise)
    rerender({ id: "s1" })
    return { gateway, result, back }
  }

  it("shows the block once and whole when the read answers before the next word", async () => {
    const { gateway, result } = await leaveAndReturn(WORDS.slice(5, 9), "before")
    await settle()
    act(() => { gateway.word(WORDS[9]) })
    act(() => { gateway.word(WORDS[10]) })
    expect(shown(result.current)).toEqual([WORDS.slice(0, 11).join("")])
    act(() => { gateway.tool("Read") })
    expect(shown(result.current)).toEqual([WORDS.slice(0, 11).join(""), "tool:Read"])
    await act(async () => { gateway.complete() })
    await settle()
    expect(shown(result.current)).toEqual([WORDS.slice(0, 11).join(""), "tool:Read"])
  })

  it("shows the block once and whole when words arrive while the read is out", async () => {
    const { gateway, result, back } = await leaveAndReturn(WORDS.slice(5, 9), "after")
    act(() => { gateway.word(WORDS[9]) })
    act(() => { gateway.word(WORDS[10]) })
    await act(async () => { back.resolve(gateway.read()) })
    await settle()
    expect(shown(result.current)).toEqual([WORDS.slice(0, 11).join("")])
    act(() => { gateway.word(WORDS[11]) })
    expect(shown(result.current)).toEqual([WORDS.slice(0, 12).join("")])
    act(() => { gateway.tool("Read") })
    expect(shown(result.current)).toEqual([WORDS.slice(0, 12).join(""), "tool:Read"])
  })

  it("shows what the turn did meanwhile when it moved to another block while away", async () => {
    const { gateway, result } = await leaveAndReturn(WORDS.slice(5, 9), "before")
    await settle()
    act(() => { gateway.tool("Read") })
    for (const word of ["It ", "says ", "hello."]) act(() => { gateway.word(word) })
    expect(shown(result.current)).toEqual([WORDS.slice(0, 9).join(""), "tool:Read", "It says hello."])
  })

  it("shows the tool call once when it lands before the read does", async () => {
    const { gateway, result, back } = await leaveAndReturn(WORDS.slice(5, 9), "after")
    act(() => { gateway.tool("Read") })
    await act(async () => { back.resolve(gateway.read()) })
    await settle()
    expect(shown(result.current)).toEqual([WORDS.slice(0, 9).join(""), "tool:Read"])
  })

  it("drops the cached text for a turn that is between blocks when the read comes back", async () => {
    const gateway = new FakeGateway()
    answerLaterReadsAtOnce(gateway)
    const { result, rerender } = renderHook(({ id }) => useLiveSession(id, { subscribe: gateway.subscribe }), { initialProps: { id: "s1" } })
    await settle()
    for (const word of WORDS.slice(0, 5)) act(() => { gateway.word(word) })
    gateway.flush()
    await settle()
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    rerender({ id: "s2" })
    await settle()
    gateway.muted = true
    for (const word of WORDS.slice(5, 9)) gateway.word(word)
    gateway.tool("Read")
    gateway.muted = false
    // The tool call is running: no block is streaming, and the read holds the stored rows.
    getSession.mockImplementation(() => Promise.resolve({ ...gateway.read(), liveStream: null }))
    rerender({ id: "s1" })
    await settle()
    expect(shown(result.current)).toEqual([WORDS.slice(0, 9).join(""), "tool:Read"])
    act(() => { gateway.word("Next ") })
    expect(shown(result.current)).toEqual([WORDS.slice(0, 9).join(""), "tool:Read", "Next "])
  })

  it("keeps text a gateway did not stamp, as it always was", async () => {
    __cacheLiveSessionSnapshotForTests("s1", {
      messages: [{ id: "u1", role: "user", content: "look at the repo", timestamp: 1 }],
      streamingText: "Let me check",
      loading: true,
      turnPending: true,
      session: { status: "running" },
      liveContextTokens: null,
      backgroundActivity: null,
    })
    getSession.mockResolvedValue({
      status: "running",
      messages: [{ id: "u1", role: "user", content: "look at the repo", timestamp: 1 }],
    })
    const gateway = new FakeGateway()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe: gateway.subscribe }))
    await settle()
    expect(result.current.streamingText).toBe("Let me check")
    act(() => { gateway.emit("session:delta", { type: "text", content: " the file" }) })
    expect(result.current.streamingText).toBe("Let me check the file")
  })
})
