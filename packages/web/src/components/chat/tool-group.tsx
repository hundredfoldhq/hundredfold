import { useRef, type CSSProperties } from 'react'
import { Bot, ChevronDown, FileText, Globe, ListTodo, PenLine as FilePen, Plug, Search, Terminal, Wrench, type IconComponent } from '@/components/ui/icon'
import type { Message } from '@/lib/conversations'
import type { SubagentRef } from '@/lib/subagent-transcript'
import { statusMark } from './chat-blocks'
import { ToolCallCard } from './tool-call-card'
import { identifyTool, summarizeTool, toolDetailOf, type ToolKind } from '@/lib/tool-summary'
import { commsArrivalDelayMs } from './message-arrival'
import { usePersistentExpansion } from './transcript-expansion'
import { cn } from '@/lib/utils'

// A finished tool call lands in the transcript as "Used <tool>". While it's
// still running the content carries the live tool name instead.
export function isToolDone(msg: Message): boolean {
  return msg.content.startsWith('Used ')
}

function findActiveToolIndex(msgs: Message[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!isToolDone(msgs[i])) return i
  }
  return -1
}

const TOOL_GLYPH_RULES: ReadonlyArray<{
  glyph: IconComponent
  matches: readonly string[]
}> = [
  { glyph: FileText, matches: ['read', 'write', 'edit', 'file', 'patch', 'notebook'] },
  { glyph: Terminal, matches: ['bash', 'shell', 'exec', 'run', 'command'] },
  { glyph: Search, matches: ['grep', 'glob', 'search', 'find'] },
  { glyph: Globe, matches: ['fetch', 'web', 'browser', 'http'] },
]

const KIND_GLYPHS: Partial<Record<ToolKind, IconComponent>> = {
  bash: Terminal,
  read: FileText,
  write: FilePen,
  edit: FilePen,
  search: Search,
  web: Globe,
  agent: Bot,
  todo: ListTodo,
}

/** A builtin by its kind; any other tool by what its name suggests, an MCP tool falling back to a plug. */
export function toolGlyphForName(toolName: string): IconComponent {
  const { kind } = identifyTool(toolName)
  const kindGlyph = KIND_GLYPHS[kind]
  if (kindGlyph) return kindGlyph
  const normalized = toolName.replace(/^mcp__.*?__/i, '').toLowerCase()
  return TOOL_GLYPH_RULES.find(({ matches }) => matches.some((match) => normalized.includes(match)))?.glyph
    ?? (kind === 'mcp' ? Plug : Wrench)
}

/** The stagger this arrival sits at, as the shared `--arrive-delay` rail reads
 *  it. Absent when the row carries no index, so the CSS fallback applies. */
function arriveDelay(arrival: number | undefined): CSSProperties | undefined {
  if (arrival === undefined) return undefined
  return { '--arrive-delay': `${commsArrivalDelayMs(arrival)}ms` } as CSSProperties
}

interface ToolEntry {
  msg: Message
  index: number
}

/** Opens a background sub-agent's transcript from its Agent card. `returnFocusTo`
 *  is the card, which is still on the page when the view closes. Not
 *  `file-open-context`'s `OpenSubagent`, which opens a tab and answers whether one opened. */
export type OpenSubagentCard = (agent: SubagentRef, returnFocusTo: HTMLElement | null) => void

/** The sub-agent id a background `Agent`/`Task` launch left on its row, if any. */
function subagentIdOf(msg: Message): string | null {
  const id = msg.meta?.agentId
  return typeof id === 'string' && id ? id : null
}

/** Stable across the group's re-renders, including the calls that carry no id. */
function toolChipKey(entry: ToolEntry): string {
  return entry.msg.id || `${entry.msg.toolCall}-${entry.index}`
}

/** Which rail a chip entered on: the live arrival rail, or the reader opening a
 *  group that had already settled. */
type ChipEnter = 'chip' | 'expand'

/** The first ten, plus the running one when it sits deeper than that — a long
 *  pile still has to show what it is doing right now. */
function visibleToolEntries(msgs: Message[], activeIndex: number, showAll: boolean): ToolEntry[] {
  const indexed = msgs.map((msg, index) => ({ msg, index }))
  if (showAll) return indexed
  if (activeIndex >= 10) return [...indexed.slice(0, 9), indexed[activeIndex]]
  return indexed.slice(0, 10)
}

