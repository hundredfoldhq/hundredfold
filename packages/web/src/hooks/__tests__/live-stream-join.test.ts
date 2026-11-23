import { describe, it, expect } from "vitest"
import { addPlacedText, deltaPlace, endedBlock, joinLiveRead, readLiveStreamBlock } from "../live-stream-join"

describe("deltaPlace", () => {
  it("reads a stamped delta's block and offset", () => {
    expect(deltaPlace({ streamBlock: 7, offset: 12 })).toEqual({ block: 7, offset: 12 })
    expect(deltaPlace({ streamBlock: 7, offset: 0 })).toEqual({ block: 7, offset: 0 })
  })

  it("places nothing it cannot trust", () => {
    expect(deltaPlace({})).toBeNull()
    expect(deltaPlace({ streamBlock: 7 })).toBeNull()
    expect(deltaPlace({ offset: 3 })).toBeNull()
    expect(deltaPlace({ streamBlock: "7", offset: 3 })).toBeNull()
    expect(deltaPlace({ streamBlock: 7, offset: -1 })).toBeNull()
    expect(deltaPlace({ streamBlock: 7, offset: 1.5 })).toBeNull()
    expect(deltaPlace({ streamBlock: Number.NaN, offset: 1 })).toBeNull()
    expect(deltaPlace({ streamBlock: Number.POSITIVE_INFINITY, offset: 1 })).toBeNull()
  })
})

describe("endedBlock", () => {
  it("reads the block a frame ends, if stamped", () => {
    expect(endedBlock({ streamBlock: 4 })).toBe(4)
    expect(endedBlock({})).toBeNull()
    expect(endedBlock({ streamBlock: "4" })).toBeNull()
    expect(endedBlock({ streamBlock: Number.NaN })).toBeNull()
  })
})

describe("readLiveStreamBlock", () => {
  it("reads the block a running session reports", () => {
    expect(readLiveStreamBlock({ liveStream: { block: 3, text: "abc", messageId: "m1" } }))
      .toEqual({ block: 3, text: "abc", messageId: "m1" })
    expect(readLiveStreamBlock({ liveStream: { block: 3, text: "", messageId: null } }))
      .toEqual({ block: 3, text: "", messageId: null })
    expect(readLiveStreamBlock({ liveStream: { block: 3, text: "a", messageId: "" } }))
      .toEqual({ block: 3, text: "a", messageId: null })
  })

  it("reports none for a read without one or with one malformed", () => {
    expect(readLiveStreamBlock({})).toBeNull()
    expect(readLiveStreamBlock({ liveStream: null })).toBeNull()
    expect(readLiveStreamBlock({ liveStream: "x" })).toBeNull()
    expect(readLiveStreamBlock({ liveStream: { block: "3", text: "a" } })).toBeNull()
    expect(readLiveStreamBlock({ liveStream: { block: 3, text: 5 } })).toBeNull()
    expect(readLiveStreamBlock({ liveStream: { block: Number.NaN, text: "a" } })).toBeNull()
  })
})

describe("addPlacedText", () => {
  it("starts a block at its offset, with the head before it missing", () => {
    expect(addPlacedText("", null, { block: 2, offset: 0 }, "Hello")).toEqual({ text: "Hello", pos: { block: 2, start: 0, missing: 0 } })
    expect(addPlacedText("", null, { block: 2, offset: 6 }, "world")).toEqual({ text: "world", pos: { block: 2, start: 6, missing: 6 } })
  })

  it("appends a delta that follows on", () => {
    const pos = { block: 2, start: 6, missing: 6 }
    expect(addPlacedText("world", pos, { block: 2, offset: 11 }, "!")).toEqual({ text: "world!", pos })
  })

  it("drops the part of a delta the text already covers", () => {
    const pos = { block: 2, start: 0, missing: 0 }
    expect(addPlacedText("Hello wor", pos, { block: 2, offset: 6 }, "world")).toEqual({ text: "Hello world", pos })
    expect(addPlacedText("Hello world", pos, { block: 2, offset: 6 }, "wor")).toEqual({ text: "Hello world", pos })
  })

  it("starts afresh past a gap in the same block", () => {
    const pos = { block: 2, start: 0, missing: 0 }
    expect(addPlacedText("Hello", pos, { block: 2, offset: 9 }, "ld")).toEqual({ text: "ld", pos: { block: 2, start: 9, missing: 9 } })
  })

  it("starts afresh at a delta of another block", () => {
    const pos = { block: 2, start: 0, missing: 0 }
    expect(addPlacedText("Hello", pos, { block: 3, offset: 0 }, "Next")).toEqual({ text: "Next", pos: { block: 3, start: 0, missing: 0 } })
  })
})

describe("joinLiveRead", () => {
  it("puts the read's head in front of the streamed text", () => {
    const joined = joinLiveRead("le first.", { block: 1, start: 19, missing: 19 }, { block: 1, text: "Let me check the fi", messageId: "p1" })
    expect(joined).toEqual({ text: "Let me check the file first.", pos: { block: 1, start: 0, missing: 0 } })
  })

  it("takes from the read only what the deltas do not hold", () => {
    // The read was answered after the first delta: it holds part of the streamed text too.
    const joined = joinLiveRead("le", { block: 1, start: 19, missing: 19 }, { block: 1, text: "Let me check the file", messageId: "p1" })
    expect(joined?.text).toBe("Let me check the file")
  })

  it("adds the read's text past the deltas' end", () => {
    const joined = joinLiveRead("Let", { block: 1, start: 0, missing: 0 }, { block: 1, text: "Let me", messageId: null })
    expect(joined).toEqual({ text: "Let me", pos: { block: 1, start: 0, missing: 0 } })
  })

  it("keeps the start of text that follows a row the view flushed", () => {
    const joined = joinLiveRead("tail", { block: 1, start: 10, missing: 0 }, { block: 1, text: "0123456789tail and more", messageId: null })
    expect(joined).toEqual({ text: "tail and more", pos: { block: 1, start: 10, missing: 0 } })
  })

  it("refuses a read that does not reach the missing head", () => {
    expect(joinLiveRead("first.", { block: 1, start: 22, missing: 22 }, { block: 1, text: "Let me check", messageId: "p1" })).toBeNull()
  })
})
