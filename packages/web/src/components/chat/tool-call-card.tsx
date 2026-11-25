import { useState, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronDown, Circle, Copy, Loader2 } from '@/components/ui/icon'
import { useFileLinkSession } from './file-link-session-context'
import { api } from '@/lib/api'
import {
  diffStats,
  editDiff,
  isNumberedPatch,
  hasOwnLineNumbers,
  identifyTool,
  inputFields,
  readStartLine,
  readableOutput,
  writtenLines,
  type DiffLine,
  type ToolDetailView,
  type ToolKind,
} from '@/lib/tool-summary'
import { copyText } from '@/platform'
import { cn } from '@/lib/utils'
import '../code-block-chrome.css'
import './tool-call-card.css'

/** Lines a block shows before it folds the rest behind "Show N more lines". */
const PREVIEW_LINES = 14
/** A diff stays open further than an output: it is the call's whole point. */
const DIFF_PREVIEW_LINES = 40

const MONO = 'font-[family-name:var(--font-code)] text-[length:var(--text-caption1)] leading-[1.6]'
const LID_TEXT = 'text-[length:var(--text-caption1)]'

type Input = Record<string, unknown>

function str(input: Input | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function plural(count: number, one: string): string {
  return `${count.toLocaleString()} ${one}${count === 1 ? '' : 's'}`
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : `Copy ${label}`}
      title={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        void copyText(text).then((result) => {
          if (result.status !== 'performed') return
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="inline-grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] border-none bg-transparent text-[var(--text-quaternary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  )
}

/**
 * One part of a call (its command, its file, its result): a lid naming it, with a copy
 * button, over the body. Parts stack inside the card, edge to edge.
 */
function Panel({ title, mono, meta, copy, tone, testId, children }: {
  title: ReactNode
  /** The title is a path, a command or a pattern, set in code type. */
  mono?: boolean
  meta?: ReactNode
  copy?: { text: string; label: string }
  tone?: 'error'
  testId?: string
  children?: ReactNode
}) {
  return (
    <section data-testid={testId} data-tone={tone} className="tool-panel min-w-0">
      <header
        data-code-head
        className={cn(
          'flex min-h-8 min-w-0 items-center gap-2 py-0.5 pl-3 pr-1',
          tone === 'error' && 'tool-panel-error-lid',
        )}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            LID_TEXT,
            mono ? 'font-[family-name:var(--font-code)] text-[var(--text-secondary)]' : 'font-[var(--weight-medium)] text-[var(--text-secondary)]',
            tone === 'error' && 'text-[var(--system-red)]',
          )}
        >
          {title}
        </span>
        {meta && <span className={cn('shrink-0 tabular-nums text-[var(--text-tertiary)]', LID_TEXT)}>{meta}</span>}
        {copy ? <CopyButton text={copy.text} label={copy.label} /> : <span className="h-7" aria-hidden="true" />}
      </header>
      {children}
    </section>
  )
}

/** A long block folded to its head, the rest a click away, and then scrolled rather than endless. */
function useFold(total: number, limit: number) {
  const [open, setOpen] = useState(false)
  const folded = !open && total > limit
  return { open, folded, shown: folded ? limit : total, hidden: total - limit, expand: () => setOpen(true) }
}

function FoldFooter({ hidden, onExpand }: { hidden: number; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="tool-fold-footer flex w-full cursor-pointer items-center justify-center gap-1 border-none bg-transparent py-1.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
    >
      Show {plural(hidden, 'more line')}
      <ChevronDown size={12} aria-hidden="true" />
    </button>
  )
}

/** Lines of code or output, edge to edge, with an optional line-number gutter. */
function CodeLines({ lines, start, numbered, testId, prose }: {
  lines: readonly string[]
  start?: number
  numbered?: boolean
  testId: string
  /** Body type rather than code (a sub-agent's prompt). */
  prose?: boolean
}) {
  const fold = useFold(lines.length, PREVIEW_LINES)
  const first = start ?? 1
  const gutter = `${String(first + lines.length - 1).length + 1}ch`
  return (
    <div data-testid={testId} className="min-w-0">
      <div className={cn('tool-lines relative py-2', fold.open && 'max-h-[60vh] overflow-y-auto', fold.folded && 'tool-lines-folded')}>
        <pre
          className={cn(
            'm-0 min-w-0 whitespace-pre-wrap break-words text-[var(--text-primary)]',
            prose ? 'font-[inherit] text-[length:var(--text-footnote)] leading-[1.55]' : MONO,
          )}
        >
          {lines.slice(0, fold.shown).map((line, index) => (
            <span key={index} className="flex min-w-0 px-3">
              {numbered && (
                <span
                  aria-hidden="true"
                  className="shrink-0 select-none pr-3 text-right text-[var(--text-quaternary)]"
                  style={{ width: gutter }}
                >
                  {first + index}
                </span>
              )}
              <span className="min-w-0 flex-1">{line || '​'}</span>
            </span>
          ))}
        </pre>
      </div>
      {fold.folded && <FoldFooter hidden={fold.hidden} onExpand={fold.expand} />}
    </div>
  )
}

const DIFF_ROW: Record<DiffLine['sign'], string> = {
  '+': 'tool-diff-add',
  '-': 'tool-diff-del',
  ' ': '',
  '…': 'tool-diff-gap',
}

/** An edit's change, line by line: every row spans the card, tinted by what happened to it. */
function DiffView({ lines, testId }: { lines: readonly DiffLine[]; testId: string }) {
  const fold = useFold(lines.length, DIFF_PREVIEW_LINES)
  const widest = lines.reduce((max, line) => Math.max(max, line.line ?? 0), 0)
  const gutter = widest > 0 ? `${String(widest).length + 1}ch` : undefined
  return (
    <div data-testid={testId} className="min-w-0">
      <div className={cn('py-1.5', fold.open && 'max-h-[70vh] overflow-y-auto', fold.folded && 'tool-lines-folded relative')}>
        <pre className={cn('m-0 min-w-0 text-[var(--text-primary)]', MONO)}>
          {lines.slice(0, fold.shown).map((line, index) => (
            line.sign === '…'
              ? <span key={index} data-diff="gap" aria-label="Unchanged lines" className={cn('flex select-none px-3 text-[var(--text-quaternary)]', DIFF_ROW['…'])}>⋯</span>
              : (
                <span key={index} data-diff={line.sign} className={cn('flex min-w-0', DIFF_ROW[line.sign])}>
                  {gutter && (
                    <span
                      aria-hidden="true"
                      data-testid="tool-diff-line-number"
                      className="tool-diff-number shrink-0 select-none pl-3 text-right"
                      style={{ width: `calc(${gutter} + 0.75rem)` }}
                    >
                      {line.line ?? ''}
                    </span>
                  )}
                  <span aria-hidden="true" className="tool-diff-sign w-7 shrink-0 select-none text-center">{line.sign === ' ' ? '' : line.sign}</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-3">
                    <span className="sr-only">{line.sign === '+' ? 'added: ' : line.sign === '-' ? 'removed: ' : ''}</span>
                    {line.text || '​'}
                  </span>
                </span>
              )
          ))}
        </pre>
      </div>
      {fold.folded && <FoldFooter hidden={fold.hidden} onExpand={fold.expand} />}
    </div>
  )
}

function DiffMeta({ lines }: { lines: readonly DiffLine[] }) {
  const { added, removed } = diffStats(lines)
  return (
    <span className="inline-flex gap-1.5 font-[family-name:var(--font-code)]">
      {added > 0 && <span className="text-[var(--system-green)]">+{added}</span>}
      {removed > 0 && <span className="text-[var(--system-red)]">−{removed}</span>}
    </span>
  )
}

/** Arguments as a two-column list: names on the left, values in code type, a nested value laid out. */
function Arguments({ input }: { input: Input }) {
  const fields = inputFields(input)
  if (fields.length === 0) return null
  return (
    <dl data-testid="tool-input-fields" className={cn('m-0 grid min-w-0 grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 px-3 py-2', MONO)}>
      {fields.map(({ label, value }) => (
        <div key={label} className="contents">
          <dt className="max-w-[16ch] truncate text-[var(--text-tertiary)]" title={label}>{label}</dt>
          <dd data-testid={`tool-input-${label}`} className="m-0 min-w-0 whitespace-pre-wrap break-words text-[var(--text-primary)]">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A todo's mark: quiet, since a live spinner per item would shout over the call's own status. */
function todoMark(status: string): ReactNode {
  if (status === 'completed') return <Check size={12} aria-label="Done" className="text-[var(--text-tertiary)]" />
  if (status === 'in_progress') return <span aria-label="In progress" className="size-2 rounded-full bg-[var(--system-blue)]" />
  return <Circle size={7} aria-label="To do" className="text-[var(--text-quaternary)]" />
}

function TodoList({ todos }: { todos: unknown[] }) {
  return (
    <ul data-testid="tool-input-todos" className="m-0 flex list-none flex-col gap-1 px-3 py-2">
      {todos.map((todo, index) => {
        const item = (todo ?? {}) as Input
        const status = typeof item.status === 'string' ? item.status : ''
        const done = status === 'completed'
        return (
          <li key={index} className="flex min-w-0 items-start gap-2 text-[length:var(--text-footnote)]">
            <span className="mt-[3px] grid size-3.5 shrink-0 place-items-center">{todoMark(status)}</span>
            <span className={cn('min-w-0 break-words', done ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]')}>
              {str(item, 'content', 'text') ?? ''}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function bashPanel(input: Input): ReactNode {
  const command = str(input, 'command', 'cmd')
  if (!command) return null
  const description = str(input, 'description')
  return (
    <Panel title={description ?? 'Command'} copy={{ text: command, label: 'command' }} testId="tool-input">
      <div data-testid="tool-input-command" className={cn('flex min-w-0 gap-2 px-3 py-2', MONO)}>
        <span aria-hidden="true" className="shrink-0 select-none text-[var(--text-quaternary)]">$</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--text-primary)]"><span className="sr-only">$ </span>{command}</span>
      </div>
    </Panel>
  )
}

function editPanel(input: Input, output?: string): ReactNode {
  const diff = editDiff(input, output)
  if (!diff) return null
  const path = str(input, 'file_path', 'filePath', 'path', 'notebook_path') ?? 'Change'
  return (
    <Panel title={path} mono meta={<DiffMeta lines={diff} />} copy={{ text: path, label: 'path' }} testId="tool-input">
      <DiffView lines={diff} testId="tool-input-diff" />
    </Panel>
  )
}

function writePanel(input: Input): ReactNode {
  const lines = writtenLines(input)
  if (!lines) return null
  const path = str(input, 'file_path', 'filePath', 'path') ?? 'New file'
  return (
    <Panel title={path} mono meta={plural(lines.length, 'line')} copy={{ text: lines.join('\n'), label: 'file' }} testId="tool-input">
      <CodeLines lines={lines} numbered testId="tool-input-content" />
    </Panel>
  )
}

function agentPanel(input: Input): ReactNode {
  const prompt = str(input, 'prompt')
  if (!prompt) return null
  const agentType = str(input, 'subagent_type', 'subagentType', 'agent')
  return (
    <Panel title={str(input, 'description') ?? 'Prompt'} meta={agentType} copy={{ text: prompt, label: 'prompt' }} testId="tool-input">
      <CodeLines lines={prompt.split('\n')} prose testId="tool-input-prompt" />
    </Panel>
  )
}

function todoPanel(input: Input): ReactNode {
  if (!Array.isArray(input.todos)) return null
  return <Panel title="Todos" meta={plural(input.todos.length, 'item')} testId="tool-input"><TodoList todos={input.todos} /></Panel>
}

const INPUT_PANELS: Partial<Record<ToolKind, (input: Input, output?: string) => ReactNode>> = {
  bash: bashPanel,
  edit: editPanel,
  write: writePanel,
  agent: agentPanel,
  todo: todoPanel,
}

/** A read or a search says all it needs on its row and its result's lid. */
const NO_INPUT_PANEL: ReadonlySet<ToolKind> = new Set(['read', 'search', 'web'])

/** What a call was asked to do, drawn the way that kind of call reads best. */
function inputPanel(toolCall: string, input: Input, output?: string): ReactNode {
  const { kind } = identifyTool(toolCall)
  const tailored = INPUT_PANELS[kind]?.(input, output)
  if (tailored) return tailored
  if (NO_INPUT_PANEL.has(kind)) return null
  return (
    <Panel title="Arguments" copy={{ text: JSON.stringify(input, null, 2), label: 'arguments' }} testId="tool-input">
      <Arguments input={input} />
    </Panel>
  )
}

/** The result's lid: what the result is of, for a call whose input drew no panel of its own. */
function resultTitle(toolCall: string, input: Input | undefined): { title: string; mono: boolean; meta?: string } {
  const { kind } = identifyTool(toolCall)
  if (kind === 'read') {
    const path = str(input, 'file_path', 'filePath', 'path', 'notebook_path')
    if (path) return { title: path, mono: true }
  }
  if (kind === 'search') return { title: 'Matches', mono: false }
  if (kind === 'web') return { title: 'Response', mono: false }
  return { title: 'Output', mono: false }
}

/** An edit's tool answers "done" or with the file again: its diff above already says it. */
function isEditEcho(output: string): boolean {
  return /^(edit applied successfully|the file .* has been (updated|created)|file (created|written|updated) successfully|wrote file successfully)/i.test(output.trim())
}

function ErrorPanel({ output }: { output?: string }) {
  return (
    <Panel
      title={<span className="inline-flex items-center gap-1.5"><AlertTriangle size={12} aria-hidden="true" />Error</span>}
      tone="error"
      copy={output ? { text: output, label: 'error' } : undefined}
      testId="tool-output"
    >
      {output && <CodeLines lines={output.split('\n')} testId="tool-output-text" />}
    </Panel>
  )
}

interface Head { title: string; mono: boolean; meta?: string }

/** A call with nothing back yet, or nothing at all. */
function EmptyPanel({ head, running }: { head: Head; running: boolean }) {
  return (
    <Panel title={head.title} mono={head.mono} meta={head.meta} testId="tool-output">
      {running ? (
        <div className="flex items-center gap-2 px-3 py-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          <Loader2 size={12} aria-hidden="true" className="animate-spin text-[var(--system-blue)]" />
          Running…
        </div>
      ) : (
        <div className="px-3 py-2 text-[length:var(--text-caption1)] italic text-[var(--text-quaternary)]">No output</div>
      )}
    </Panel>
  )
}

/**
 * Whether a finished call's result says nothing its input panel has not: an edit's
 * "applied", a write's "created", a todo list's receipt.
 */
function resultIsEcho(kind: ToolKind, output: string | undefined): boolean {
  if (kind === 'todo') return true
  if (kind !== 'edit' && kind !== 'write') return false
  // An edit that answers with its change as numbered hunks has that drawn as its diff above.
  return output === undefined || isEditEcho(output) || (kind === 'edit' && isNumberedPatch(output))
}

function ResultPanel({ toolCall, kind, head, output, input }: { toolCall: string; kind: ToolKind; head: Head; output: string; input?: Input }) {
  const { text, json } = readableOutput(output)
  const lines = text.split('\n')
  const numbered = kind === 'read' && !hasOwnLineNumbers(lines)
  const meta = head.meta ?? (json ? 'JSON' : lines.length > 1 ? plural(lines.length, 'line') : undefined)
  return (
    <Panel title={head.title} mono={head.mono} meta={meta} copy={{ text, label: 'output' }} testId="tool-output">
      <CodeLines
        key={text.length}
        lines={lines}
        numbered={numbered}
        start={numbered ? readStartLine(toolCall, input) : undefined}
        // A sub-agent's report and a fetched page's summary are prose, not program output.
        prose={!json && (kind === 'agent' || kind === 'web')}
        testId="tool-output-text"
      />
    </Panel>
  )
}

function OutputPanel({ toolCall, detail, running, standalone }: {
  toolCall: string
  detail: ToolDetailView
  running: boolean
  /** No input panel sits above it, so the lid names what this is the result of. */
  standalone: boolean
}): ReactNode {
  const { kind } = identifyTool(toolCall)
  if (detail.isError) return <ErrorPanel output={detail.output} />
  const head: Head = standalone ? resultTitle(toolCall, detail.input) : { title: kind === 'agent' ? 'Report' : 'Output', mono: false }
  if (!detail.output && running) return <EmptyPanel head={head} running />
  if (resultIsEcho(kind, detail.output)) return null
  if (!detail.output) return <EmptyPanel head={head} running={false} />
  return <ResultPanel toolCall={toolCall} kind={kind} head={head} output={detail.output} input={detail.input} />
}

/** The whole input and output the gateway kept for a call it had to cut, fetched when asked for. */
function useFullDetail(toolId: string | undefined) {
  const sessionId = useFileLinkSession()
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error'; detail?: ToolDetailView }>({ status: 'idle' })
  const available = Boolean(sessionId && toolId)
  const load = () => {
    if (!sessionId || !toolId) return
    setState({ status: 'loading' })
    api.getToolDetail(sessionId, toolId).then(
      (full) => setState({ status: 'idle', detail: full }),
      () => setState({ status: 'error' }),
    )
  }
  return { available, ...state, load }
}

/** What the gateway cut from a call, in words, and what "Load full" would bring; null when nothing was cut. */
function cutNotice(detail: ToolDetailView): { text: string; testId: string; action: string } | null {
  const chars = detail.output !== undefined ? detail.outputChars : undefined
  if (chars !== undefined) {
    const what = detail.inputTruncated ? 'input and output' : 'output'
    return {
      // The kept part ends in the "…" the gateway put where it cut.
      text: `Showing the first ${(detail.output!.length - 1).toLocaleString()} of ${chars.toLocaleString()} characters`,
      testId: 'tool-output-cut',
      action: `Load full ${what} · ${plural(chars, 'character')}`,
    }
  }
  if (detail.inputChars !== undefined) {
    return { text: `Input kept to its first part: ${plural(detail.inputChars, 'character')} in all`, testId: 'tool-input-cut', action: 'Load full input' }
  }
  if (detail.inputTruncated) return { text: 'Long input shortened', testId: 'tool-input-cut', action: 'Load full input' }
  return null
}

/** Says what the gateway cut, and offers the rest when it kept it. */
function CutFooter({ detail, full }: { detail: ToolDetailView; full: ReturnType<typeof useFullDetail> }) {
  const notice = cutNotice(detail)
  if (!notice) return null
  const canLoad = detail.full === true && full.available
  return (
    <div data-testid="tool-cut" className="tool-panel flex min-h-8 items-center gap-2 px-3 py-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
      <span data-testid={notice.testId} className="min-w-0 flex-1 truncate">{notice.text}</span>
      {canLoad && (
        <button
          type="button"
          onClick={full.load}
          disabled={full.status === 'loading'}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] border-none bg-transparent px-2 py-1 font-[var(--weight-medium)] text-[var(--accent)] transition-colors hover:bg-[var(--fill-tertiary)] disabled:cursor-default disabled:opacity-60"
        >
          {full.status === 'loading' && <Loader2 size={12} aria-hidden="true" className="animate-spin" />}
          {full.status === 'error' ? 'Could not load, try again' : notice.action}
        </button>
      )}
    </div>
  )
}

/**
 * What a tool call did: the input it was called with and what came back, each in the
 * shape that kind of call reads best (a command, a diff, a file, arguments), drawn
 * under the call's row once the reader opens it. The gateway bounds both, and the card
 * says so rather than passing a cut text off as the whole, offering the rest when kept.
 */
export function ToolCallCard({ toolCall, toolId, detail: stored, running }: {
  toolCall: string
  toolId?: string
  detail: ToolDetailView
  running: boolean
}) {
  const full = useFullDetail(toolId)
  const detail: ToolDetailView = full.detail
    ? { ...stored, ...full.detail, inputTruncated: undefined, outputChars: full.detail.outputChars, inputChars: full.detail.inputChars, full: undefined }
    : stored
  const input = detail.input ? inputPanel(toolCall, detail.input, detail.isError ? undefined : detail.output) : null
  return (
    <div
      data-testid="tool-call-card"
      className="code-block-wrap tool-call-card mb-1.5 mt-0.5 flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-lg)]"
    >
      {input}
      <OutputPanel toolCall={toolCall} detail={detail} running={running} standalone={input === null} />
      <CutFooter detail={detail} full={full} />
    </div>
  )
}
