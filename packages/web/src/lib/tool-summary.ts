import type { Message } from '@/lib/conversations'

/**
 * What a tool call's card shows. The gateway stores the call's input, output and
 * failure on the tool row's `meta.tool` (redacted and bounded there); an older
 * row has none, and draws as the plain name it always did.
 */
export interface ToolDetailView {
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
  /** Part of the input was cut by the gateway. */
  inputTruncated?: boolean
  /** The output's length before the gateway cut it. */
  outputChars?: number
  /** The gateway kept the whole input and output, to fetch on demand. */
  full?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && Object.keys(value).length > 0 ? value : undefined
}

function cleanDetail(raw: Record<string, unknown>): ToolDetailView {
  return {
    input: nonEmptyRecord(raw.input),
    output: typeof raw.output === 'string' && raw.output ? raw.output : undefined,
    isError: raw.isError === true ? true : undefined,
    inputTruncated: raw.inputTruncated === true ? true : undefined,
    outputChars: typeof raw.outputChars === 'number' ? raw.outputChars : undefined,
    full: raw.full === true ? true : undefined,
  }
}

/** A tool-details payload, read as defensively as a row's meta. */
export function toolDetailFromWire(raw: unknown): ToolDetailView {
  return isRecord(raw) ? cleanDetail(raw) : {}
}

/** The detail a tool row carries, read defensively: meta crosses the wire untyped. */
export function toolDetailOf(msg: Pick<Message, 'meta'>): ToolDetailView | undefined {
  const raw = msg.meta?.tool
  if (!isRecord(raw)) return undefined
  const detail = cleanDetail(raw)
  return detail.input || detail.output || detail.isError ? detail : undefined
}

export type ToolKind = 'bash' | 'read' | 'write' | 'edit' | 'search' | 'web' | 'agent' | 'mcp' | 'todo' | 'generic'

/** A tool's name as the card titles it: an MCP call is its server and tool. */
export interface ToolIdentity {
  kind: ToolKind
  /** The tool's own name (for MCP, the tool without its server). */
  name: string
  server?: string
}

const BUILTIN_KINDS: Record<string, ToolKind> = {
  bash: 'bash', shell: 'bash', bashoutput: 'bash', killshell: 'bash',
  read: 'read', notebookread: 'read', list: 'read', ls: 'read',
  write: 'write',
  edit: 'edit', multiedit: 'edit', patch: 'edit', apply_patch: 'edit', notebookedit: 'edit',
  grep: 'search', glob: 'search', codesearch: 'search', lsp: 'search',
  webfetch: 'web', websearch: 'web',
  agent: 'agent', task: 'agent',
  todowrite: 'todo', todoread: 'todo',
}

/**
 * Which kind of call this is, and for MCP which server. Claude names an MCP tool
 * `mcp__<server>__<tool>`. opencode names it `<server>_<tool>`, which cannot be told from
 * a builtin with an underscore in its name, so it shows under its whole name with its arguments.
 */
export function identifyTool(toolCall: string): ToolIdentity {
  const claudeMcp = /^mcp__(.+?)__(.+)$/.exec(toolCall)
  if (claudeMcp) return { kind: 'mcp', server: claudeMcp[1], name: claudeMcp[2] }
  const builtin = BUILTIN_KINDS[toolCall.toLowerCase()]
  return builtin ? { kind: builtin, name: toolCall } : { kind: 'generic', name: toolCall }
}

