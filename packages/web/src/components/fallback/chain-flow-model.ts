import dagre from "@dagrejs/dagre"
import type { Edge, Node } from "@xyflow/react"
import type { AccountPick, FallbackLinkHealth, FallbackSkipReason, ResolvedFallbackLink } from "@hundredfold/fallback-chain-wire"
import { roomLine, startPickText } from "@/lib/account-pick-format"
import { formatReset, formatUsed, skipText } from "@/lib/fallback-format"

/* The chain diagram's data and layout, apart from the component that draws it. */

export const FLOW_NODE_W = 176
/** A group node is wider: each member carries a "headroom 30% · share 60%" line under its name. */
export const FLOW_GROUP_W = 224
export const FLOW_NODE_H = 76
/** A group node's header, each member's row, and the room under the last. */
const GROUP_HEADER_H = 26
const GROUP_MEMBER_H = 32
const GROUP_PAD_H = 10
/** About how many characters of a member's detail fit on one line of a group node, and what a second line costs. */
const GROUP_DETAIL_CHARS = 32
const GROUP_DETAIL_LINE_H = 14
/** The extra line under the start node's label when it says where new sessions start. */
const START_NOTE_H = 30

export type FlowOrientation = "horizontal" | "vertical"

/** One member of a balanced group, drawn inside the group's node. */
export interface FlowMember {
  label: string
  health: FallbackLinkHealth["state"]
  /**
   * Its headroom, or what is known of it: see `roomLine`. No share: the members of a group are
   * tried by headroom when a limit hits, and the link's `sharePercent` counts only the members it
   * lists, so in a home group the one other member would always read 100%. Shares of new sessions
   * are on the start node (`startNote`).
   */
  detail: string
  /** The member the session is on now. */
  current: boolean
  /** The member that served the latest turn. */
  servedLast: boolean
  skip: FallbackSkipReason | null
  skipText: string | null
}

export interface FlowTargetData extends Record<string, unknown> {
  label: string
  /** The session's (or subject's) own target: the start of the chain. */
  own: boolean
  health: FallbackLinkHealth["state"]
  used: string | null
  resets: string | null
  skip: FallbackSkipReason | null
  skipText: string | null
  /** Expanded from another entry's own chain, not written on this one. */
  legacy: boolean
  /** The target the session is on now. */
  current: boolean
  /** The target that served the latest turn. */
  servedLast: boolean
  orientation: FlowOrientation
  /** Set on a balanced group: its members, in the order a limit walks them (most headroom first). */
  members: FlowMember[] | null
  /** Set on the start node when a new session would be balanced onto an account of the chain's group. */
  startNote: string | null
  width: number
  height: number
}

export interface ChainFlowInput {
  /** Index 0 is the own target, then the chain in order. */
  links: ResolvedFallbackLink[]
  /** Index into `links` of the target a session is on now. */
  position?: number
  /** Key of the target that served the latest turn. */
  servedBy?: string | null
  /** What a new session of this chain's subject would pick now: the start node says so. */
  startPick?: AccountPick
  now?: number
}

/** The links one node stands for: one link, or the consecutive members of one group. */
interface FlowItem {
  links: ResolvedFallbackLink[]
  /** Index of its first link in the chain. */
  first: number
}

/**
 * The chain as nodes: consecutive links that came from the same group entry collapse into one
 * node, so a group the operator wrote as one link is drawn as one. The own target is never part
 * of a group node (it is the start; the group's expansion leaves it out).
 */
export function collapseGroups(links: ResolvedFallbackLink[]): FlowItem[] {
  const items: FlowItem[] = []
  links.forEach((link, index) => {
    const last = items[items.length - 1]
    const group = index > 0 ? link.group?.index : undefined
    if (group !== undefined && last && last.first > 0 && last.links[0].group?.index === group) last.links.push(link)
    else items.push({ links: [link], first: index })
  })
  return items
}

function isGroup(item: FlowItem): boolean {
  return item.first > 0 && item.links[0].group !== undefined
}

function memberOf(link: ResolvedFallbackLink, index: number, input: ChainFlowInput): FlowMember {
  const detail = link.group?.headroom ? roomLine(link.group.headroom) : (formatUsed(link.health?.usedPercent) ?? "")
  return {
    label: link.label,
    health: link.health?.state ?? "unknown",
    detail,
    current: input.position === index,
    servedLast: input.servedBy != null && input.servedBy === link.key,
    skip: link.skip ?? null,
    skipText: link.skip ? skipText(link.skip, link.skipDetail) : null,
  }
}

