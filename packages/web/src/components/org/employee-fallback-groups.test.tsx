import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FallbackWrittenEntry, ResolvedFallbackLink } from '@hundredfold/fallback-chain-wire'
import type { Employee } from '@/lib/api'
import { employeeChainOf, runningItems, sameChain } from './employee-fallback'
import { FallbackList } from './employee-fallback-field'

/* An employee's chain may hold a balanced group: kept whole when read, compared by its members,
 * and listed as one line of the accounts a limit walks in order. */

const GROUP: FallbackWrittenEntry = { group: [{ engine: 'claude' }, { engine: 'claude', profile: 'spare' }] }

const member = (profile: string, model: string): ResolvedFallbackLink => ({
  engine: 'claude', profile, model, key: `claude|${profile}|${model}`, account: `claude:${profile}`, label: `claude · ${profile} · ${model}`,
  origin: 'config', written: { engine: 'claude', profile }, group: { index: 0, written: GROUP as { group: [] } },
})

describe('an employee\'s chain with a group', () => {
  it('reads the group whole beside its links', () => {
    const employee = { fallback: [GROUP, { engine: 'codex' }] } as unknown as Employee

    expect(employeeChainOf(employee)).toEqual([GROUP, { engine: 'codex' }])
  })

  it('compares groups by their members', () => {
    expect(sameChain([GROUP], [{ group: [{ engine: 'claude' }, { engine: 'claude', profile: 'spare' }] }])).toBe(true)
    expect(sameChain([GROUP], [{ group: [{ engine: 'claude', profile: 'spare' }, { engine: 'claude' }] }])).toBe(false)
    expect(sameChain([GROUP], [{ engine: 'claude' }])).toBe(false)
  })

  it('lists what would run with a group as one row of its members, resolved models kept for reading', () => {
    const items = runningItems([member('spare', 'opus'), member('work', 'opus'), { ...member('x', 'm'), group: undefined, engine: 'codex', profile: undefined, model: undefined }])

    expect(items).toEqual([{ group: [{ engine: 'claude', profile: 'spare', model: 'opus' }, { engine: 'claude', profile: 'work', model: 'opus' }] }, { engine: 'codex' }])
  })

  it('draws the read-only list with the group on one line', () => {
    const { container } = render(<FallbackList links={[GROUP, { engine: 'codex' }]} />)

    expect(Array.from(container.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['1. Balanced group: Claude, Claude · spare', '2. Codex'])
  })
})