function text(input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function firstLine(value: string): string {
  return value.split('\n').find((line) => line.trim())?.trim() ?? ''
}

/** Claude's `file_path` and opencode's `filePath`. */
function filePath(input: Record<string, unknown> | undefined): string | undefined {
  return text(input, 'file_path', 'filePath', 'path', 'notebook_path')
}

type Input = Record<string, unknown>

function searchSummary(input: Input): string {
  const pattern = text(input, 'pattern', 'query')
  const where = text(input, 'path', 'glob')
  return pattern ? (where ? `${pattern}  in ${where}` : pattern) : where ?? ''
}

function todoSummary(input: Input): string {
  const todos = input.todos
  return Array.isArray(todos) ? `${todos.length} item${todos.length === 1 ? '' : 's'}` : ''
}

const SUMMARIES: Partial<Record<ToolKind, (input: Input) => string>> = {
  bash: (input) => {
    const command = text(input, 'command')
    return command ? firstLine(command) : text(input, 'description') ?? ''
  },
  read: (input) => filePath(input) ?? '',
  write: (input) => filePath(input) ?? '',
  edit: (input) => filePath(input) ?? '',
  search: searchSummary,
  web: (input) => text(input, 'url', 'query') ?? '',
  agent: (input) => text(input, 'description') ?? firstLine(text(input, 'prompt') ?? ''),
  todo: todoSummary,
}

/** One line of what the call was about: the command, the file, the pattern, the URL, the arguments. */
export function summarizeTool(toolCall: string, input: Input | undefined): string {
  if (!input) return ''
  return (SUMMARIES[identifyTool(toolCall).kind] ?? argumentsSummary)(input)
}

/** `key: value` pairs for a call whose arguments are all there is to say. */
function argumentsSummary(input: Record<string, unknown>): string {
  return Object.entries(input)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? firstLine(value) : JSON.stringify(value)}`)
    .join(', ')
}

/** A line of an edit's diff: added, removed, unchanged context, or the gap between two hunks. */
export interface DiffLine {
  sign: '+' | '-' | ' ' | '…'
  text: string
}

/** A field's text as written: a replacement that is only whitespace is still a replacement. */
function rawText(input: Input, ...keys: string[]): string | undefined {
  return keys.map((key) => input[key]).find((value): value is string => typeof value === 'string')
}

/** Past this many cells the line diff gives up on alignment and shows old against new whole. */
const DIFF_CELLS_MAX = 250_000

function lcsTable(before: readonly string[], after: readonly string[]): Uint32Array {
  const width = after.length + 1
  const table = new Uint32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] = before[i] === after[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  return table
}

/**
 * The lines of `before` and `after` aligned, as a reader expects a diff: unchanged lines
 * as context, and only the lines that changed marked removed or added (removals first).
 */
export function lineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  if ((before.length + 1) * (after.length + 1) > DIFF_CELLS_MAX) {
    return [...before.map((text) => ({ sign: '-' as const, text })), ...after.map((text) => ({ sign: '+' as const, text }))]
  }
  const table = lcsTable(before, after)
  const width = after.length + 1
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      out.push({ sign: ' ', text: before[i] })
      i++
      j++
    } else if (j >= after.length || (i < before.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      out.push({ sign: '-', text: before[i] })
      i++
    } else {
      out.push({ sign: '+', text: after[j] })
      j++
    }
  }
  return out
}

function replacement(edit: Input): DiffLine[] {
  const before = rawText(edit, 'old_string', 'oldString')
  const after = rawText(edit, 'new_string', 'newString')
  if (before === undefined && after === undefined) return []
  const split = (value: string | undefined) => (value ? value.split('\n') : [])
  return lineDiff(split(before), split(after))
}

/** A unified patch's body lines (opencode's `patch`, `apply_patch`), headers and hunk marks dropped. */
function patchLines(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  // A file's `---`/`+++` header comes before its first hunk; inside one, `---` is a removed line.
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (/^(\*\*\* |diff |index )/.test(line)) {
      inHunk = false
      continue
    }
    if (line.startsWith('@@')) {
      if (out.length > 0) out.push({ sign: '…', text: '' })
      inHunk = true
      continue
    }
    if (!inHunk && /^(---|\+\+\+)( |$)/.test(line)) continue
    const sign = line[0]
    if (sign === '+' || sign === '-' || sign === ' ') out.push({ sign, text: line.slice(1) })
  }
  return out
}

/**
 * What an edit changed, as a line diff: the lines it kept as context, the ones it removed
 * and the ones it added. A MultiEdit's edits are separate hunks, with a gap between them.
 */
export function editDiff(input: Input | undefined): DiffLine[] | undefined {
  if (!input) return undefined
  const patch = rawText(input, 'patchText', 'patch', 'diff')
  if (patch) {
    const lines = patchLines(patch)
    if (lines.length > 0) return lines
  }
  const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [input]
  const hunks = edits.map(replacement).filter((hunk) => hunk.length > 0)
  const lines = hunks.flatMap((hunk, index) => (index === 0 ? hunk : [{ sign: '…' as const, text: '' }, ...hunk]))
  return lines.length > 0 ? lines : undefined
}

/** How many lines a diff adds and removes. */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.sign === '+') added++
    else if (line.sign === '-') removed++
  }
  return { added, removed }
}

/** The body a Write wrote, as its lines. */
export function writtenLines(input: Record<string, unknown> | undefined): string[] | undefined {
  const content = input && rawText(input, 'content')
  return content === undefined ? undefined : content.split('\n')
}

/** The first line number of what a Read returned: Claude's `offset` is a line number, opencode's counts from 0. */
export function readStartLine(toolCall: string, input: Record<string, unknown> | undefined): number {
  const offset = input?.offset
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) return 1
  return toolCall === 'Read' ? Math.max(1, Math.floor(offset)) : Math.floor(offset) + 1
}

/** True when the text already carries its own line numbers (opencode's read, `cat -n`), so the card adds none. */
export function hasOwnLineNumbers(lines: readonly string[]): boolean {
  const filled = lines.filter((line) => line.trim())
  if (filled.length < 2) return false
  const numbered = filled.filter((line) => /^\s*\d+(\||→|\t|: )/.test(line)).length
  return numbered / filled.length >= 0.8
}

/** A result that is JSON, laid out to be read; anything else as it came. */
export function readableOutput(output: string): { text: string; json: boolean } {
  const trimmed = output.trim()
  if (!/^[[{]/.test(trimmed)) return { text: output, json: false }
  try {
    return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true }
  } catch {
    return { text: output, json: false }
  }
}

/** The input as labelled fields for a call with no tailored view: every field, in order. */
export function inputFields(input: Record<string, unknown>): Array<{ label: string; value: string }> {
  return Object.entries(input).map(([label, value]) => ({
    label,
    value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }))
}

/**
 * A tool row with `detail` laid over what its `meta.tool` already holds: the input
 * a call is updated with, or the output and failure its result brings.
 */
export function withToolDetail(msg: Message, detail: Record<string, unknown>): Message {
  const current = isRecord(msg.meta?.tool) ? msg.meta.tool : {}
  return { ...msg, meta: { ...(msg.meta ?? {}), tool: { ...current, ...detail } } }
}
