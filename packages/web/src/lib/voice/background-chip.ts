import type { VoiceBackgroundTask } from "./state"

/** A chip is never read as finished before the session's activity read has had this long to show the work. */
export const BACKGROUND_FIRST_READ_GRACE_MS = 15_000
/** A finished chip stays this long, then goes. */
export const BACKGROUND_FINISHED_VISIBLE_MS = 8_000

export interface BackgroundChip {
  kind: "running" | "finished"
  label: string
}

export interface ChipMemory {
  /** The session's own background activity has been seen at least once for these tasks. */
  seenPending: boolean
  finishedAt: number | null
}

export const FRESH_CHIP_MEMORY: ChipMemory = { seenPending: false, finishedAt: null }

export function runningLabel(tasks: readonly VoiceBackgroundTask[]): string {
  if (tasks.length === 1) {
    const description = tasks[0].description?.trim()
    return description ? `Running in the background: ${description}` : "Running in the background"
  }
  return `${tasks.length} tasks running in the background`
}

/**
 * The chip for work the voice session moved to the background. The gateway
 * announces the move (`background` frames) but not the end; the end is the
 * session's existing background activity going quiet. So: running until that
 * activity has been seen and then is gone (or, if it was never seen, until the
 * first-read grace is over), then finished for a short while.
 */
export function deriveBackgroundChip(
  tasks: readonly VoiceBackgroundTask[],
  pending: boolean,
  memory: ChipMemory,
  now: number,
): { chip: BackgroundChip | null; memory: ChipMemory; done: boolean } {
  if (tasks.length === 0) return { chip: null, memory: FRESH_CHIP_MEMORY, done: false }
  if (pending) return { chip: { kind: "running", label: runningLabel(tasks) }, memory: { seenPending: true, finishedAt: null }, done: false }
  const since = Math.min(...tasks.map((task) => task.startedAt))
  const finishedAt = memory.finishedAt ?? (memory.seenPending || now - since >= BACKGROUND_FIRST_READ_GRACE_MS ? now : null)
  if (finishedAt === null) return { chip: { kind: "running", label: runningLabel(tasks) }, memory, done: false }
  if (now - finishedAt >= BACKGROUND_FINISHED_VISIBLE_MS) return { chip: null, memory: FRESH_CHIP_MEMORY, done: true }
  return { chip: { kind: "finished", label: "Background work finished" }, memory: { seenPending: memory.seenPending, finishedAt }, done: false }
}
