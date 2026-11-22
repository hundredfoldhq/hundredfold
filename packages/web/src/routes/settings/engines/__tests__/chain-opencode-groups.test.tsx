import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FallbackWrittenEntry } from '@hundredfold/fallback-chain-wire'
import type { EnginesResponse } from '@/lib/api'
import { ChainEditor } from '../chain-editor'
import { blankGroup, groupEngineOf, itemLabel, offersOpencodeGroup, withMember } from '../chain-links'

/* A group of opencode accounts is ticked from the declared opencode accounts, names its members with
 * `profile`, and is only offered where the chain's own target runs on opencode. The sentences about a
 * wrong group are the gateway's own, from the shared validator. */

const entry = (name: string) => ({ name, available: true, defaultModel: 'm', effortMechanism: 'none' as const, models: [] })
const REGISTRY: EnginesResponse = { default: 'claude', engines: { claude: entry('claude'), codex: entry('codex'), opencode: entry('opencode') } }
const ACCOUNTS = [{ name: 'go-a', provider: 'opencode-go-a' }, { name: 'go-b', provider: 'opencode-go-b' }, { name: 'go-c', provider: 'opencode-go-c' }]

let latest: FallbackWrittenEntry[] = []

function Harness({ initial, ownEngine = 'opencode', opencodeAccounts = ACCOUNTS }: { initial: FallbackWrittenEntry[]; ownEngine?: string; opencodeAccounts?: typeof ACCOUNTS }) {
  const [links, setLinks] = useState(initial)
  latest = links
  return (
    <ChainEditor
      chainName="opencode chain"
      ownEngine={ownEngine}
      self={{ engine: ownEngine }}
      where={`engines.${ownEngine}.fallback`}
      links={links}
      expanded={links.map(() => false)}
      fields={{ registry: REGISTRY, profiles: ['work'], opencodeAccounts }}
      waitsAs="opencode"
      onChange={setLinks}
    />
  )
}

const GROUP: FallbackWrittenEntry = { group: [{ engine: 'opencode', profile: 'go-a' }, { engine: 'opencode', profile: 'go-b' }] }
const box = (name: string) => screen.getByRole('checkbox', { name: `${name} in link 1 of the opencode chain` }) as HTMLInputElement

describe('offering an opencode group', () => {
  it('shows the add button only when the chain falls back from opencode', () => {
    const { unmount } = render(<Harness initial={[]} />)
    expect(screen.getByRole('button', { name: 'Add a balanced opencode group to the opencode chain' })).toBeTruthy()
    unmount()

    render(<Harness initial={[]} ownEngine="claude" />)
    expect(screen.queryByRole('button', { name: /balanced opencode group/ })).toBeNull()
    expect(offersOpencodeGroup('claude')).toBe(false)
    expect(offersOpencodeGroup(undefined)).toBe(false)
  })

  it('adds a group of the first two declared opencode accounts, written with profile', () => {
    render(<Harness initial={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add a balanced opencode group to the opencode chain' }))

    expect(latest).toEqual([GROUP])
    expect(document.querySelector('[data-chain-group="opencode"]')).toBeTruthy()
    expect(screen.getByText('Balanced opencode group')).toBeTruthy()
  })

  it('skips accounts the chain already lists on its own', () => {
    expect(blankGroup({ engines: [], profiles: [], opencodeProfiles: ['go-a', 'go-b', 'go-c'] }, [{ engine: 'opencode', profile: 'go-a' }], 'opencode'))
      .toEqual({ group: [{ engine: 'opencode', profile: 'go-b' }, { engine: 'opencode', profile: 'go-c' }] })
  })
})

describe('editing an opencode group', () => {
  it('ticks the declared opencode accounts, not the Claude ones, and writes members in order', () => {
    render(<Harness initial={[GROUP]} />)
    expect(box('go-a').checked).toBe(true)
    expect(box('go-c').checked).toBe(false)
    expect(screen.queryByRole('checkbox', { name: /Default login/ })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /work in link/ })).toBeNull()

    fireEvent.click(box('go-c'))
    expect(latest).toEqual([{ group: [{ engine: 'opencode', profile: 'go-a' }, { engine: 'opencode', profile: 'go-b' }, { engine: 'opencode', profile: 'go-c' }] }])

    fireEvent.click(box('go-a'))
    expect(latest).toEqual([{ group: [{ engine: 'opencode', profile: 'go-b' }, { engine: 'opencode', profile: 'go-c' }] }])
  })

  it('keeps an emptied opencode group an opencode group, so it can be ticked again', () => {
    render(<Harness initial={[GROUP]} />)

    fireEvent.click(box('go-a'))
    fireEvent.click(box('go-b'))
    expect(latest).toEqual([{ group: [] }])
    expect(document.querySelector('[data-chain-group="opencode"]')).toBeTruthy()
    expect(box('go-a').checked).toBe(false)

    fireEvent.click(box('go-b'))
    expect(latest).toEqual([{ group: [{ engine: 'opencode', profile: 'go-b' }] }])
  })

  it('says what an opencode group does, and that a session keeps its model', () => {
    render(<Harness initial={[GROUP]} />)

    expect(document.querySelector('[data-chain-group-hint]')?.textContent).toMatch(/opencode accounts.*each running the model it was started on/)
  })
})

