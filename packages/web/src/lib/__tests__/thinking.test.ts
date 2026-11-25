import { describe, expect, it } from 'vitest'
import { applyThinkingChunk, carryLiveThinking } from '../thinking'
import type { Message } from '../conversations'

let counter = 0
const id = () => `n${++counter}`
const user: Message = { id: 'u', role: 'user', content: 'go', timestamp: 1 }
const stored = (rowId: string, content: string): Message => ({ id: rowId, role: 'thinking', content, timestamp: 2 })
const tool = (rowId: string): Message => ({ id: rowId, role: 'assistant', content: 'Used Read', timestamp: 3, toolCall: 'Read' })
const stream = (messages: Message[], block: string, ...chunks: string[]) =>
  chunks.reduce((rows, chunk) => applyThinkingChunk(rows, block, chunk, 9, id), messages)
const texts = (messages: Message[]) => messages.filter((m) => m.role === 'thinking').map((m) => m.content)

describe('carryLiveThinking', () => {
  it('does not repeat text when the stored and streamed text meet on whitespace', () => {
    const current = stream([user], 'b1', 'Let me think.\n')
    const merged = carryLiveThinking(current, [user, stored('k1', 'Let me think.\nNext')])
    expect(texts(merged)).toEqual(['Let me think.\nNext'])
    expect(texts(stream(merged, 'b1', 'Next', ' step'))).toEqual(['Let me think.\nNext step'])
  })

  it('keeps what the stream still owes across a second read before it catches up', () => {
    let rows = stream([user], 'b1', 'abc')
    rows = carryLiveThinking(rows, [user, stored('k1', 'abcdef')])
    rows = carryLiveThinking(rows, [user, stored('k2', 'abcdef')])
    expect(texts(stream(rows, 'b1', 'd', 'e', 'f', 'g'))).toEqual(['abcdefg'])
  })

  it('takes a later read that is further ahead into the debt', () => {
    let rows = stream([user], 'b1', 'abc')
    rows = carryLiveThinking(rows, [user, stored('k1', 'abcdef')])
    rows = carryLiveThinking(rows, [user, stored('k1', 'abcdefgh')])
    expect(texts(stream(rows, 'b1', 'def', 'gh', 'i'))).toEqual(['abcdefghi'])
  })

  it('leaves an earlier block alone when a stale read lacks the live one, even if the live text starts like it', () => {
    const earlier = stored('k1', 'Let me look at the file.')
    const current = stream([user, { ...earlier, meta: { thinkingBlock: 'b1' } }, tool('t1')], 'b2', 'Let')
    const merged = carryLiveThinking(current, [user, earlier, tool('t1')])
    expect(merged.map((m) => `${m.role}:${m.content}`)).toEqual(['user:go', 'thinking:Let me look at the file.', 'assistant:Used Read', 'thinking:Let'])
    expect(texts(stream(merged, 'b2', ' me', ' go'))).toEqual(['Let me look at the file.', 'Let me go'])
  })

  it('does not overwrite an earlier block that the live text extends', () => {
    const earlier = stored('k1', 'Okay.')
    const current = stream([user, { ...earlier, meta: { thinkingBlock: 'b1' } }, tool('t1')], 'b2', 'Okay. Now I will read the other file.')
    const merged = carryLiveThinking(current, [user, earlier, tool('t1')])
    expect(texts(merged)).toEqual(['Okay.', 'Okay. Now I will read the other file.'])
    expect(merged.at(-1)?.role).toBe('thinking')
  })

  it('finds its stored copy after a tool call that finished between the stream and the read', () => {
    const running: Message = { id: 'live-t', role: 'assistant', content: 'Using Read', timestamp: 3, toolCall: 'Read', toolId: 'call-1' }
    const done: Message = { id: 't1', role: 'assistant', content: 'Used Read', timestamp: 3, toolCall: 'Read', toolId: 'call-1' }
    const current = stream([user, running], 'b2', 'Plan')
    const merged = carryLiveThinking(current, [user, done, stored('k2', 'Plan the work')])
    expect(texts(merged)).toEqual(['Plan the work'])
  })

  it('does not take a copy that follows a different call of the same tool', () => {
    const first: Message = { id: 't1', role: 'assistant', content: 'Used Read', timestamp: 3, toolCall: 'Read', toolId: 'call-1' }
    const second: Message = { id: 't2', role: 'assistant', content: 'Used Read', timestamp: 4, toolCall: 'Read', toolId: 'call-2' }
    const current = stream([user, first, stored('k1', 'Plan'), second], 'b3', 'Plan')
    const merged = carryLiveThinking(current, [user, first, stored('k1', 'Plan'), second])
    expect(texts(merged)).toEqual(['Plan', 'Plan'])
  })

  it('still finds its stored copy after the same row, with newer rows beyond it', () => {
    const current = stream([user, tool('t1')], 'b2', 'Plan')
    const merged = carryLiveThinking(current, [user, tool('t1'), stored('k2', 'Plan the work'), tool('t2')])
    expect(texts(merged)).toEqual(['Plan the work'])
    expect(merged.map((m) => m.id)).toEqual(['u', 't1', current.at(-1)?.id, 't2'])
  })
})
