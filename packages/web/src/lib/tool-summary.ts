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
  }
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

/** A line of an edit's diff. */
export interface DiffLine {
  sign: '+' | '-' | ' '
  text: string
}

function replacement(edit: Input): DiffLine[] {
  const before = text(edit, 'old_string', 'oldString')
  const after = text(edit, 'new_string', 'newString')
  if (before === undefined && after === undefined) return []
  return [
    ...(before ?? '').split('\n').map((line) => ({ sign: '-' as const, text: line })),
    ...(after ?? '').split('\n').map((line) => ({ sign: '+' as const, text: line })),
  ]
}

/** What an edit replaced, as a diff of old lines against new ones: every old line removed, every new line added. */
export function editDiff(input: Input | undefined): DiffLine[] | undefined {
  if (!input) return undefined
  const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [input]
  const lines = edits.flatMap(replacement)
  return lines.length > 0 ? lines : undefined
}

/** The body a Write wrote: the lines the card shows, as additions. */
export function writtenLines(input: Record<string, unknown> | undefined): DiffLine[] | undefined {
  const content = text(input, 'content')
  return content === undefined ? undefined : content.split('\n').map((line) => ({ sign: '+' as const, text: line }))
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
