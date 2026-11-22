import { describe, expect, it } from "vitest"
import { BACKGROUND_FINISHED_VISIBLE_MS, BACKGROUND_FIRST_READ_GRACE_MS, deriveBackgroundChip, FRESH_CHIP_MEMORY, runningLabel } from "../background-chip"

const TASK = { taskId: "t", description: "run the tests", startedAt: 1000 }

describe("runningLabel", () => {
  it("names a single task by its description", () => {
    expect(runningLabel([TASK])).toBe("Running in the background: run the tests")
    expect(runningLabel([{ ...TASK, description: null }])).toBe("Running in the background")
    expect(runningLabel([TASK, { ...TASK, taskId: "u" }])).toBe("2 tasks running in the background")
  })
})

describe("deriveBackgroundChip", () => {
  it("shows nothing without tasks", () => {
    expect(deriveBackgroundChip([], true, FRESH_CHIP_MEMORY, 5000).chip).toBeNull()
  })

  it("is running while the session's own activity reports work", () => {
    const out = deriveBackgroundChip([TASK], true, FRESH_CHIP_MEMORY, 5000)
    expect(out.chip?.kind).toBe("running")
    expect(out.memory.seenPending).toBe(true)
  })

  it("keeps running while the first activity read has not caught up", () => {
    const out = deriveBackgroundChip([TASK], false, FRESH_CHIP_MEMORY, 1000 + 2000)
    expect(out.chip?.kind).toBe("running")
  })

  it("finishes once the activity was seen and is gone", () => {
    const seen = deriveBackgroundChip([TASK], true, FRESH_CHIP_MEMORY, 5000).memory
    const out = deriveBackgroundChip([TASK], false, seen, 9000)
    expect(out.chip).toEqual({ kind: "finished", label: "Background work finished" })
    expect(out.memory.finishedAt).toBe(9000)
  })

  it("finishes after the grace when the activity was never seen", () => {
    const out = deriveBackgroundChip([TASK], false, FRESH_CHIP_MEMORY, 1000 + BACKGROUND_FIRST_READ_GRACE_MS)
    expect(out.chip?.kind).toBe("finished")
  })

  it("goes away a while after finishing, and says the tasks can be cleared", () => {
    const finished = { seenPending: true, finishedAt: 9000 }
    expect(deriveBackgroundChip([TASK], false, finished, 9000 + BACKGROUND_FINISHED_VISIBLE_MS - 1).chip?.kind).toBe("finished")
    const gone = deriveBackgroundChip([TASK], false, finished, 9000 + BACKGROUND_FINISHED_VISIBLE_MS)
    expect(gone).toMatchObject({ chip: null, done: true })
  })

  it("more background work after a finish reads as running again", () => {
    const finished = { seenPending: true, finishedAt: 9000 }
    expect(deriveBackgroundChip([TASK], true, finished, 9500).chip?.kind).toBe("running")
  })
})
