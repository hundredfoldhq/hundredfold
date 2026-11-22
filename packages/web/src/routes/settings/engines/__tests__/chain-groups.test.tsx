import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FallbackChainEntry, FallbackWrittenEntry, ResolvedFallbackLink } from '@hundredfold/fallback-chain-wire'
import type { EnginesResponse } from '@/lib/api'
import { ChainEditor } from '../chain-editor'
import { itemsOfResolved, shownChain, writeLinks } from '../chain-links'

/* A group is one row: the accounts it holds, ticked; it writes `{ group: [...] }` as written and
 * never the models the gateway resolved. */

const entry = (name: string) => ({ name, available: true, defaultModel: 'm', effortMechanism: 'none' as const, models: [] })
const REGISTRY: EnginesResponse = { default: 'claude', engines: { claude: entry('claude'), codex: entry('codex') } }

let latest: FallbackWrittenEntry[] = []

function Harness({ initial, profiles = ['spare', 'work'], serverProblems }: { initial: FallbackWrittenEntry[]; profiles?: string[]; serverProblems?: string[] }) {
  const [links, setLinks] = useState(initial)
  latest = links
  return (
    <ChainEditor
      chainName="Claude chain"
      ownEngine="claude"
      self={{ engine: 'claude' }}
      where="engines.claude.fallback"
      links={links}
      expanded={links.map(() => false)}
      fields={{ registry: REGISTRY, profiles }}
      waitsAs="Claude"
      serverProblems={serverProblems}
      onChange={setLinks}
    />
  )
}

const GROUP: FallbackWrittenEntry = { group: [{ engine: 'claude' }, { engine: 'claude', profile: 'spare' }, { engine: 'claude', profile: 'work' }] }
const groupBox = (name: string) => screen.getByRole('checkbox', { name: `${name} in link 1 of the Claude chain` }) as HTMLInputElement