describe('the sentences about a wrong opencode group', () => {
  it('refuses a group that mixes engines, with the gateway\'s sentence, and lets the extra account be unticked', () => {
    render(<Harness initial={[{ group: [{ engine: 'opencode', profile: 'go-a' }, { engine: 'claude', profile: 'work' }] }]} />)

    expect(screen.getByText(/a group's members all run on one engine/)).toBeTruthy()
    expect(engineOfMixed()).toBeUndefined()
    fireEvent.click(screen.getByRole('checkbox', { name: 'work in link 1 of the opencode chain' }))
    expect(latest).toEqual([{ group: [{ engine: 'opencode', profile: 'go-a' }] }])
  })

  it('refuses an opencode member that names no account, or one declared nowhere', () => {
    const { unmount } = render(<Harness initial={[{ group: [{ engine: 'opencode' }, { engine: 'opencode', profile: 'go-a' }] }]} />)
    expect(screen.getByText(/an opencode group member names its account with profile/)).toBeTruthy()
    unmount()

    render(<Harness initial={[{ group: [{ engine: 'opencode', profile: 'go-a' }, { engine: 'opencode', profile: 'nope' }] }]} />)
    expect(screen.getByRole('alert').textContent).toContain('profile "nope" names no account under engines.opencode.accounts')
  })

  it('refuses an opencode group in a chain that does not fall back from opencode', () => {
    render(<Harness initial={[GROUP]} ownEngine="claude" />)

    expect(screen.getByRole('alert').textContent).toContain("an opencode group balances an opencode session's own model; put it in an opencode employee's chain or engines.opencode.fallback")
  })

  it('does not flag a valid group before the declared accounts are read', () => {
    render(<Harness initial={[GROUP]} opencodeAccounts={undefined as never} />)

    expect(document.body.textContent).not.toMatch(/names no account|not declared/i)
  })
})

describe('the model helpers', () => {
  it('names an opencode group by its accounts', () => {
    expect(itemLabel(GROUP)).toBe('Balanced opencode group (go-a, go-b)')
    expect(itemLabel({ group: [{ engine: 'claude' }, { engine: 'claude', profile: 'work' }] })).toBe('Balanced group (default login, work)')
  })

  it('reads a group\'s engine, and none for an empty or mixed one', () => {
    expect(groupEngineOf(GROUP)).toBe('opencode')
    expect(groupEngineOf({ group: [] })).toBeUndefined()
    expect(groupEngineOf({ group: [{ engine: 'opencode', profile: 'a' }, { engine: 'claude' }] })).toBeUndefined()
  })

  it('adds and removes a member by its engine and account together', () => {
    const added = withMember({ group: [{ engine: 'claude', profile: 'a' }] }, { engine: 'opencode', profile: 'a' }, true)
    expect(added.group).toHaveLength(2)
    expect(withMember(added, { engine: 'claude', profile: 'a' }, false).group).toEqual([{ engine: 'opencode', profile: 'a' }])
  })
})

function engineOfMixed() {
  return groupEngineOf({ group: [{ engine: 'opencode', profile: 'go-a' }, { engine: 'claude', profile: 'work' }] })
}