/** A member's row, taller when its detail line is long enough to wrap in the group node. */
function memberHeight(member: FlowMember): number {
  return GROUP_MEMBER_H + (member.detail.length > GROUP_DETAIL_CHARS ? GROUP_DETAIL_LINE_H : 0)
}

function heightOf(members: FlowMember[] | null, startNote: string | null): number {
  if (members) return Math.max(FLOW_NODE_H, GROUP_HEADER_H + members.reduce((sum, m) => sum + memberHeight(m), 0) + GROUP_PAD_H)
  return FLOW_NODE_H + (startNote ? START_NOTE_H : 0)
}

/** The reset and used-percent lines of a single target (a group node has neither: its members carry them). */
function usageOf(link: ResolvedFallbackLink, input: ChainFlowInput): { used: string | null; resets: string | null } {
  const reset = link.health?.state === "exhausted" ? formatReset(link.health.until, input.now) : null
  return { used: formatUsed(link.health?.usedPercent), resets: reset ? `resets ${reset}` : null }
}

/** Where the session is: this node holds the target it is on, and the one that served last. */
function placeOf(item: FlowItem, input: ChainFlowInput): { current: boolean; servedLast: boolean } {
  const { position, servedBy } = input
  return {
    current: position !== undefined && position >= item.first && position < item.first + item.links.length,
    servedLast: servedBy != null && item.links.some((l) => l.key === servedBy),
  }
}

function targetData(item: FlowItem, node: number, input: ChainFlowInput, orientation: FlowOrientation): FlowTargetData {
  const [link] = item.links
  const members = isGroup(item) ? item.links.map((l, i) => memberOf(l, item.first + i, input)) : null
  const startNote = node === 0 && input.startPick ? startPickText(input.startPick) : null
  const base = {
    ...placeOf(item, input),
    own: node === 0,
    health: link.health?.state ?? "unknown",
    legacy: link.origin === "legacy",
    orientation,
    members,
    startNote,
    width: members ? FLOW_GROUP_W : FLOW_NODE_W,
    height: heightOf(members, startNote),
  }
  if (members) return { ...base, label: "Balanced group", used: null, resets: null, skip: null, skipText: null }
  return { ...base, label: link.label, ...usageOf(link, input), skip: link.skip ?? null, skipText: link.skip ? skipText(link.skip, link.skipDetail) : null }
}

function layout(sizes: { width: number; height: number }[], orientation: FlowOrientation): { x: number; y: number }[] {
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: orientation === "horizontal" ? "LR" : "TB", nodesep: 16, ranksep: orientation === "horizontal" ? 64 : 44, marginx: 8, marginy: 8 })
  sizes.forEach((size, i) => g.setNode(String(i), size))
  for (let i = 1; i < sizes.length; i++) g.setEdge(String(i - 1), String(i))
  dagre.layout(g)
  return sizes.map((size, i) => {
    const { x, y } = g.node(String(i))
    return { x: x - size.width / 2, y: y - size.height / 2 }
  })
}

export interface ChainFlowGraph {
  nodes: Node<FlowTargetData>[]
  edges: Edge[]
  width: number
  height: number
}

/** The nodes and "on limit" edges of one chain, laid out left to right or top to bottom. */
export function buildChainFlow(input: ChainFlowInput, orientation: FlowOrientation): ChainFlowGraph {
  const items = collapseGroups(input.links)
  const data = items.map((item, node) => targetData(item, node, input, orientation))
  const at = layout(data, orientation)
  const nodes = data.map((d, index) => ({
    id: String(index),
    type: "chainTarget",
    position: at[index],
    width: d.width,
    height: d.height,
    data: d,
    draggable: false,
    selectable: false,
  }))
  const edges: Edge[] = items.slice(1).map((_, i) => ({
    id: `e${i}`,
    source: String(i),
    target: String(i + 1),
    type: "smoothstep",
    label: "on limit",
  }))
  const right = Math.max(0, ...at.map((p, i) => p.x + data[i].width)) + 16
  const bottom = Math.max(0, ...at.map((p, i) => p.y + data[i].height)) + 16
  return { nodes, edges, width: right, height: bottom }
}