const CHIP_BASE = 'flex min-h-8 w-full min-w-0 items-center gap-2 px-2 py-1 text-left'
const CHIP_BUTTON = 'cursor-pointer rounded-md border-none bg-transparent font-[inherit] transition-colors duration-150 hover:bg-[var(--fill-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]'

type ChipStatus = 'done' | 'running' | 'queued' | 'error'

function chipStatus(msg: Message, isActive: boolean, failed: boolean): ChipStatus {
  if (isToolDone(msg)) return failed ? 'error' : 'done'
  return isActive ? 'running' : 'queued'
}

/** The call's name as its chip titles it: an MCP call is its server and tool. */
function chipTitle(toolCall: string | undefined, index: number): string {
  if (!toolCall) return `Tool ${index + 1}`
  const { kind, server, name } = identifyTool(toolCall)
  return kind === 'mcp' ? `${server} › ${name}` : toolCall
}

function ToolChipContent({ msg, index, status, summary, expanded }: {
  msg: Message
  index: number
  status: ChipStatus
  summary: string
  /** Present when the call has detail to open: whether it is open. */
  expanded?: boolean
}) {
  const ToolGlyph = toolGlyphForName(msg.toolCall || '')
  return (
    <>
      <span className="grid size-4 shrink-0 place-items-center">
        {statusMark(status)}
      </span>
      <ToolGlyph size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
      <span className="min-w-0 max-w-[45%] shrink-0 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
        {chipTitle(msg.toolCall, index)}
      </span>
      {summary && (
        <span
          data-testid="tool-summary"
          className="min-w-0 flex-1 truncate font-[family-name:var(--font-code)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
        >
          {summary}
        </span>
      )}
      {expanded !== undefined && (
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={`ml-auto shrink-0 text-[var(--text-quaternary)] transition-transform duration-150 ease-[var(--ease-smooth)] ${expanded ? 'rotate-180' : 'rotate-0'}`}
        />
      )}
    </>
  )
}

/** A background Agent/Task call's chip: opening the sub-agent's transcript, and beside it the call's detail. */
function SubagentChipRow({ msg, index, status, summary, agentId, onOpen, className, style, enter, toggle }: {
  msg: Message
  index: number
  status: ChipStatus
  summary: string
  agentId: string
  onOpen: OpenSubagentCard
  className: string
  style: CSSProperties | undefined
  enter: ChipEnter | undefined
  toggle: ChipToggle | null
}) {
  return (
    <div data-tool-enter={enter} style={style} className={className}>
      <button
        type="button"
        data-pane-focus-preserving
        className={cn(CHIP_BASE, CHIP_BUTTON, 'min-w-0 flex-1')}
        aria-label={`Open the ${msg.toolCall || 'Agent'} sub-agent transcript`}
        onClick={(event) => onOpen({ id: agentId, description: null, agentType: null }, event.currentTarget)}
      >
        <ToolChipContent msg={msg} index={index} status={status} summary={summary} />
      </button>
      {toggle && (
        <button type="button" data-pane-focus-preserving className={cn(CHIP_BUTTON, 'grid size-8 shrink-0 place-items-center p-0')} {...toggle.props}>
          <ChevronDown size={12} aria-hidden="true" className={`text-[var(--text-quaternary)] transition-transform duration-150 ${toggle.open ? 'rotate-180' : 'rotate-0'}`} />
        </button>
      )}
    </div>
  )
}

interface ChipToggle {
  open: boolean
  props: { 'aria-expanded': boolean; 'aria-label': string; onClick: () => void }
}

/** What a chip shows and how it opens: its detail, status and one-line summary, and the toggle for the detail. */
function useChipModel(entry: ToolEntry, activeIndex: number) {
  const { msg, index } = entry
  const detail = toolDetailOf(msg)
  const [open, setOpen] = usePersistentExpansion(`tool-card:${toolChipKey(entry)}`, false)
  const toggle: ChipToggle | null = detail
    ? {
        open,
        props: {
          'aria-expanded': open,
          'aria-label': `${open ? 'Hide' : 'Show'} the ${msg.toolCall || 'tool'} call's input and result`,
          onClick: () => setOpen(!open),
        },
      }
    : null
  return {
    detail,
    toggle,
    status: chipStatus(msg, index === activeIndex, detail?.isError === true),
    summary: summarizeTool(msg.toolCall || '', detail?.input),
  }
}

