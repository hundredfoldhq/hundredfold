import "@/test/preload-menus"
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AccountHeadroom, AccountPick } from '@hundredfold/fallback-chain-wire'
import { FallbackModeChip } from '../fallback-mode-chip'
import type { SessionFallbackView } from '../fallback-mode-model'

vi.mock('@/lib/api', () => ({ api: { updateSession: vi.fn(), getSession: vi.fn() } }))

const room = (account: string, label: string, over: Partial<AccountHeadroom> = {}): AccountHeadroom =>
  ({ account, label, state: 'fresh', headroomPercent: 60, weight: 60, sharePercent: 60, ...over })

const PICK: AccountPick = {
  at: '2026-11-22T14:02:00',
  trigger: 'start',
  source: 'engine',
  groupIndex: 0,
  picked: 'claude:spare',
  reason: 'weighted',
  candidates: [room('claude:spare', 'spare'), room('claude:work', 'work', { headroomPercent: 40, weight: 40, sharePercent: 40 })],
}

const view = (pick?: AccountPick): SessionFallbackView => ({
  mode: 'fallback',
  modeSource: 'default',
  target: { engine: 'claude', account: 'work', label: 'Claude work' },
  chain: { source: 'engine', links: [], position: 0, servedBy: null, next: null, hops: [], ...(pick ? { pick } : {}) },
})

const open = () => fireEvent.keyDown(screen.getByTestId('fallback-mode-chip'), { key: 'Enter' })

describe('the session chip with an account pick', () => {
  it('says which account the session is pinned to and why, with each account\'s headroom and share', () => {
    render(<FallbackModeChip sessionId="s1" view={view(PICK)} />)
    open()

    expect(screen.getByTestId('account-pick-account').textContent).toBe('Pinned to spare')
    expect(screen.getByTestId('account-pick-reason').textContent).toBe('Picked spare: share 60% (headroom 60%) vs work 40% (headroom 40%)')
    expect(screen.getByTestId('account-pick-when').textContent).toMatch(/^At session start, /)
    const rows = screen.getByTestId('account-pick-candidates').querySelectorAll('li')
    expect(Array.from(rows).map((li) => li.textContent)).toEqual(['spareheadroom 60% · share 60%', 'workheadroom 40% · share 40%'])
    expect(rows[0].getAttribute('data-picked')).toBe('true')
  })

  it('does not call it "most headroom"', () => {
    render(<FallbackModeChip sessionId="s1" view={view(PICK)} />)
    open()

    expect(document.body.textContent?.toLowerCase()).not.toContain('most headroom')
  })

  it('puts the reason in the chip\'s tooltip', () => {
    render(<FallbackModeChip sessionId="s1" view={view(PICK)} />)

    expect(screen.getByTestId('fallback-mode-chip').getAttribute('title')).toContain('Picked spare: share 60% (headroom 60%) vs work 40% (headroom 40%)')
  })

  it('reads a switch pick as such', () => {
    render(<FallbackModeChip sessionId="s1" view={view({ ...PICK, trigger: 'switch' })} />)
    open()

    expect(screen.getByTestId('account-pick-when').textContent).toMatch(/^On a switch to Claude, /)
  })

  it('renders for a scoped viewer from the accounts, their states and the reason, with no percentages', () => {
    const scoped: AccountPick = {
      ...PICK,
      candidates: [{ account: 'claude:spare', label: 'spare', state: 'fresh' }, { account: 'claude:work', label: 'work', state: 'stale' }] as AccountHeadroom[],
    }
    render(<FallbackModeChip sessionId="s1" view={view(scoped)} />)
    open()

    expect(screen.getByTestId('account-pick-reason').textContent).toBe('Picked spare, weighted by headroom against work (stale reading)')
    expect(screen.getByTestId('account-pick').textContent).not.toMatch(/\d%|NaN|undefined/)
    expect(screen.getByTestId('account-pick-candidates').textContent).toContain('stale reading')
  })

  it('says the only candidate and the empty cases in words', () => {
    const only: AccountPick = { ...PICK, reason: 'only-candidate', candidates: [room('claude:spare', 'spare', { sharePercent: 100 })] }
    render(<FallbackModeChip sessionId="s1" view={view(only)} />)
    open()

    expect(screen.getByTestId('account-pick-reason').textContent).toContain('the only account')
    expect(screen.queryByTestId('account-pick-candidates')).toBeNull()
  })

  it('shows nothing about an account for a session that was never balanced', () => {
    render(<FallbackModeChip sessionId="s1" view={view()} />)
    open()

    expect(screen.queryByTestId('account-pick')).toBeNull()
    expect(screen.getByTestId('fallback-mode-chip').getAttribute('title')).not.toContain('Picked')
  })
})
