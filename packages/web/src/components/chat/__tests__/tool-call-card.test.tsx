import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatMessages } from '../chat-messages'
import type { OpenSubagentCard } from '../tool-group'
import type { Message } from '@/lib/conversations'

/** The tool chip's card: what the call was about at a glance, and its input and result once opened. */

function renderChat(messages: Message[], onOpenSubagent?: OpenSubagentCard, loading = false) {
  return render(
    <MemoryRouter>
      <ChatMessages messages={messages} loading={loading} onOpenSubagent={onOpenSubagent} />
    </MemoryRouter>,
  )
}

const answer: Message = { id: 'answer', role: 'assistant', content: 'Done.', timestamp: 200 }

function toolRow(id: string, toolCall: string, tool: Record<string, unknown> | undefined, content = `Used ${toolCall}`, extra: Record<string, unknown> = {}): Message {
  return { id, role: 'assistant', content, timestamp: 100, toolCall, meta: { ...(tool ? { tool } : {}), ...extra } }
}

/** The work starts folded behind the answer, and its tool group behind a pill. */
function openGroup(count = 1) {
  fireEvent.click(screen.getByRole('button', { name: /show the work/i }))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${count} tools?$`, 'i') }))
}

describe('a tool call with detail', () => {
  it('shows what a Bash call ran on its chip and the command and result once opened', () => {
    renderChat([toolRow('t1', 'Bash', { input: { command: 'ls -la', description: 'list files' }, output: 'a.txt\nb.txt' }), answer])
    openGroup()

    expect(screen.getByTestId('tool-summary').textContent).toBe('ls -la')
    expect(screen.queryByTestId('tool-call-card')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /show the bash call/i }))
    const card = screen.getByTestId('tool-call-card')
    expect(within(card).getByTestId('tool-input-command').textContent).toContain('$ ls -la')
    expect(within(card).getByText('list files')).toBeTruthy()
    expect(within(card).getByTestId('tool-output').textContent).toContain('a.txt')

    fireEvent.click(screen.getByRole('button', { name: /hide the bash call/i }))
    expect(screen.queryByTestId('tool-call-card')).toBeNull()
  })

  it('draws an Edit as a diff of the lines it replaced', () => {
    renderChat([toolRow('t1', 'Edit', { input: { file_path: '/src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' } }), answer])
    openGroup()
    expect(screen.getByTestId('tool-summary').textContent).toBe('/src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: /show the edit call/i }))
    const diff = screen.getByTestId('tool-input-diff')
    expect(diff.querySelector('[data-diff="-"]')?.textContent).toBe('-const a = 1')
    expect(diff.querySelector('[data-diff="+"]')?.textContent).toBe('+const a = 2')
    expect(screen.queryByText('No output')).toBeNull()
  })

  it('titles an MCP call by its server and tool and lists its arguments', () => {
    renderChat([toolRow('t1', 'mcp__hundredfold__get_work_item', { input: { id: 'TASK-1' }, output: '{"ok":true}' }), answer])
    openGroup()
    expect(screen.getByText('hundredfold › get_work_item')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /show the mcp__hundredfold__get_work_item call/i }))
    expect(within(screen.getByTestId('tool-input-fields')).getByText('id')).toBeTruthy()
    expect(screen.getByTestId('tool-input-id').textContent).toBe('TASK-1')
  })

  it('marks a failed call and labels its text as the error', () => {
    renderChat([toolRow('t1', 'Read', { input: { file_path: '/nope' }, output: 'File does not exist.', isError: true }), answer])
    openGroup()
    expect(screen.getByLabelText('Failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /show the read call/i }))
    expect(screen.getByText('Error')).toBeTruthy()
  })

  it('shows a running call with its input and no result yet', () => {
    renderChat([
      { id: 'u', role: 'user', content: 'go', timestamp: 50 },
      toolRow('t1', 'Bash', { input: { command: 'sleep 30' } }, 'Using Bash'),
    ], undefined, true)
    fireEvent.click(screen.getByRole('button', { name: /1 tool running/i }))
    expect(screen.getByLabelText('Running')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /show the bash call/i }))
    expect(screen.getByText('Running…')).toBeTruthy()
  })

  it('says when the gateway cut the input or the result, and offers the rest of a long result', () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    renderChat([toolRow('t1', 'Bash', { input: { command: 'cat big' }, inputTruncated: true, output, outputChars: 90_000 }), answer])
    openGroup()
    fireEvent.click(screen.getByRole('button', { name: /show the bash call/i }))
    expect(screen.getByTestId('tool-input-cut')).toBeTruthy()
    expect(screen.getByTestId('tool-output-cut').textContent).toContain('90000')
    const shown = () => screen.getByTestId('tool-output').querySelector('pre')!.textContent!.split('\n').length
    expect(shown()).toBe(12)
    fireEvent.click(screen.getByRole('button', { name: /show all 30 lines/i }))
    expect(shown()).toBe(30)
  })

  it('keeps an Agent card opening its transcript, with the call detail on a toggle beside it', () => {
    const onOpenSubagent = vi.fn()
    renderChat([toolRow('t1', 'Agent', { input: { description: 'scan the repo', prompt: 'look' } }, 'Used Agent', { agentId: 'agent-7' }), answer], onOpenSubagent)
    openGroup()
    fireEvent.click(screen.getByRole('button', { name: /Agent sub-agent transcript/i }))
    expect(onOpenSubagent).toHaveBeenCalledOnce()
    expect(screen.getByTestId('tool-summary').textContent).toBe('scan the repo')
    fireEvent.click(screen.getByRole('button', { name: /show the agent call/i }))
    expect(screen.getByTestId('tool-input-prompt').textContent).toBe('look')
  })
})

describe('a tool call stored before calls carried detail', () => {
  it('draws as its plain name with nothing to open', () => {
    renderChat([toolRow('t1', 'Bash', undefined), answer])
    openGroup()
    const group = screen.getByTestId('tool-group-list')
    expect(within(group).getByText('Bash')).toBeTruthy()
    expect(within(group).queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('tool-summary')).toBeNull()
  })
})
