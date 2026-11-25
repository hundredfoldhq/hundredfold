import { useState, type ReactNode } from 'react'
import type { ToolDetailView } from '@/lib/tool-summary'
import {
  editDiff,
  identifyTool,
  inputFields,
  writtenLines,
  type DiffLine,
} from '@/lib/tool-summary'
import { cn } from '@/lib/utils'

/** Lines of output or diff a card shows before "Show all". */
const PREVIEW_LINES = 12

const MONO = 'font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)] leading-[1.5]'
const PANEL = 'overflow-x-auto rounded-md bg-[var(--fill-quaternary)] px-2.5 py-1.5 whitespace-pre-wrap break-words'

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[length:var(--text-caption2)] font-[var(--weight-medium)] uppercase tracking-wide text-[var(--text-quaternary)]">{label}</span>
      {children}
    </div>
  )
}

/** A block of lines cut to a preview, with the rest a click away. */
function Lines({ lines, testId, children }: { lines: readonly string[]; testId: string; children: (shown: readonly string[]) => ReactNode }) {
  const [all, setAll] = useState(false)
  const hidden = all ? 0 : Math.max(0, lines.length - PREVIEW_LINES)
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col items-start gap-1">
      {children(all ? lines : lines.slice(0, PREVIEW_LINES))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="cursor-pointer border-none bg-transparent p-0 text-[length:var(--text-caption2)] font-[var(--weight-medium)] text-[var(--accent)]"
        >
          Show all {lines.length} lines
        </button>
      )}
    </div>
  )
}

function Diff({ lines, testId }: { lines: DiffLine[]; testId: string }) {
  return (
    <Lines lines={lines.map((line) => line.text)} testId={testId}>
      {(shown) => (
        <pre className={cn(PANEL, MONO, 'm-0 w-full')}>
          {lines.slice(0, shown.length).map((line, index) => (
            <span
              key={index}
              data-diff={line.sign}
              className={cn('block', line.sign === '+' && 'text-[var(--system-green)]', line.sign === '-' && 'text-[var(--system-red)]')}
            >
              {line.sign}{line.text}
            </span>
          ))}
        </pre>
      )}
    </Lines>
  )
}

function Text({ value, testId }: { value: string; testId: string }) {
  return (
    <Lines lines={value.split('\n')} testId={testId}>
      {(shown) => <pre className={cn(PANEL, MONO, 'm-0 w-full text-[var(--text-secondary)]')}>{shown.join('\n')}</pre>}
    </Lines>
  )
}

/** The input, drawn for the kind of call it belongs to. */
function InputView({ toolCall, input }: { toolCall: string; input: Record<string, unknown> }) {
  const { kind } = identifyTool(toolCall)
  const command = typeof input.command === 'string' ? input.command : undefined
  if (kind === 'bash' && command) {
    const description = typeof input.description === 'string' ? input.description : undefined
    return (
      <>
        <Text value={`$ ${command}`} testId="tool-input-command" />
        {description && <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{description}</span>}
      </>
    )
  }
  if (kind === 'edit') {
    const diff = editDiff(input)
    if (diff) return <Diff lines={diff} testId="tool-input-diff" />
  }
  if (kind === 'write') {
    const written = writtenLines(input)
    if (written) return <Diff lines={written} testId="tool-input-diff" />
  }
  const fields = inputFields(input).filter(({ label }) => !(kind === 'edit' && /^(old|new)_?string$/i.test(label)))
  return (
    <dl className="m-0 flex min-w-0 flex-col gap-1" data-testid="tool-input-fields">
      {fields.map(({ label, value }) => (
        <div key={label} className="flex min-w-0 flex-col">
          <dt className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">{label}</dt>
          <dd className="m-0"><Text value={value} testId={`tool-input-${label}`} /></dd>
        </div>
      ))}
    </dl>
  )
}


function ResultView({ toolCall, detail, running }: { toolCall: string; detail: ToolDetailView; running: boolean }) {
  const { kind } = identifyTool(toolCall)
  if (detail.output) {
    return (
      <Section label={detail.isError ? 'Error' : 'Result'}>
        <Text value={detail.output} testId="tool-output" />
        {detail.outputChars !== undefined && (
          <span data-testid="tool-output-cut" className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
            Shortened: showing the first {detail.output.length - 1} of {detail.outputChars} characters
          </span>
        )}
      </Section>
    )
  }
  // An edit or a write answers with nothing worth showing: its diff above is the result.
  if (!running && !detail.isError && (kind === 'edit' || kind === 'write')) return null
  return (
    <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
      {running ? 'Running…' : detail.isError ? 'Failed' : 'No output'}
    </span>
  )
}

/**
 * What a tool call did: the input it was called with and what came back. Drawn under
 * the call's chip once the reader opens it. The gateway bounds both (a file's body or
 * a long log is cut), and this says so rather than passing a cut text off as the whole.
 */
export function ToolCallCard({ toolCall, detail, running }: { toolCall: string; detail: ToolDetailView; running: boolean }) {
  const cutInput = detail.inputTruncated === true
  return (
    <div
      data-testid="tool-call-card"
      className="mt-1 ml-6 flex min-w-0 max-w-[min(620px,calc(100vw_-_var(--space-10)))] flex-col gap-2 pb-1"
    >
      {detail.input && (
        <Section label="Input">
          <InputView toolCall={toolCall} input={detail.input} />
          {cutInput && <span data-testid="tool-input-cut" className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">Long input shortened</span>}
        </Section>
      )}
      <ResultView toolCall={toolCall} detail={detail} running={running} />
    </div>
  )
}
