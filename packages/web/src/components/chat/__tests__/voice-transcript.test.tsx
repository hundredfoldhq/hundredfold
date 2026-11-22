import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import type { Message } from '@/lib/conversations'
vi.mock('@/lib/api', () => ({ api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) } }))

const T0 = 1_780_000_000_000

function row(id: string): HTMLElement {
  const el = document.querySelector(`[data-message-id="${id}"]`)
  if (!el) throw new Error(`no row ${id}`)
  return el as HTMLElement
}

const REPLY = 'I found the bug. It is in the config loader. I fixed it and ran the tests. All of them pass.'

function thread(extra: Partial<Message>[] = []): Message[] {
  return [
    { id: 'ask', role: 'user', content: 'What went wrong?', timestamp: T0, ...extra[0] },
    { id: 'answer', role: 'assistant', content: REPLY, timestamp: T0 + 1000, meta: { assistantPhase: 'final', turnOutcome: 'complete' }, ...extra[1] },
  ]
}

describe('voice marks in the transcript', () => {
  it('marks a spoken user message with a mic, and a typed one with nothing', () => {
    const messages = thread([{ meta: { voice: { utteranceId: 'u1', sttProvider: 'local', audioMs: 1800 } } }])
    messages.push({ id: 'typed', role: 'user', content: 'typed one', timestamp: T0 + 2000 })
    render(<ChatMessages messages={messages} loading={false} />)
    expect(row('ask').querySelector('[data-voice-mark]')).not.toBeNull()
    expect(row('typed').querySelector('[data-voice-mark]')).toBeNull()
  })

  it('reads the time to first audio on the reply that has it', () => {
    const messages = thread([{}, { meta: { assistantPhase: 'final', turnOutcome: 'complete', voice: { ttfaMs: 820 } } }])
    render(<ChatMessages messages={messages} loading={false} />)
    expect(row('answer').querySelector('[data-voice-ttfa]')?.textContent).toBe('First audio in 820 ms')
    expect(row('ask').querySelector('[data-voice-ttfa]')).toBeNull()
  })

  it('sets the unheard part of an interrupted reply apart, dimmed and labelled', () => {
    const messages = thread([{}, { meta: { assistantPhase: 'final', turnOutcome: 'complete', voice: { interrupted: true, spokenText: 'I found the bug. It is in the config loader.' } } }])
    render(<ChatMessages messages={messages} loading={false} />)
    const answer = row('answer')
    const tail = answer.querySelector('[data-voice-unheard]')
    expect(tail).not.toBeNull()
    expect(tail?.textContent).toContain('not spoken')
    expect(tail?.textContent).toContain('I fixed it and ran the tests. All of them pass.')
    expect(tail?.textContent).not.toContain('I found the bug')
    expect(answer.textContent).toContain('I found the bug. It is in the config loader.')
    expect(tail?.querySelector('.opacity-55')).not.toBeNull()
  })

  it('shows the whole reply undimmed when it was heard in full', () => {
    const messages = thread([{}, { meta: { assistantPhase: 'final', turnOutcome: 'complete', voice: { interrupted: false, spokenText: REPLY, ttfaMs: 1500 } } }])
    render(<ChatMessages messages={messages} loading={false} />)
    expect(row('answer').querySelector('[data-voice-unheard]')).toBeNull()
    expect(row('answer').textContent).toContain(REPLY)
    expect(row('answer').querySelector('[data-voice-ttfa]')?.textContent).toBe('First audio in 1.5 s')
  })

  it('an interrupted reply whose text cannot be matched is shown whole, not guessed at', () => {
    const messages = thread([{}, { meta: { assistantPhase: 'final', turnOutcome: 'complete', voice: { interrupted: true, spokenText: 'completely unrelated words nobody wrote' } } }])
    render(<ChatMessages messages={messages} loading={false} />)
    expect(row('answer').querySelector('[data-voice-unheard]')).toBeNull()
    expect(row('answer').textContent).toContain(REPLY)
  })

  it('a message with no voice facts renders exactly as before', () => {
    const { container } = render(<ChatMessages messages={thread()} loading={false} />)
    expect(container.querySelector('[data-voice-mark], [data-voice-ttfa], [data-voice-unheard]')).toBeNull()
  })
})