/** The chip itself: a button that opens the call's detail, a sub-agent card, or plain text for a call with none. */
function ToolChipRow({ entry, status, summary, toggle, arrival, enter, onOpenSubagent }: {
  entry: ToolEntry
  status: ChipStatus
  summary: string
  toggle: ChipToggle | null
  arrival: number | undefined
  enter: ChipEnter | undefined
  onOpenSubagent?: OpenSubagentCard
}) {
  const { msg, index } = entry
  const agentId = subagentIdOf(msg)
  const style = enter ? arriveDelay(arrival) : undefined
  const content = (expanded?: boolean) => (
    <ToolChipContent msg={msg} index={index} status={status} summary={summary} expanded={expanded} />
  )
  // Only a background sub-agent launch carries an agent id: its card opens the same
  // read-only transcript the waiting-on popup does, which is gone once it finishes.
  // The card keeps no description or agent type, so the view opens without the row's labels.
  if (agentId && onOpenSubagent) {
    return (
      <SubagentChipRow
        msg={msg} index={index} status={status} summary={summary} agentId={agentId} onOpen={onOpenSubagent}
        className={cn('flex w-full min-w-0 items-center', enter && 'tool-arrive')}
        style={style} enter={enter} toggle={toggle}
      />
    )
  }
  if (toggle) {
    return (
      <button type="button" data-tool-enter={enter} data-pane-focus-preserving style={style} className={cn(CHIP_BASE, CHIP_BUTTON, enter && 'tool-arrive')} {...toggle.props}>
        {content(toggle.open)}
      </button>
    )
  }
  return <div data-tool-enter={enter} style={style} className={cn(CHIP_BASE, enter && 'tool-arrive')}>{content()}</div>
}

function ToolChip({ entry, activeIndex, arrival, enter, onOpenSubagent }: {
  entry: ToolEntry
  activeIndex: number
  arrival: number | undefined
  enter: ChipEnter | undefined
  onOpenSubagent?: OpenSubagentCard
}) {
  const { detail, toggle, status, summary } = useChipModel(entry, activeIndex)
  return (
    <div className="flex w-full min-w-0 flex-col">
      <ToolChipRow entry={entry} status={status} summary={summary} toggle={toggle} arrival={arrival} enter={enter} onOpenSubagent={onOpenSubagent} />
      {detail && toggle?.open && (
        <div className="min-w-0 pl-2">
          <ToolCallCard toolCall={entry.msg.toolCall || ''} toolId={entry.msg.toolId} detail={detail} running={status !== 'done' && status !== 'error'} />
        </div>
      )}
    </div>
  )
}

/** The chips the reader's own expansion animates in: the ones the group held
 *  when it opened. Latched at mount, so an already-open group cannot restart the
 *  stagger, and a call appended into one rides the live arrival rail instead. */
function useExpandedChips(entries: ToolEntry[], expanding: boolean): ReadonlySet<string> {
  const opened = useRef<ReadonlySet<string> | null>(null)
  if (!opened.current) opened.current = new Set(expanding ? entries.map(toolChipKey) : [])
  return opened.current
}

function ToolChipList({ msgs, activeIndex, showAll, onShowAll, arrivals, isEntering, expanding, onOpenSubagent }: {
  msgs: Message[]
  activeIndex: number
  showAll: boolean
  onShowAll: () => void
  arrivals: Map<string, number>
  isEntering: (id: string | undefined) => boolean
  /** The reader just opened this group. False when the list comes back with a
   *  windowed row that was already open — that is not an entrance. */
  expanding: boolean
  onOpenSubagent?: OpenSubagentCard
}) {
  const entries = visibleToolEntries(msgs, activeIndex, showAll)
  const expandedChips = useExpandedChips(entries, expanding)
  const hiddenToolCount = Math.max(0, msgs.length - entries.length)
  return (
    <div
      className="mt-1.5 flex w-full min-w-0 flex-col items-stretch gap-0.5"
      data-testid="tool-group-list"
    >
      {entries.map((entry, position) => {
        const live = isEntering(entry.msg.id)
        return (
          <ToolChip
            key={toolChipKey(entry)}
            entry={entry}
            activeIndex={activeIndex}
            // A live call keeps the slot the arrival rail gave it; a chip the
            // reader just revealed staggers by its place in the opened list.
            arrival={live ? arrivals.get(entry.msg.id ?? '') : position}
            enter={live ? 'chip' : expandedChips.has(toolChipKey(entry)) ? 'expand' : undefined}
            onOpenSubagent={onOpenSubagent}
          />
        )
      })}
      {hiddenToolCount > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="ml-6 inline-flex min-h-8 self-start items-center gap-1 rounded-full border-none bg-transparent px-2.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-[background-color,color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)] active:scale-[0.96]"
        >
          Show {hiddenToolCount} more
          <ChevronDown size={13} className="shrink-0 text-[var(--text-quaternary)]" />
        </button>
      )}
    </div>
  )
}