describe('adding a balanced group', () => {
  it('adds one row holding the default login and the first declared account, and writes it as written', () => {
    render(<Harness initial={[{ engine: 'codex' }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add a balanced group to the Claude chain' }))

    expect(latest).toEqual([{ engine: 'codex' }, { group: [{ engine: 'claude' }, { engine: 'claude', profile: 'spare' }] }])
    expect(document.querySelectorAll('[data-chain-group]')).toHaveLength(1)
  })

  it('starts a group on the accounts the chain does not already list', () => {
    render(<Harness initial={[{ engine: 'claude', profile: 'spare' }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add a balanced group to the Claude chain' }))

    expect(latest[1]).toEqual({ group: [{ engine: 'claude' }, { engine: 'claude', profile: 'work' }] })
  })
})

describe('editing a group', () => {
  it('ticks the default login and each declared account, and writes the members in order', () => {
    render(<Harness initial={[{ group: [{ engine: 'claude', profile: 'spare' }, { engine: 'claude', profile: 'work' }] }]} />)
    expect(groupBox('Default login').checked).toBe(false)
    expect(groupBox('spare').checked).toBe(true)

    fireEvent.click(groupBox('Default login'))
    expect(latest).toEqual([{ group: [{ engine: 'claude', profile: 'spare' }, { engine: 'claude', profile: 'work' }, { engine: 'claude' }] }])

    fireEvent.click(groupBox('spare'))
    expect(latest).toEqual([{ group: [{ engine: 'claude', profile: 'work' }, { engine: 'claude' }] }])
  })

  it('names the group in its row and its controls', () => {
    render(<Harness initial={[GROUP]} />)

    expect(document.querySelector('[data-chain-row]')?.getAttribute('data-chain-row')).toBe('Balanced group (default login, spare, work)')
    expect(screen.getByRole('button', { name: 'Remove Balanced group (default login, spare, work) from the Claude chain' })).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'Accounts of link 1 of the Claude chain' })).getAllByRole('checkbox')).toHaveLength(3)
  })

  it('reorders and removes a group like any link', () => {
    render(<Harness initial={[GROUP, { engine: 'codex' }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Move Balanced group (default login, spare, work) later in the Claude chain' }))
    expect(latest).toEqual([{ engine: 'codex' }, GROUP])

    fireEvent.click(screen.getByRole('button', { name: 'Remove Codex from the Claude chain' }))
    expect(latest).toEqual([GROUP])
  })
})

describe('the validator on a group', () => {
  it('says a group needs two accounts once it is down to one', () => {
    render(<Harness initial={[{ group: [{ engine: 'claude' }, { engine: 'claude', profile: 'spare' }] }]} />)

    fireEvent.click(groupBox('spare'))

    expect(screen.getByText('engines.claude.fallback[0].group needs at least two accounts to balance between')).toBeTruthy()
  })

  it('lets a group hold the chain\'s own account, which a standalone link may not', () => {
    render(<Harness initial={[GROUP]} />)

    expect(document.querySelectorAll('[data-chain-problem]')).toHaveLength(0)
  })

  it('flags an account listed both in a group and as its own link, under the later row', () => {
    render(<Harness initial={[GROUP, { engine: 'claude', profile: 'spare' }]} />)

    expect(screen.getByText(/engines\.claude\.fallback\[1\] duplicates engines\.claude\.fallback\[0\]\.group\[1\]/)).toBeTruthy()
  })

  it('shows the gateway\'s own sentence about a group once', () => {
    const sentence = 'engines.claude.fallback[0].group[1]: profile "gone" names no account under engines.claude.accounts'
    render(<Harness initial={[{ group: [{ engine: 'claude' }, { engine: 'claude', profile: 'gone' }] }]} serverProblems={[sentence]} />)

    expect(screen.getAllByText(sentence)).toHaveLength(1)
  })

  it('keeps an account the chain is not offered visible, so it can be unticked', () => {
    render(<Harness initial={[{ group: [{ engine: 'claude' }, { engine: 'claude', profile: 'gone' }] }]} />)

    expect(groupBox('gone').checked).toBe(true)
    fireEvent.click(groupBox('gone'))
    expect(latest).toEqual([{ group: [{ engine: 'claude' }] }])
  })
})

const resolved = (profile: string | undefined, index: number | undefined, over: Partial<ResolvedFallbackLink> = {}): ResolvedFallbackLink => ({
  engine: 'claude',
  ...(profile ? { profile } : {}),
  model: 'sonnet', // the model the gateway filled in: it must never be written back
  key: `claude|${profile ?? ''}|sonnet`,
  account: profile ? `claude:${profile}` : 'claude',
  label: `claude · ${profile ?? 'default'} · sonnet`,
  origin: 'config',
  written: { engine: 'claude', ...(profile ? { profile } : {}) },
  ...(index !== undefined ? { group: { index, written: GROUP as { group: [] } } } : {}),
  ...over,
})

describe('a group as the gateway resolved it', () => {
  it('collapses consecutive members of one group into the group as written, never the resolved models', () => {
    const effective = [resolved('work', 0), resolved('spare', 0), { ...resolved(undefined, undefined), engine: 'codex', key: 'codex||', written: { engine: 'codex' } }]

    const { items, origins } = itemsOfResolved(effective)

    expect(items).toEqual([GROUP, { engine: 'codex' }])
    expect(origins).toEqual(['config', 'config'])
  })

  it('shows a legacy chain with a group as that group, and saves it as the written group', () => {
    const effective = [resolved('work', 1), resolved('spare', 1)]
    const entries: FallbackChainEntry[] = ['codex', GROUP]

    const shown = shownChain(entries, [{ ...resolved(undefined, undefined), engine: 'codex', key: 'codex||', written: { engine: 'codex' } }, ...effective])

    expect(shown.legacy).toBe(true)
    expect(shown.links).toEqual([{ engine: 'codex' }, GROUP])
    expect(writeLinks(entries, shown.links)).toEqual([{ engine: 'codex' }, GROUP])
  })

  it('writes an untouched group back as the very entry, and an edited one as its new members', () => {
    const stored: FallbackChainEntry[] = [GROUP as FallbackChainEntry, { engine: 'codex' }]
    const same = writeLinks(stored, [GROUP, { engine: 'codex' }])
    expect(same[0]).toBe(stored[0])

    const edited = writeLinks(stored, [{ group: [{ engine: 'claude' }, { engine: 'claude', profile: 'work' }] }, { engine: 'codex' }])
    expect(edited[0]).toEqual({ group: [{ engine: 'claude' }, { engine: 'claude', profile: 'work' }] })
  })
})
