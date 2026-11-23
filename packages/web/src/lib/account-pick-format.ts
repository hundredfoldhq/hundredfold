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

const OPENCODE_KEY_PREFIX = "opencode/"

/** Whether a pick's account key is an opencode account's (`opencode/<provider>`); a Claude key never starts this way. */
export function isOpencodeAccountKey(key: string): boolean {
  return key.startsWith(OPENCODE_KEY_PREFIX)
}

/** The engine whose accounts a pick chose between: opencode for `opencode/<provider>` keys, Claude for every other key (local, and a remote host's `claude@user@host[:profile]`). */
export function pickEngine(pick: Pick<AccountPick, "picked" | "candidates">): "claude" | "opencode" {
  return isOpencodeAccountKey(pick.picked) || pick.candidates.some((c) => isOpencodeAccountKey(c.account)) ? "opencode" : "claude"
}

/**
 * An account key as a person reads it, for the one case the gateway sent no label to show instead:
 * `opencode/opencode-go-b` is "opencode · opencode-go-b", and a remote Claude login
 * `claude@ops@build:spare` is "spare (ops@build)" ("ops@build" for the host's own login).
 */
export function accountKeyText(key: string): string {
  if (isOpencodeAccountKey(key)) return `opencode · ${key.slice(OPENCODE_KEY_PREFIX.length)}`
  const remote = /^claude@([^:]+)(?::(.+))?$/.exec(key)
  if (remote) return remote[2] ? `${remote[2]} (${remote[1]})` : remote[1]
  return key
}

/** One candidate's name: the label the gateway gave it, else its key made readable. */
export function candidateLabel(candidate: Pick<AccountHeadroom, "account" | "label">): string {
  return candidate.label || accountKeyText(candidate.account)
}

/** The state of one account in words. */
export function stateText(state: AccountHeadroom["state"]): string {
  return STATE_WORD[state] ?? state
}

function whole(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null
}

/** What is known of one account's room: its headroom, at its limit, no reading, a stale reading. */
function roomParts(candidate: AccountHeadroom): string[] {
  const headroom = whole(candidate.headroomPercent)
  if (candidate.state === "exhausted" || candidate.state === "unknown") return [stateText(candidate.state)]
  if (headroom !== null) return [`headroom ${headroom}%`, ...(candidate.state === "stale" ? ["stale reading"] : [])]
  return candidate.state !== "fresh" ? [stateText(candidate.state)] : []
}

/**
 * One account of a group as a fallback member: "headroom 60%", or what is known of it. No weight
 * or share: the members are tried by headroom when a limit hits, so those mean nothing there.
 */
export function roomLine(candidate: AccountHeadroom): string {
  return roomParts(candidate).join(" · ")
}

/**
 * One candidate of a pick, as a line: "headroom 60% · share 60%". An account at its limit says
 * so, one with no reading says that, and a stale reading is marked with the weight it earned. A
 * viewer that is not sent the numbers gets the state alone.
 */
export function headroomLine(candidate: AccountHeadroom): string {
  const headroom = whole(candidate.headroomPercent)
  const share = whole(candidate.sharePercent)
  const weight = whole(candidate.weight)
  const parts = roomParts(candidate)
  // A stale reading counts for half: say so, with the weight it earned.
  if (candidate.state === "stale" && headroom !== null && weight !== null && weight !== headroom) parts.push(`weight ${weight}`)
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

/** The picked account's name: its label, else its account key made readable. */
export function pickedLabel(pick: AccountPick): string {
  const picked = pickedCandidate(pick)
  return picked ? candidateLabel(picked) : accountKeyText(pick.picked)
}

function versus(others: AccountHeadroom[], picked: AccountHeadroom | undefined): string {
  const numbers = picked !== undefined && whole(picked.sharePercent) !== null
  return others
    .map((other) => {
      const clause = clauseOf(other)
      const name = candidateLabel(other)
      return numbers ? `${name} ${clause.replace(/^share /, "")}`.trim() : `${name}${clause ? ` (${clause})` : ""}`
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
  const what = pick.trigger === "switch" ? `On a switch to ${pickEngine(pick) === "opencode" ? "opencode" : "Claude"}` : "At session start"
  return when ? `${what}, ${when}` : what
}

/** What a new session would start on now, for the diagram's start node: "New sessions start on spare (share 60%)". */
export function startPickText(pick: AccountPick): string {
  const share = whole(pickedCandidate(pick)?.sharePercent)
  return `New sessions start on ${pickedLabel(pick)}${share !== null ? ` (share ${share}%)` : ""}`
}
