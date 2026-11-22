import type { WorkItemCompactWire } from "@/lib/api"

/* Whether the board's card menu offers Dispatch on a card, and in what state.
 * The row is the Todo page's Dispatch button (the same `api.dispatchTodo` call), so the gateway's own rules stay
 * the ones that decide; this only keeps the menu from offering what the gateway would refuse at once:
 *  - a Todo being worked (executing) or closed (done, cancelled) offers none;
 *  - a Todo whose start date is still ahead is shown disabled, saying when it starts;
 *  - a Todo already being dispatched from the board is shown disabled until that settles. */

export interface CardDispatchRow {
  disabled: boolean
  reason?: string
}

const NO_DISPATCH = new Set(["executing", "done", "cancelled"])

function startsOn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export function cardDispatchRow(item: WorkItemCompactWire, pending: boolean, now = Date.now()): CardDispatchRow | null {
  if (NO_DISPATCH.has(item.status)) return null
  if (pending) return { disabled: true, reason: "Starting Dispatcher…" }
  if (item.status === "backlog" && item.startAt) {
    const at = Date.parse(item.startAt)
    if (Number.isFinite(at) && at > now) return { disabled: true, reason: `Starts ${startsOn(item.startAt)}` }
  }
  return { disabled: false }
}
