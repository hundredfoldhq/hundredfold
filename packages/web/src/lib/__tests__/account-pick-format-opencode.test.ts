import { describe, expect, it } from 'vitest'
import type { AccountHeadroom, AccountPick } from '@hundredfold/fallback-chain-wire'
import { accountKeyText, candidateLabel, isOpencodeAccountKey, pickEngine, pickReasonText, pickTriggerText, pickedLabel } from '../account-pick-format'

/* A pick of opencode accounts, or of a remote host's Claude logins, reads as well as a local Claude one,
 * including when the gateway sends no label to show. */

const room = (account: string, label: string | undefined, over: Partial<AccountHeadroom> = {}): AccountHeadroom =>
  ({ account, label, state: 'fresh', headroomPercent: 60, weight: 60, sharePercent: 60, ...over }) as AccountHeadroom

const OPENCODE: AccountPick = {
  at: '2026-11-22T14:02:00', trigger: 'start', source: 'engine', groupIndex: 0, picked: 'opencode/opencode-go-b', reason: 'weighted',
  candidates: [room('opencode/opencode-go-b', undefined), room('opencode/opencode-go', 'go-a', { headroomPercent: 40, weight: 40, sharePercent: 40 })],
}

describe('account keys', () => {
  it('reads an opencode key as engine and provider, a remote login as profile and host, and leaves a local key as written', () => {
    expect(accountKeyText('opencode/opencode-go-b')).toBe('opencode · opencode-go-b')
    expect(accountKeyText('claude@ops@build:spare')).toBe('spare (ops@build)')
    expect(accountKeyText('claude@ops@build')).toBe('ops@build')
    expect(accountKeyText('claude:work')).toBe('claude:work')
  })

  it('tells an opencode key from a Claude one', () => {
    expect(isOpencodeAccountKey('opencode/opencode-go')).toBe(true)
    expect(isOpencodeAccountKey('claude:work')).toBe(false)
    expect(isOpencodeAccountKey('claude@ops@build:spare')).toBe(false)
  })

  it('prefers the label the gateway sent', () => {
    expect(candidateLabel({ account: 'opencode/opencode-go', label: 'go-a' })).toBe('go-a')
    expect(candidateLabel({ account: 'opencode/opencode-go-b', label: '' })).toBe('opencode · opencode-go-b')
  })
})

describe('a pick of opencode accounts', () => {
  it('is an opencode pick whichever of its keys says so', () => {
    expect(pickEngine(OPENCODE)).toBe('opencode')
    expect(pickEngine({ picked: 'claude:work', candidates: [room('claude:work', 'work')] })).toBe('claude')
    expect(pickEngine({ picked: 'claude@ops@build:spare', candidates: [room('claude@ops@build:spare', undefined)] })).toBe('claude')
  })

  it('names the picked account and the others even with no label', () => {
    expect(pickedLabel(OPENCODE)).toBe('opencode · opencode-go-b')
    expect(pickReasonText(OPENCODE)).toBe('Picked opencode · opencode-go-b: share 60% (headroom 60%) vs go-a 40% (headroom 40%)')
  })

  it('says a switch was to opencode, not Claude', () => {
    expect(pickTriggerText({ ...OPENCODE, trigger: 'switch' })).toMatch(/^On a switch to opencode, /)
    expect(pickTriggerText({ ...OPENCODE, picked: 'claude:work', candidates: [room('claude:work', 'work')], trigger: 'switch' })).toMatch(/^On a switch to Claude, /)
    expect(pickTriggerText(OPENCODE)).toMatch(/^At session start, /)
  })
})
