import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { buildFoldSummary, ChatMessages, groupMessages, partitionForFold } from '../chat-messages'
import { finalAnswerIndices, isAnswerMessage } from '../final-answers'
import { turnSpacerClass } from '../turn-spacer'
import { reconcileCompletedTurnMessages } from '@/hooks/completed-turn-messages'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({ api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) } }))

const T0 = 1_780_000_000_000
const user = (id: string, content = 'go', at = 0): Message => ({ id, role: 'user', content, timestamp: T0 + at })
const think = (id: string, content: string, at: number): Message => ({ id, role: 'thinking', content, timestamp: T0 + at })
const prose = (id: string, content: string, at: number, meta?: Message['meta']): Message => ({ id, role: 'assistant', content, timestamp: T0 + at, ...(meta ? { meta } : {}) })
const tool = (id: string, name: string, at: number): Message => ({ id, role: 'assistant', content: `Used ${name}`, timestamp: T0 + at, toolCall: name })

function renderChat(messages: Message[], props: { loading?: boolean; streamingText?: string } = {}) {
  return render(
    <MemoryRouter>
      <ChatMessages messages={messages} loading={props.loading ?? false} streamingText={props.streamingText} />
    </MemoryRouter>,
  )
}

describe('thinking is never the answer', () => {
  it('is not an answer message, whatever it says', () => {
    expect(isAnswerMessage(think('k', 'The answer is 42.', 1))).toBe(false)
  })

  it('leaves the answer where it was when reasoning follows the last prose or comes before it', () => {
    const messages = [
      user('u'),
      think('k1', 'Plan.', 1_000),
      prose('a1', 'Working.', 2_000, { assistantPhase: 'commentary' }),
      think('k2', 'More thought.', 3_000),
      prose('a2', 'Finished.', 4_000, { assistantPhase: 'final' }),
      think('k3', 'After the answer.', 5_000),
    ]
    // Whatever follows the answer belongs to the next segment, as any trailing row does.
    expect(finalAnswerIndices(messages)).toEqual([-1, 4, 4, 4, 4, -1])
  })

  it('elects no answer for a turn that has reasoning and nothing else', () => {
    expect(finalAnswerIndices([user('u'), think('k', 'Hmm.', 1_000)])).toEqual([-1, -1])
  })

  it('does not count reasoning among the fold\'s updates, and folds it with the interim prose in order', () => {
    const messages = [
      user('u'),
      think('k1', 'Plan.', 1_000),
      prose('a1', 'Checking.', 2_000, { assistantPhase: 'commentary' }),
      think('k2', 'More.', 3_000),
      prose('a2', 'Done.', 4_000, { assistantPhase: 'final' }),
    ]
    const groups = partitionForFold(groupMessages(messages), messages, new Set(), null, new Set())
    const fold = groups.find((group) => group.kind === 'fold')
    expect(fold?.kind).toBe('fold')
    if (fold?.kind !== 'fold') return
    expect(fold.items.map((item) => item.kind === 'message' ? item.msg.id : item.kind)).toEqual(['k1', 'a1', 'k2'])
    expect(buildFoldSummary(fold.items, messages, 4).updates).toBe(1)
    const plain = groups.flatMap((group) => group.kind === 'plain' && group.item.kind === 'message' ? [group.item.msg.id] : [])
    expect(plain).toEqual(['u', 'a2'])
  })
})

describe('thinking and tool groups', () => {
  it('keeps a run of tool calls whole across reasoning between them, shown after the group in order', () => {
    const messages = [
      user('u'),
      tool('t1', 'Read', 1_000),
      think('k1', 'Next the tests.', 2_000),
      tool('t2', 'Grep', 3_000),
      think('k2', 'Now fix it.', 4_000),
      tool('t3', 'Edit', 5_000),
      think('k3', 'Writing the summary.', 6_000),
    ]
    const items = groupMessages(messages)
    expect(items.map((item) => item.kind === 'tool-group' ? `group:${item.msgs.map((m) => m.id).join('+')}` : item.kind === 'message' ? item.msg.id : item.kind))
      .toEqual(['u', 'group:t1+t2+t3', 'k1', 'k2', 'k3'])
  })

  it('does not take reasoning that nothing follows into the group, and puts it where the model wrote it', () => {
    const messages = [user('u'), tool('t1', 'Read', 1_000), think('k1', 'Hmm.', 2_000), prose('a', 'Text.', 3_000)]
    const items = groupMessages(messages)
    expect(items.map((item) => item.kind === 'tool-group' ? 'group' : item.kind === 'message' ? item.msg.id : item.kind)).toEqual(['u', 'group', 'k1', 'a'])
  })

  it('drops a block that holds nothing to read', () => {
    const items = groupMessages([user('u'), think('k1', '  \n', 1_000), tool('t1', 'Read', 2_000)])
    expect(items.map((item) => item.kind)).toEqual(['message', 'tool-group'])
  })
})

