import {
  fallbackGroupOf,
  fallbackLinkKey,
  type FallbackChainEntry,
  fallbackLinkOf,
  type FallbackGroupEntry,
  type FallbackLink,
  type FallbackWrittenEntry,
  type ResolvedFallbackLink,
} from "@hundredfold/fallback-chain-wire"
import { engineDisplayName } from "@/lib/engine-names"

/* The chain editor's model: a chain is a list of object links, however config
 * spells it. Every function returns a new list and leaves its argument alone. */

/** A declared opencode account (`engines.opencode.accounts`) as the editor and the diagram read it: its name, and the provider its models are served under. */
export interface OpencodeAccountRef {
  name: string
  provider: string
}

/** What a link's engine select and model picker are drawn from, per engine. */
export interface EngineChoice {
  name: string
  available: boolean
  defaultModel: string
  models: { id: string; label: string }[]
}

/** The instance as a row needs to know it. */
export interface ChainContext {
  engines: EngineChoice[]
  /** Declared account names under `engines.claude.accounts`. */
  profiles: string[]
  /** Declared account names under `engines.opencode.accounts`: what an opencode group member names with `profile`. Absent: not checked. */
  opencodeProfiles?: string[]
  /** The engine the chain falls back from, where the editor knows it: an opencode group is only valid where this is opencode. */
  ownEngine?: string
}

/** One row of the editor: a target, or a balanced group of Claude accounts. */
export type ChainItem = FallbackWrittenEntry

/** Whether the row is a balanced group. */
export function isGroupItem(item: ChainItem): item is FallbackGroupEntry {
  return "group" in item
}

/** Each entry as a link; an entry that is neither form (a group included) is dropped. */
export function linksOfEntries(entries: readonly unknown[] | undefined): FallbackLink[] {
  return (entries ?? []).flatMap((entry) => fallbackLinkOf(entry) ?? [])
}

/** Each entry as a row: a link, or a group kept whole. An entry that is neither form is dropped. */
export function itemsOfEntries(entries: readonly unknown[] | undefined): ChainItem[] {
  return (entries ?? []).flatMap((entry) => fallbackGroupOf(entry) ?? fallbackLinkOf(entry) ?? [])
}

/** Identity of a row: a link's key, or a group's members' keys in order. */
export function itemKey(item: ChainItem): string {
  return isGroupItem(item) ? `group[${item.group.map(fallbackLinkKey).join(",")}]` : fallbackLinkKey(item)
}

/** True when any entry is a string, whose own chain expands at run time. */
export function hasLegacyEntries(entries: readonly unknown[] | undefined): boolean {
  return (entries ?? []).some((entry) => typeof entry === "string")
}

/** A resolved link as config holds it: the gateway's `written` form, never the model it
 *  filled in to run (writing that back would pin a model the operator did not choose). */
export function linkOfResolved(resolved: FallbackLink & { written?: FallbackLink }): FallbackLink {
  const { engine, profile, model } = resolved.written ?? resolved
  return { engine, ...(profile ? { profile } : {}), ...(model ? { model } : {}) }
}

/** The effective chain as rows: consecutive links that came from one group collapse into that group, as written. */
export function itemsOfResolved(effective: readonly ResolvedFallbackLink[]): { items: ChainItem[]; origins: ("config" | "legacy")[] } {
  const items: ChainItem[] = []
  const origins: ("config" | "legacy")[] = []
  let open: number | undefined
  for (const link of effective) {
    const group = link.group
    if (group && open === group.index) continue
    open = group?.index
    // The group as config spells it (what an editor writes back), never the members' resolved models.
    items.push(group ? { group: group.written.group.map(linkOfResolved) } : linkOfResolved(link))
    origins.push(link.origin)
  }
  return { items, origins }
}

export interface ShownChain {
  links: ChainItem[]
  /** Per row: "legacy" for a link expanded from another entry's own chain. */
  origins: ("config" | "legacy")[]
  /** The chain is written in string entries, so `links` is its expansion. */
  legacy: boolean
}

/**
 * The chain as the editor shows it. A chain written in object links is shown as
 * written. One with string entries is shown as the gateway expands it (`effective`),
 * because that is what runs; until the gateway has answered, as its entries read.
 */
