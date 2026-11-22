import type { AccountHeadroom, AccountPick } from "@hundredfold/fallback-chain-wire"
import { formatReset } from "@/lib/fallback-format"

/* How a balanced group's pick reads, in one place so the chip, the diagram and the
 * picker say the same thing.
 *
 * The pick is weighted by headroom, not "most headroom": each member of a group gets a
 * share of new sessions in proportion to its weight, so a reading carries both the
 * headroom and the share it earned. A department-scoped viewer is sent the pick without
 * `headroomPercent`, `tightest`, `readingAt`, `weight` and `sharePercent`: every line
 * here must still read from the account, label, state and reason alone. */

const STATE_WORD: Record<AccountHeadroom["state"], string> = {
  fresh: "current reading",
  stale: "stale reading",
  unknown: "no reading",
  exhausted: "at its limit",
}

/** The state of one account in words. */
export function stateText(state: AccountHeadroom["state"]): string {
  return STATE_WORD[state] ?? state
}

function whole(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null
}

/**
 * One account of a group, as a line: "headroom 60% · share 60%". An account at its limit says
 * so, one with no reading says that, and a stale reading is marked. A viewer that is not sent
 * the numbers gets the state alone.
 */
export function headroomLine(candidate: AccountHeadroom): string {
  const headroom = whole(candidate.headroomPercent)
  const share = whole(candidate.sharePercent)
  const weight = whole(candidate.weight)
  const parts: string[] = []
  if (candidate.state === "exhausted" || candidate.state === "unknown") parts.push(stateText(candidate.state))
  else if (headroom !== null) {
    parts.push(`headroom ${headroom}%`)
    // A stale reading counts for half: say so, with the weight it earned.
    if (candidate.state === "stale") parts.push("stale reading", ...(weight !== null && weight !== headroom ? [`weight ${weight}`] : []))
  }
  else if (candidate.state !== "fresh") parts.push(stateText(candidate.state))
  if (share !== null) parts.push(`share ${share}%`)
  return parts.join(" · ")
}

/** "share 60% (headroom 60%)", or what is known of it: the clause a pick sentence compares accounts with. */
function clauseOf(candidate: AccountHeadroom): string {
  const headroom = whole(candidate.headroomPercent)
  const share = whole(candidate.sharePercent)
  const state = candidate.state === "fresh" ? "" : stateText(candidate.state)
  if (share === null) return state
  // An account at its limit says so rather than "headroom 0%".
  const detail = candidate.state !== "exhausted" && headroom !== null ? `headroom ${headroom}%` : state
  return `share ${share}%${detail ? ` (${detail})` : ""}`
}

/** The candidate a pick pinned the session to, when the pick lists it. */
export function pickedCandidate(pick: AccountPick): AccountHeadroom | undefined {
  return pick.candidates.find((c) => c.account === pick.picked)
}

/** The picked account's name: its label, else its account key. */
export function pickedLabel(pick: AccountPick): string {
  return pickedCandidate(pick)?.label ?? pick.picked
}

function versus(others: AccountHeadroom[], picked: AccountHeadroom | undefined): string {
  const numbers = picked !== undefined && whole(picked.sharePercent) !== null
  return others
    .map((other) => {
      const clause = clauseOf(other)
      return numbers ? `${other.label} ${clause.replace(/^share /, "")}`.trim() : `${other.label}${clause ? ` (${clause})` : ""}`
    })
    .join(", ")
}

/**
 * Why the session was pinned to its account, in plain words:
 * "Picked spare: share 60% (headroom 60%) vs work 40% (headroom 40%)".
 */
export function pickReasonText(pick: AccountPick): string {
  const picked = pickedCandidate(pick)
  const name = pickedLabel(pick)
  const others = pick.candidates.filter((c) => c.account !== pick.picked)
  switch (pick.reason) {
    case "only-candidate":
      return `Picked ${name}: the only account in the group that could serve this session`
    case "no-readings":
      return `Picked ${name}: no usage readings yet, so new sessions were split evenly across the group`
    case "all-exhausted":
      return `Picked ${name}: every account in the group was at its limit, and this one reopens first`
    default: {
      const own = picked ? clauseOf(picked) : ""
      const against = versus(others, picked)
      if (own && against) return `Picked ${name}: ${own} vs ${against}`
      return against ? `Picked ${name}, weighted by headroom against ${against}` : `Picked ${name}, weighted by headroom`
    }
  }
}

/** When and why the balancer ran: "At session start, 14:02". */
export function pickTriggerText(pick: AccountPick): string {
  const when = formatReset(pick.at)
  const what = pick.trigger === "switch" ? "On a switch to Claude" : "At session start"
  return when ? `${what}, ${when}` : what
}

/** What a new session would start on now, for the diagram's start node: "New sessions start on spare (share 60%)". */
export function startPickText(pick: AccountPick): string {
  const share = whole(pickedCandidate(pick)?.sharePercent)
  return `New sessions start on ${pickedLabel(pick)}${share !== null ? ` (share ${share}%)` : ""}`
}
