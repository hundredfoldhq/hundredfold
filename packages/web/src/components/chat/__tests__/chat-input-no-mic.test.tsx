import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatInput } from '../chat-input'

vi.mock('@/hooks/use-employees', () => { const data = { employees: [] }; return { useOrg: () => ({ data }) } })
vi.mock('@/hooks/use-skills', () => { const data: never[] = []; const refetch = vi.fn(); return { useSkills: () => ({ data, refetch }) } })

describe('composer toolbar', () => {
  it('has no hold-to-talk dictation mic', () => {
    render(
      <ChatInput
        sessionId="s1"
        disabled={false}
        loading={false}
        onSend={vi.fn()}
        onNewSession={vi.fn()}
        onStatusRequest={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /voice input/i })).toBeNull()
    expect(screen.queryByTitle(/hold to talk/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /transcri/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy()
  })
})