describe('thinking after a turn completes', () => {
  it('stays with the interim text, in order, ahead of the final answer', () => {
    const rows: Message[] = [
      user('u'),
      think('k1', 'Plan.', 1_000),
      { ...think('k2', 'Weighing it.', 2_000), partial: true },
      tool('t1', 'Read', 3_000),
    ]
    const next = reconcileCompletedTurnMessages({
      messages: rows,
      turnStart: 1,
      exactResult: 'Done.',
      finalMessage: prose('final', 'Done.', 4_000),
    })
    expect(next.map((m) => m.id)).toEqual(['u', 'k1', 'k2', 't1', 'final'])
    expect(next[2].partial).toBeUndefined()
    expect(next.at(-1)?.meta?.assistantPhase).toBe('final')
  })
})

describe('thinking spacing', () => {
  it('reads as the assistant: no speaker switch against prose, the usual headroom after the user', () => {
    expect(turnSpacerClass('thinking', 'assistant')).toBe(turnSpacerClass('assistant', 'assistant'))
    expect(turnSpacerClass('assistant', 'thinking')).toBe(turnSpacerClass('assistant', 'assistant'))
    expect(turnSpacerClass('user', 'thinking')).toBe(turnSpacerClass('user', 'assistant'))
  })
})

describe('the thinking row', () => {
  const rows = [user('u'), think('k1', 'First I check the config.\nThen the tests.', 1_000)]

  it('is a collapsed disclosure showing the first line, and opens to the whole text as written', () => {
    renderChat(rows)
    const toggle = screen.getByRole('button', { name: /Thought/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(toggle).getByText('First I check the config.')).toBeTruthy()
    expect(screen.queryByText(/Then the tests/)).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(panel?.textContent).toBe('First I check the config.\nThen the tests.')
    // The first line trails off in the button only while it is closed.
    expect(within(toggle).queryByText('First I check the config.')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows markdown as the model wrote it', () => {
    renderChat([user('u'), think('k1', '**bold** and `code`', 1_000)])
    fireEvent.click(screen.getByRole('button', { name: /Thought/ }))
    expect(screen.getByText('**bold** and `code`', { selector: '[id]' })).toBeTruthy()
    expect(document.querySelector('strong')).toBeNull()
  })

  it('says Thinking… while it is the block being written, and Thought once anything comes after it', () => {
    const { rerender } = renderChat(rows, { loading: true })
    expect(screen.getByRole('button', { name: /Thinking…/ })).toBeTruthy()
    // The running cue is the row itself: no second "Thinking" beside it.
    expect(screen.queryByText(/^Thinking$/)).toBeNull()

    rerender(<MemoryRouter><ChatMessages messages={rows} loading streamingText="Here is" /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /Thought/ })).toBeTruthy()

    rerender(<MemoryRouter><ChatMessages messages={[...rows, tool('t1', 'Read', 2_000)]} loading /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /Thought/ })).toBeTruthy()

    rerender(<MemoryRouter><ChatMessages messages={rows} loading={false} /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /Thought/ })).toBeTruthy()
  })

  it('keeps its open state when it is mounted again', () => {
    const first = renderChat(rows)
    fireEvent.click(screen.getByRole('button', { name: /Thought/ }))
    first.rerender(<MemoryRouter><ChatMessages messages={rows} loading={false} /></MemoryRouter>)
    expect(screen.getByRole('button', { name: /Thought/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('renders nothing for a block with no text', () => {
    renderChat([user('u'), think('k1', '   ', 1_000), prose('a', 'Hello.', 2_000, { assistantPhase: 'final' })])
    expect(screen.queryByRole('button', { name: /Thought/ })).toBeNull()
  })

  it('shows the generic running cue while the newest block holds nothing to read', () => {
    renderChat([user('u'), think('k1', '  ', 1_000)], { loading: true })
    expect(screen.getByText('Thinking')).toBeTruthy()
  })

  it('offers no copy or read-aloud of its own: the answer keeps the only ones', () => {
    renderChat([user('u'), think('k1', 'Plan the reply.', 1_000), prose('a', 'All done.', 2_000, { assistantPhase: 'final' })])
    fireEvent.click(screen.getByRole('button', { name: /show the work/i }))
    const row = screen.getByRole('button', { name: /Thought/ }).closest('[data-thinking-row]')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).queryByRole('button', { name: /read aloud|copy message/i })).toBeNull()
    expect(screen.getAllByRole('button', { name: /read aloud/i })).toHaveLength(1)
  })

  it('sits inside the fold with the interim text once the turn has its answer', () => {
    const messages = [user('u'), think('k1', 'Plan the reply.', 1_000), prose('a', 'All done.', 2_000, { assistantPhase: 'final' })]
    renderChat(messages)
    const answer = screen.getByText('All done.')
    expect(answer.closest('[data-fold-region]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /show the work/i }))
    expect(screen.getByRole('button', { name: /Thought/ }).closest('[data-fold-region]')).not.toBeNull()
  })
})
