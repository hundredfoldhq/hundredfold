import "@/test/preload-menus"
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AccountHeadroom, AccountPick } from '@hundredfold/fallback-chain-wire'
import { FallbackModeChip } from '../fallback-mode-chip'
import type { SessionFallbackView } from '../fallback-mode-model'

vi.mock('@/lib/api', () => ({ api: { updateSession: vi.fn(), getSession: vi.fn() } }))

/* The session chip for a session pinned to an opencode account, and to a remote Claude login: the
 * gateway's labels read as sent, and where it sent none the key is made readable. */

const room = (account: string, label: string | undefined, over: Partial<AccountHeadroom> = {}): AccountHeadroom =>
  ({ account, label, state: 'fresh', headroomPercent: 60, weight: 60, sharePercent: 60, ...over }) as AccountHeadroom

const view = (pick: AccountPick): SessionFallbackView => ({
  mode: 'fallback',
  modeSource: 'default',
  target: { engine: 'opencode', account: 'go-b', label: 'opencode go-b' },
  chain: { source: 'engine', links: [], position: 0, servedBy: null, next: null, hops: [], pick },
})

const open = () => fireEvent.keyDown(screen.getByTestId('fallback-mode-chip'), { key: 'Enter' })

describe('the session chip with an opencode pick', () => {
  const pick: AccountPick = {
    at: '2026-11-22T14:02:00', trigger: 'start', source: 'engine', groupIndex: 0, picked: 'opencode/opencode-go-b', reason: 'weighted',
    candidates: [room('opencode/opencode-go-b', undefined), room('opencode/opencode-go', 'go-a', { headroomPercent: 40, weight: 40, sharePercent: 40 })],
  }

  it('names the account from its key when the gateway sent no label, and the others by theirs', () => {
    render(<FallbackModeChip sessionId="s1" view={view(pick)} />)
    open()

    expect(screen.getByTestId('account-pick-account').textContent).toBe('Pinned to opencode · opencode-go-b')
    const rows = Array.from(screen.getByTestId('account-pick-candidates').querySelectorAll('li')).map((li) => li.textContent)
    expect(rows).toEqual(['opencode · opencode-go-bheadroom 60% · share 60%', 'go-aheadroom 40% · share 40%'])
  })

  it('reads a switch as a switch to opencode', () => {
    render(<FallbackModeChip sessionId="s1" view={view({ ...pick, trigger: 'switch' })} />)
    open()

    expect(screen.getByTestId('account-pick-when').textContent).toMatch(/^On a switch to opencode, /)
  })
})

describe('the session chip with a remote Claude pick', () => {
  it('reads the host\'s logins by profile and host', () => {
    const remote: AccountPick = {
      at: '2026-11-22T14:02:00', trigger: 'start', source: 'employee', groupIndex: 0, picked: 'claude@ops@build:spare', reason: 'weighted',
      candidates: [room('claude@ops@build:spare', undefined), room('claude@ops@build', undefined, { headroomPercent: 40, weight: 40, sharePercent: 40 })],
    }
    render(<FallbackModeChip sessionId="s1" view={view(remote)} />)
    open()

    expect(screen.getByTestId('account-pick-account').textContent).toBe('Pinned to spare (ops@build)')
    expect(screen.getByTestId('account-pick-when').textContent).toMatch(/^At session start, /)
  })
})
