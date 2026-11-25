import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatMessages } from '../chat-messages'
import type { OpenSubagentCard } from '../tool-group'
import type { Message } from '@/lib/conversations'
import { api } from '@/lib/api'
import { FileLinkSessionContext } from '../file-link-session-context'

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

  it('draws an Edit as a diff under its file, marking only the lines that changed', () => {
    renderChat([toolRow('t1', 'Edit', { input: { file_path: '/src/a.ts', old_string: 'const a = 1\nexport { a }', new_string: 'const a = 2\nexport { a }' } }), answer])
    openGroup()
    expect(screen.getByTestId('tool-summary').textContent).toBe('/src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: /show the edit call/i }))
    const card = screen.getByTestId('tool-call-card')
    expect(within(card).getByText('/src/a.ts')).toBeTruthy()
    expect(within(card).getByText('+1')).toBeTruthy()
    expect(within(card).getByText('−1')).toBeTruthy()
    const diff = screen.getByTestId('tool-input-diff')
    const row = (sign: string) => diff.querySelector(`[data-diff="${sign}"] > span:last-child`)?.textContent
    expect(row('-')).toBe('removed: const a = 1')
    expect(row('+')).toBe('added: const a = 2')
    expect(row(' ')).toBe('export { a }')
    expect(screen.queryByText('No output')).toBeNull()
  })

  it("draws an edit whose result is numbered hunks from that result, numbered as the file is, and does not repeat it", () => {
    const patch = '@@ -20,3 +20,3 @@\n before\n-const a = 1\n+const a = 2\n after'
    renderChat([toolRow('t1', 'Edit', { input: { file_path: '/src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' }, output: patch }), answer])
    openGroup()
    fireEvent.click(screen.getByRole('button', { name: /show the edit call/i }))
    const diff = screen.getByTestId('tool-input-diff')
    const numbers = [...diff.querySelectorAll('[data-testid="tool-diff-line-number"]')].map((cell) => cell.textContent)
    expect(numbers).toEqual(['20', '21', '21', '22'])
    expect(diff.querySelector('[data-diff=" "] > span:last-child')?.textContent).toBe('before')
    expect(screen.queryByTestId('tool-output')).toBeNull()
  })

  it('leaves an edit unnumbered when its result is not a patch', () => {
    renderChat([toolRow('t1', 'Edit', { input: { file_path: '/src/a.ts', old_string: 'x', new_string: 'y' } }), answer])
    openGroup()
    fireEvent.click(screen.getByRole('button', { name: /show the edit call/i }))
    expect(screen.queryAllByTestId('tool-diff-line-number')).toHaveLength(0)
  })

  it("does not repeat an edit tool's success message under its diff", () => {
    renderChat([toolRow('t1', 'edit', { input: { filePath: '/a', oldString: 'x', newString: 'y' }, output: 'Edit applied successfully.' }), answer])
    openGroup()
    fireEvent.click(screen.getByRole('button', { name: /show the edit call/i }))
    expect(screen.queryByTestId('tool-output')).toBeNull()
  })

  it('numbers the lines a Read returned from where it started, under the file it read', () => {
    renderChat([toolRow('t1', 'Read', { input: { file_path: '/src/a.ts', offset: 10 }, output: 'one\ntwo' }), answer])
    openGroup()
    fireEvent.click(screen.getByRole('button', { name: /show the read call/i }))
    const out = screen.getByTestId('tool-output')
    expect(within(out).getByText('/src/a.ts')).toBeTruthy()
    expect(within(out).getByText('10')).toBeTruthy()
    expect(within(out).getByText('11')).toBeTruthy()
    expect(screen.queryByTestId('tool-input')).toBeNull()
  })

  it('titles an MCP call by its server and tool, lists its arguments and lays out a JSON result', () => {
    renderChat([toolRow('t1', 'mcp__hundredfold__get_work_item', { input: { id: 'TASK-1' }, output: '{"ok":true}' }), answer])
    openGroup()
    expect(screen.getByText('hundredfold › get_work_item')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /show the mcp__hundredfold__get_work_item call/i }))
    expect(within(screen.getByTestId('tool-input-fields')).getByText('id')).toBeTruthy()
    expect(screen.getByTestId('tool-input-id').textContent).toBe('TASK-1')
    expect(within(screen.getByTestId('tool-output')).getByText('JSON')).toBeTruthy()
    expect(screen.getByTestId('tool-output-text').textContent).toContain('"ok": true')
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

  it('says Running, not No output, for an unfinished call that is not the newest one', () => {
    renderChat([
      { id: 'u', role: 'user', content: 'go', timestamp: 50 },
      toolRow('t1', 'Bash', { input: { command: 'sleep 30; echo A' } }, 'Using Bash'),
      toolRow('t2', 'Bash', { input: { command: 'sleep 30; echo B' } }, 'Using Bash'),
    ], undefined, true)
    fireEvent.click(screen.getByRole('button', { name: /2 tools running/i }))
    expect(screen.getAllByLabelText('Running')).toHaveLength(1)
    fireEvent.click(screen.getAllByRole('button', { name: /show the bash call/i })[0])
    expect(screen.getByText('Running…')).toBeTruthy()
    expect(screen.queryByText('No output')).toBeNull()
  })

  it('says when the gateway cut the input or the result, and folds a long result', () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    renderChat([toolRow('t1', 'Bash', { input: { command: 'cat big' }, inputTruncated: true, output, outputChars: 90_000 }), answer])
    openGroup()
    fireEvent.click(screen.getByRole('button', { name: /show the bash call/i }))
    expect(screen.getByTestId('tool-output-cut').textContent).toContain('90,000')
    // Nothing was kept to fetch, so nothing is offered.
    expect(screen.queryByRole('button', { name: /load full/i })).toBeNull()
    const shown = () => screen.getByTestId('tool-output-text').querySelectorAll('pre > span').length
    expect(shown()).toBe(14)
    fireEvent.click(screen.getByRole('button', { name: /show 16 more lines/i }))
    expect(shown()).toBe(30)
  })

  it('fetches the whole of a cut call the gateway kept, and shows it in place', async () => {
    const getToolDetail = vi.spyOn(api, 'getToolDetail').mockResolvedValue({ input: { command: 'cat big' }, output: 'all of it' })
    render(
      <MemoryRouter>
        <FileLinkSessionContext.Provider value="s-1">
          <ChatMessages
            messages={[{ ...toolRow('t1', 'Bash', { input: { command: 'cat big' }, output: 'part…', outputChars: 90_000, full: true }), toolId: 'call-1' }, answer]}
            loading={false}
          />
        </FileLinkSessionContext.Provider>
      </MemoryRouter>,
    )
    openGroup()
    fireEvent.click(screen.getByRole('button', { name: /show the bash call/i }))
    fireEvent.click(screen.getByRole('button', { name: /load full output · 90,000 characters/i }))
    await waitFor(() => expect(screen.getByTestId('tool-output-text').textContent).toBe('all of it'))
    expect(getToolDetail).toHaveBeenCalledWith('s-1', 'call-1')
    expect(screen.queryByTestId('tool-cut')).toBeNull()
    getToolDetail.mockRestore()
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