function ToolGroupPill({ count, running, expanded, onToggle, entering, arrival }: {
  count: number
  running: boolean
  expanded: boolean
  onToggle: () => void
  entering: boolean
  arrival: number | undefined
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      data-tool-enter={entering ? 'group' : undefined}
      style={entering ? arriveDelay(arrival) : undefined}
      className={cn(
        'inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border-none bg-[var(--fill-quaternary)] py-1 pl-3 pr-2.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)] shadow-none transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.97]',
        entering && 'tool-arrive',
      )}
    >
      <Wrench size={13} className="shrink-0 text-[var(--text-tertiary)]" />
      <span className="min-w-0 truncate font-[var(--weight-medium)]">
        {`${count} tool${count !== 1 ? 's' : ''}${running ? ' running…' : ''}`}
      </span>
      {running && (
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--system-blue)] animate-[hundredfold-pulse_1.4s_infinite]" />
      )}
      <ChevronDown size={14} className={`ml-0.5 shrink-0 text-[var(--text-quaternary)] transition-transform duration-150 ease-[var(--ease-smooth)] ${expanded ? 'rotate-180' : 'rotate-0'}`} />
    </button>
  )
}

/**
 * The call whose rail slot the group's pill enters on, or undefined when the
 * group was already on screen.
 *
 * The pill is the group's own arrival, so the question is only ever asked once,
 * at mount: a call appended into a group the reader is already looking at must
 * not re-animate the pill above it. Which call answers it is not necessarily the
 * first — a group that opens with more calls than the rail's three slots leaves
 * its opener unmarked, and anchoring on the opener alone would drop the
 * entrance of the whole group.
 */
function useGroupArrival(msgs: Message[], isEntering: (id: string | undefined) => boolean): string | undefined {
  const latched = useRef<{ id: string | undefined } | null>(null)
  if (!latched.current) {
    latched.current = { id: msgs.find((msg) => isEntering(msg.id))?.id }
  }
  return latched.current.id
}

export function ToolGroup({ msgs, isActive, groupId, arrivals, isEntering, onOpenSubagent }: {
  msgs: Message[]
  isActive: boolean
  /** Identity the expansion outlives the row by, once virtualised. */
  groupId: string
  /** Stagger index per live-arrived tool call — the same rail comms rows use. */
  arrivals: Map<string, number>
  /** True while a tool call that arrived live still owes its entrance. */
  isEntering: (id: string | undefined) => boolean
  /** Opens a finished background sub-agent's transcript from its Agent card. */
  onOpenSubagent?: OpenSubagentCard
}) {
  const [expanded, setExpanded] = usePersistentExpansion(`tools:${groupId}`, false)
  const [showAllTools, setShowAllTools] = usePersistentExpansion(`tools-all:${groupId}`, false)
  const arrivingId = useGroupArrival(msgs, isEntering)
  // Whether the reader opened the group here. The expansion outlives the row, so
  // a windowed row scrolling back into view restores an open group without
  // re-opening it, and an entrance it already played must not play again.
  const openedHere = useRef(false)

  return (
    // Share the assistant text gutter (.assistant-msg-row → space-3 / space-8 @lg)
    // so the tool card's left edge lines up with the message text column.
    <div className="assistant-msg-row mb-[var(--space-1)]">
      <ToolGroupPill
        count={msgs.length}
        running={isActive && !msgs.every(isToolDone)}
        expanded={expanded}
        onToggle={() => {
          openedHere.current = !expanded
          setExpanded(!expanded)
        }}
        entering={arrivingId !== undefined}
        arrival={arrivals.get(arrivingId ?? '')}
      />
      {expanded && (
        <ToolChipList
          msgs={msgs}
          activeIndex={isActive ? findActiveToolIndex(msgs) : -1}
          showAll={showAllTools}
          onShowAll={() => setShowAllTools(true)}
          arrivals={arrivals}
          isEntering={isEntering}
          expanding={openedHere.current}
          onOpenSubagent={onOpenSubagent}
        />
      )}
    </div>
  )
}
