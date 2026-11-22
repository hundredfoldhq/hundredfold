import type { OpencodeAccountRef } from "@/routes/settings/engines/chain-links"
import {
  fallbackLinkKey,
  fallbackLinkLabel,
  type FallbackChainSubject,
  type FallbackGroupEntry,
  type FallbackLink,
  type FallbackWrittenEntry,
  type ResolvedFallbackLink,
} from "@hundredfold/fallback-chain-wire"

/** A link with nothing the gateway said about it: what the diagram draws before a reading, or for an unsaved row. */
export function plainResolved(link: FallbackLink, origin: ResolvedFallbackLink["origin"] = "config"): ResolvedFallbackLink {
  return { ...link, key: fallbackLinkKey(link), account: link.engine, label: fallbackLinkLabel(link), origin }
}

/** What the gateway said of each target, by the key of the link as written and then by its
 *  resolved key: a row is a link as written, and one with no model would never find the
 *  gateway's reading under the resolved key, which carries the model it would run. */
function readingsByKey(subject: FallbackChainSubject | undefined): Map<string, ResolvedFallbackLink> {
  const known = new Map<string, ResolvedFallbackLink>()
  for (const link of [subject?.primary, ...(subject?.effective ?? [])]) {
    if (!link) continue
    if (link.written) known.set(fallbackLinkKey(link.written), link)
    if (!known.has(link.key)) known.set(link.key, link)
  }
  return known
}

/** An entry the editor shows: a link, or a balanced group of accounts. */
function groupOfEntry(entry: FallbackWrittenEntry): FallbackGroupEntry | null {
  return "group" in entry ? entry : null
}

/**
 * The member of an opencode group that is the chain's own account: the declared account whose provider
 * serves the own model (`opencode-go/glm-5` is the account declared with provider `opencode-go`). The
 * gateway leaves it out of the expansion, the own target being the start of the chain. Undefined when the
 * own model names no declared account, or the declared accounts are not known.
 */
function ownOpencodeMember(ownModel: string | undefined, accounts: readonly OpencodeAccountRef[] | undefined): FallbackLink | undefined {
  const slash = ownModel ? ownModel.indexOf("/") : -1
  const provider = ownModel && slash > 0 ? ownModel.slice(0, slash) : undefined
  const account = provider === undefined ? undefined : accounts?.find((candidate) => candidate.provider === provider)
  return account && { engine: "opencode", profile: account.name }
}

/** What expanding a group needs to know of the chain it sits in. */
interface GroupExpansion {
  /** The keys of every member that is the chain's own account: `self`, and for an opencode chain the account serving its own model. */
  own: Set<string>
  known: Map<string, ResolvedFallbackLink>
  /** Where the gateway listed each written link, by key. */
  order: Map<string, number>
  origin: ResolvedFallbackLink["origin"]
}

/**
 * A group as the diagram draws it: its members as links carrying the group they came from, in the
 * order the gateway ranked them by headroom (a member it has not seen keeps its written place,
 * after the ranked ones). The chain's own account is the start node, never a member here, as in
 * the gateway's own expansion.
 */
function expandGroup(group: FallbackGroupEntry, index: number, ctx: GroupExpansion): ResolvedFallbackLink[] {
  const { own, known, order, origin } = ctx
  const members = group.group.filter((member) => !own.has(fallbackLinkKey(member)))
  const ranked = members.map((member, written) => {
    const reading = known.get(fallbackLinkKey(member))
    return { member, written, reading, rank: reading?.group?.headroom ? 0 : 1 }
  })
  // The gateway ranks the members when it resolves the chain: its order is the one a limit walks.
  ranked.sort((a, b) => a.rank - b.rank || (order.get(fallbackLinkKey(a.member)) ?? 0) - (order.get(fallbackLinkKey(b.member)) ?? 0) || a.written - b.written)
  return ranked.map(({ member, reading }) => ({
    ...(reading ?? plainResolved(member)),
    // An opencode member is an account, not the model it would run (`opencode-go-b/glm-5`): the diagram names it by account, as the gateway's own pick does.
    ...(member.engine === "opencode" ? { label: fallbackLinkLabel(member) } : {}),
    origin,
    group: { index, written: group, ...(reading?.group?.headroom ? { headroom: reading.group.headroom } : {}) },
  }))
}

/**
 * The own target and entries as the diagram draws them: each link carries what the
 * gateway said of it (health, why it would be skipped) when `subject` knows that
 * target, so a row the operator has just added or edited, which the gateway has not
 * seen, still shows, plain. A group entry is drawn as its members, marked as one group.
 */
export function resolveForFlow(
  self: FallbackLink,
  entries: FallbackWrittenEntry[],
  subject: FallbackChainSubject | undefined,
  origins?: ("config" | "legacy")[],
  /** The declared opencode accounts, to tell an opencode group's own account (the start node) from its members. */
  opencodeAccounts?: readonly OpencodeAccountRef[],
): ResolvedFallbackLink[] {
  const known = readingsByKey(subject)
  const order = new Map<string, number>()
  subject?.effective.forEach((link, at) => order.set(fallbackLinkKey(link.written ?? link), at))
  // The gateway's own target carries the default model, so its key is not the bare `self`'s: take it from the subject.
  const own = subject?.primary ?? known.get(fallbackLinkKey(self)) ?? plainResolved(self)
  const ownKeys = new Set([fallbackLinkKey(self)])
  const ownMember = ownOpencodeMember(own.model ?? self.model, opencodeAccounts)
  if (ownMember) ownKeys.add(fallbackLinkKey(ownMember))
  const rest = entries.flatMap((entry, i): ResolvedFallbackLink[] => {
    const origin = origins?.[i] ?? "config"
    const group = groupOfEntry(entry)
    if (group) return expandGroup(group, i, { own: ownKeys, known, order, origin })
    return [{ ...(known.get(fallbackLinkKey(entry as FallbackLink)) ?? plainResolved(entry as FallbackLink)), origin }]
  })
  return [{ ...own, skip: undefined }, ...rest]
}
