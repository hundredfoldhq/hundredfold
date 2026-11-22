import { describe, expect, it } from 'vitest'
import type { AccountHeadroom, AccountPick } from '@hundredfold/fallback-chain-wire'
import { headroomLine, pickReasonText, pickTriggerText, startPickText } from '../account-pick-format'

const room = (account: string, label: string, over: Partial<AccountHeadroom> = {}): AccountHeadroom =>
  ({ account, label, state: 'fresh', headroomPercent: 60, weight: 60, sharePercent: 60, ...over })

const pick = (over: Partial<AccountPick> = {}): AccountPick => ({
  at: '2026-11-22T14:02:00',
  trigger: 'start',
  source: 'engine',
  groupIndex: 0,
  picked: 'claude:spare',
  reason: 'weighted',
  candidates: [room('claude:spare', 'spare'), room('claude:work', 'work', { headroomPercent: 40, weight: 40, sharePercent: 40 })],
  ...over,
})

/** What a department-scoped viewer is sent: account, label, state and the reason, no numbers. */
const scoped = (p: AccountPick): AccountPick => ({
  ...p,
  candidates: p.candidates.map(({ account, label, state }) => ({ account, label, state }) as AccountHeadroom),
})

describe('pickReasonText', () => {
  it('says each account\'s weight and share, not "most headroom"', () => {
    expect(pickReasonText(pick())).toBe('Picked spare: share 60% (headroom 60%) vs work 40% (headroom 40%)')
  })

  it('names every other account when the group is larger', () => {
    const three = pick({ candidates: [...pick().candidates, room('claude', 'default login', { headroomPercent: 10, weight: 10, sharePercent: 10 })] })
    expect(pickReasonText(three)).toBe('Picked spare: share 60% (headroom 60%) vs work 40% (headroom 40%), default login 10% (headroom 10%)')
  })

  it('marks a stale reading and an account at its limit', () => {
    const p = pick({ candidates: [room('claude:spare', 'spare'), room('claude:work', 'work', { state: 'exhausted', headroomPercent: 0, weight: 0, sharePercent: 0 })] })
    expect(pickReasonText(p)).toBe('Picked spare: share 60% (headroom 60%) vs work 0% (at its limit)')
    const stale = pick({ candidates: [room('claude:spare', 'spare', { state: 'stale', weight: 30, sharePercent: 43 }), room('claude:work', 'work', { headroomPercent: 40, weight: 40, sharePercent: 57 })] })
    expect(pickReasonText(stale)).toBe('Picked spare: share 43% (headroom 60%) vs work 57% (headroom 40%)')
  })

  it('reads the other reasons in plain words', () => {
    expect(pickReasonText(pick({ reason: 'only-candidate', candidates: [room('claude:spare', 'spare')] }))).toBe('Picked spare: the only account in the group that could serve this session')
    expect(pickReasonText(pick({ reason: 'no-readings' }))).toContain('no usage readings yet')
    expect(pickReasonText(pick({ reason: 'all-exhausted' }))).toContain('every account in the group was at its limit')
  })

  it('reads for a scoped viewer from the accounts and their states alone, with no percentages', () => {
    const text = pickReasonText(scoped(pick()))

    expect(text).toBe('Picked spare, weighted by headroom against work')
    expect(text).not.toMatch(/\d/)
    expect(pickReasonText(scoped(pick({ candidates: [room('claude:spare', 'spare'), room('claude:work', 'work', { state: 'stale' })] })))).toBe('Picked spare, weighted by headroom against work (stale reading)')
  })

  it('falls back to the account key when the pick does not list the account', () => {
    expect(pickReasonText(pick({ candidates: [] }))).toBe('Picked claude:spare, weighted by headroom')
  })
})

describe('headroomLine', () => {
  it('gives headroom and share, the weight too when a stale reading halved it', () => {
    expect(headroomLine(room('a', 'a'))).toBe('headroom 60% · share 60%')
    expect(headroomLine(room('a', 'a', { state: 'stale', weight: 30, sharePercent: 30 }))).toBe('headroom 60% · stale reading · weight 30 · share 30%')
  })

  it('says so for an account at its limit and one with no reading', () => {
    expect(headroomLine(room('a', 'a', { state: 'exhausted', headroomPercent: 0, weight: 0, sharePercent: 0 }))).toBe('at its limit · share 0%')
    expect(headroomLine({ account: 'a', label: 'a', state: 'unknown', weight: 0, sharePercent: 0 })).toBe('no reading · share 0%')
  })

  it('is the state alone for a scoped viewer, and empty for a current reading', () => {
    expect(headroomLine({ account: 'a', label: 'a', state: 'stale' } as AccountHeadroom)).toBe('stale reading')
    expect(headroomLine({ account: 'a', label: 'a', state: 'exhausted' } as AccountHeadroom)).toBe('at its limit')
    expect(headroomLine({ account: 'a', label: 'a', state: 'fresh' } as AccountHeadroom)).toBe('')
  })
})

describe('pickTriggerText and startPickText', () => {
  it('says when the balancer ran, and why', () => {
    expect(pickTriggerText(pick())).toMatch(/^At session start, /)
    expect(pickTriggerText(pick({ trigger: 'switch' }))).toMatch(/^On a switch to Claude, /)
    expect(pickTriggerText(pick({ at: 'not a date' }))).toBe('At session start')
  })

  it('says where a new session would start, with the share when it is sent', () => {
    expect(startPickText(pick())).toBe('New sessions start on spare (share 60%)')
    expect(startPickText(scoped(pick()))).toBe('New sessions start on spare')
  })
})