export function shownChain(entries: readonly unknown[] | undefined, effective: ResolvedFallbackLink[] | undefined): ShownChain {
  const legacy = hasLegacyEntries(entries)
  if (legacy && effective) {
    const { items, origins } = itemsOfResolved(effective)
    return { links: items, origins, legacy }
  }
  const links = itemsOfEntries(entries)
  return { links, origins: links.map(() => "config" as const), legacy }
}

export function removeLink<T extends ChainItem>(links: T[], index: number): T[] {
  return links.filter((_, i) => i !== index)
}

/** Move one link, keeping every other link's relative order. An index outside the
 *  chain returns it unchanged rather than dropping or duplicating a link. */
export function moveLink<T extends ChainItem>(links: T[], from: number, to: number): T[] {
  if (from === to) return links
  if (from < 0 || from >= links.length || to < 0 || to >= links.length) return links
  const next = [...links]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function replaceLink<T extends ChainItem>(links: T[], index: number, link: T): T[] {
  return links.map((existing, i) => (i === index ? link : existing))
}

/** A new engine for a row. A model belongs to one engine, and only Claude takes a
 *  profile, so both start over rather than carry a value the new engine refuses. */
export function withEngine(_link: FallbackLink, engine: string): FallbackLink {
  return { engine }
}

/** A profile for a Claude row; "" is the default profile and writes none. */
export function withProfile(link: FallbackLink, profile: string): FallbackLink {
  const { profile: _old, ...rest } = link
  return profile ? { ...rest, profile } : rest
}

/** A model for a row; "" is "no model" and writes none. */
export function withModel(link: FallbackLink, model: string): FallbackLink {
  const { model: _old, ...rest } = link
  return model ? { ...rest, model } : rest
}

/** Only a Claude link takes a profile: "Default profile" plus the declared accounts. */
export function profileOptionsFor(engine: string, profiles: string[], labels: Record<string, string> = {}): { value: string; label: string }[] | null {
  if (engine !== "claude") return null
  return [{ value: "", label: "Default profile" }, ...profiles.map((name) => ({ value: name, label: labels[name] ?? name }))]
}

/**
 * What a row with no model means, in words. On the chain's own engine it runs the
 * session's own model; on another it is the model map's translation, else that
 * engine's default. Both write no model, so the row shows the one that is true.
 */
export function noModelLabel(engine: string, ownEngine: string | undefined): string {
  return engine === ownEngine ? "Same model" : "Engine default"
}

/** A link as a row names it: "Claude · work · sonnet". */
export function rowLabel(link: FallbackLink): string {
  return [engineDisplayName(link.engine), link.profile, link.model].filter(Boolean).join(" · ")
}

/** A group member as the row names it: a Claude account by its profile ("default login" when it names none), an opencode account by its name. */
function memberLabel(member: FallbackLink): string {
  return member.profile ?? (member.engine === "claude" ? "default login" : engineDisplayName(member.engine))
}

/** A row as its controls name it: a link as {@link rowLabel}, a group as "Balanced group (default login, work)", an opencode group as "Balanced opencode group (go-a, go-b)". */
export function itemLabel(item: ChainItem): string {
  if (!isGroupItem(item)) return rowLabel(item)
  const kind = groupEngineOf(item) === "opencode" ? "Balanced opencode group" : "Balanced group"
  return `${kind} (${item.group.map(memberLabel).join(", ")})`
}

/**
 * The link a new row starts as: the first installed engine whose bare link the
 * chain does not already hold and that is not `self`, else the first engine that
 * is not `self`. The latter is a duplicate, which the row says so the operator
 * changes it.
 */
export function blankLink(ctx: ChainContext, links: ChainItem[], self: FallbackLink | readonly FallbackLink[] | undefined): FallbackLink {
  const selves = selfSpellings(self)
  const taken = new Set([...membersOf(links), ...selves].map(fallbackLinkKey))
  const names = ctx.engines.map((e) => e.name)
  const installed = ctx.engines.filter((e) => e.available).map((e) => e.name)
  const free = installed.find((name) => !taken.has(fallbackLinkKey({ engine: name })))
  const own = new Set(selves.map((s) => s.engine))
  return { engine: free ?? names.find((name) => !own.has(name)) ?? names[0] ?? "claude" }
}

/** Every target the rows name: a link itself, and each account of a group. */
export function membersOf(items: readonly ChainItem[]): FallbackLink[] {
  return items.flatMap((item) => (isGroupItem(item) ? item.group : [item]))
}

/** A Claude account as a group member: "" is the default login and writes no profile. An opencode account is named by `profile` alone. */
export function accountLink(profile: string, engine: "claude" | "opencode" = "claude"): FallbackLink {
  return profile ? { engine, profile } : { engine }
}

/** The account a group member names, "" for the default login. */
export function accountOf(link: FallbackLink): string {
  return link.profile ?? ""
}

/**
 * The engine a group's accounts run on: its members' engine, or `undefined` for a group that holds none
 * or mixes engines (the gateway refuses that, and the row shows the accounts of both).
 */
export function groupEngineOf(group: FallbackGroupEntry): "claude" | "opencode" | undefined {
  const engines = new Set(group.group.map((member) => member.engine))
  if (engines.size !== 1) return undefined
  const [engine] = engines
  return engine === "claude" || engine === "opencode" ? engine : undefined
}

/** One account a group row offers as a tick box. */
export interface GroupAccountOption {
  engine: "claude" | "opencode"
  /** The account's name; "" is the default Claude login. */
  value: string
  label: string
}

/** Every Claude account a group may hold: the default login first, then the declared profiles. */
export function groupAccountOptions(profiles: string[], labels: Record<string, string> = {}): GroupAccountOption[] {
  return [{ engine: "claude", value: "", label: "Default login" }, ...profiles.map((name): GroupAccountOption => ({ engine: "claude", value: name, label: labels[name] ?? name }))]
}

/** Every opencode account a group may hold: the declared accounts, by the name a group writes. */
export function opencodeGroupAccountOptions(names: readonly string[]): GroupAccountOption[] {
  return names.map((name) => ({ engine: "opencode", value: name, label: name }))
}

/** Whether an opencode group may be offered in this chain: only where the chain's own target runs on opencode, which is where the gateway accepts one. */
export function offersOpencodeGroup(ownEngine: string | undefined): boolean {
  return ownEngine === "opencode"
}

/**
 * A new group's members: for Claude the default login and the first declared account, for opencode the
 * first two declared accounts, skipping the accounts the chain already lists elsewhere (a member repeating a
 * standalone link is a duplicate). Fewer than two free accounts yields what there is, and the validator says
 * the group needs two.
 */
export function blankGroup(ctx: ChainContext, items: ChainItem[], engine: "claude" | "opencode" = "claude"): FallbackGroupEntry {
  const taken = new Set(membersOf(items).map(fallbackLinkKey))
  const names = engine === "opencode" ? (ctx.opencodeProfiles ?? []) : ["", ...ctx.profiles]
  const free = names.map((name) => accountLink(name, engine)).filter((link) => !taken.has(fallbackLinkKey(link)))
  return { group: free.slice(0, 2) }
}

/** The group with `member` added or removed. Members keep the order written; a new one goes last. */
export function withMember(group: FallbackGroupEntry, member: FallbackLink, on: boolean): FallbackGroupEntry {
  const key = fallbackLinkKey(member)
  const without = group.group.filter((existing) => fallbackLinkKey(existing) !== key)
  return { group: on ? [...without, member] : without }
}

/** The target a chain falls back from, as every spelling a link may not repeat. */
export function selfSpellings(self: FallbackLink | readonly FallbackLink[] | undefined): readonly FallbackLink[] {
  if (self === undefined) return []
  return Array.isArray(self) ? self : [self as FallbackLink]
}

/**
 * The chain as it is written back. A link whose entry the operator did not touch
 * goes back as that very entry, so nothing about it changes — its fields, its
 * spelling — and an object entry is never turned into a string. Every other link
 * is a plain object link, which is also how a legacy chain's expansion is saved.
 * A group goes back as `{ group: [...] }` of the members the operator chose (the
 * `written` form, never resolved models), as the entry it was when untouched.
 */
export function writeLinks(entries: readonly FallbackChainEntry[] | undefined, items: ChainItem[]): FallbackChainEntry[] {
  const untouched = (entries ?? []).filter((entry): entry is FallbackLink | FallbackGroupEntry => typeof entry === "object" && entry !== null)
  return items.map((item) => {
    const key = itemKey(item)
    const at = untouched.findIndex((entry) => {
      const known = fallbackGroupOf(entry) ?? fallbackLinkOf(entry)
      return known !== null && itemKey(known) === key
    })
    return at === -1 ? item : untouched.splice(at, 1)[0]
  })
}
