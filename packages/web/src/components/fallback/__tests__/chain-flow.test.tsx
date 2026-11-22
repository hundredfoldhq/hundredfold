import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AccountHeadroom, AccountPick, FallbackLink, ResolvedFallbackLink } from '@hundredfold/fallback-chain-wire'
import { buildChainFlow } from '../chain-flow-model'
import { ChainFlow } from '../chain-flow'
import { plainResolved, resolveForFlow } from '../resolve-links'

const NOW = new Date('2026-10-19T12:00:00').getTime()

const link = (engine: string, over: Partial<ResolvedFallbackLink> = {}, base: FallbackLink = { engine }): ResolvedFallbackLink =>
  ({ ...plainResolved(base), ...over })

const CHAIN: ResolvedFallbackLink[] = [
  link('claude', { label: 'claude · A · opus', key: 'a', health: { state: 'exhausted', until: '2026-10-19T16:00:00', usedPercent: 100, window: '5h' } }),
  link('claude', { label: 'claude · B · sonnet', key: 'b', health: { state: 'ok', usedPercent: 41.6 } }),
  link('opencode', { label: 'opencode · X', key: 'x', skip: 'not-installed' }),
  link('opencode', { label: 'opencode · Y', key: 'y', origin: 'legacy' }),
]

describe('buildChainFlow', () => {
  it('makes one node per target and an "on limit" edge between neighbours', () => {
    const graph = buildChainFlow({ links: CHAIN, now: NOW }, 'horizontal')

    expect(graph.nodes.map((n) => n.data.label)).toEqual(['claude · A · opus', 'claude · B · sonnet', 'opencode · X', 'opencode · Y'])
    expect(graph.edges.map((e) => [e.source, e.target, e.label])).toEqual([
      ['0', '1', 'on limit'], ['1', '2', 'on limit'], ['2', '3', 'on limit'],
    ])
    expect(graph.nodes[0].data.own).toBe(true)
    expect(graph.nodes[1].data.own).toBe(false)
  })

  it('reads used percent and the reset from health, the reset only for a target at its limit', () => {
    const [own, second] = buildChainFlow({ links: CHAIN, now: NOW }, 'horizontal').nodes
    expect(own.data.used).toBe('100% used')
    expect(own.data.resets).toBe('resets 16:00')
    expect(second.data.used).toBe('42% used')
    expect(second.data.resets).toBeNull()
  })

  it('marks the current target by position and the last server by key', () => {
    const nodes = buildChainFlow({ links: CHAIN, position: 1, servedBy: 'y', now: NOW }, 'horizontal').nodes
    expect(nodes.map((n) => n.data.current)).toEqual([false, true, false, false])
    expect(nodes.map((n) => n.data.servedLast)).toEqual([false, false, false, true])
  })

  it('carries why a link would be skipped, and which came from another chain', () => {
    const nodes = buildChainFlow({ links: CHAIN, now: NOW }, 'horizontal').nodes
    expect(nodes[2].data.skip).toBe('not-installed')
    expect(nodes[2].data.skipText).toBe('This engine is not installed')
    expect(nodes[3].data.legacy).toBe(true)
    expect(nodes[1].data.legacy).toBe(false)
  })

  it('lays out left to right on a wide screen and top to bottom on a phone', () => {
    const wide = buildChainFlow({ links: CHAIN }, 'horizontal').nodes.map((n) => n.position)
    expect(new Set(wide.map((p) => p.y)).size).toBe(1)
    expect(wide[1].x).toBeGreaterThan(wide[0].x)
    const tall = buildChainFlow({ links: CHAIN }, 'vertical').nodes.map((n) => n.position)
    expect(new Set(tall.map((p) => p.x)).size).toBe(1)
    expect(tall[1].y).toBeGreaterThan(tall[0].y)
  })
})

describe('resolveForFlow', () => {
  it('puts the own target first and gives each link what the gateway said of it, plain when it said nothing', () => {
    const known = link('opencode', { key: 'opencode||', health: { state: 'exhausted' } })
    const subject = { kind: 'engine' as const, id: 'claude', primary: null, configured: null, legacy: false, effective: [known] }

    const out = resolveForFlow({ engine: 'claude' }, [{ engine: 'opencode' }, { engine: 'codex' }], subject)

    expect(out.map((l) => l.label)).toEqual(['claude', 'opencode', 'codex'])
    expect(out[1].health?.state).toBe('exhausted')
    expect(out[2].health).toBeUndefined()
  })
})

describe('resolveForFlow, rows with no model', () => {
  it('finds the gateway reading of a row written without a model, by the link as written', () => {
    // The gateway resolves claude·B to the subject's model, so its key carries a model the row does not.
    const exhausted = link('claude', { key: 'claude|B|sonnet', profile: 'B', model: 'sonnet', health: { state: 'exhausted' }, written: { engine: 'claude', profile: 'B' } })
    const subject = { kind: 'engine' as const, id: 'claude', primary: null, configured: null, legacy: false, effective: [exhausted] }

    const out = resolveForFlow({ engine: 'claude' }, [{ engine: 'claude', profile: 'B' }], subject)

    expect(out[1].health?.state).toBe('exhausted')
  })
})

describe('resolveForFlow, own target', () => {
  it('takes the own node from the subject primary, whose key carries the default model, so it keeps its health', () => {
    const primary = link('claude', { key: 'claude||sonnet', model: 'sonnet', label: 'claude · sonnet', health: { state: 'exhausted', usedPercent: 97, window: 'weekly' } })
    const subject = { kind: 'engine' as const, id: 'claude', primary, configured: null, legacy: false, effective: [] }

    const [own] = resolveForFlow({ engine: 'claude' }, [{ engine: 'codex' }], subject)

    expect(own.health?.usedPercent).toBe(97)
    expect(own.label).toBe('claude · sonnet')
  })

  it('falls back to the plain own target when the gateway has not said', () => {
    expect(resolveForFlow({ engine: 'claude' }, [], undefined)[0].label).toBe('claude')
  })
})

describe('ChainFlow', () => {
  async function renderFlow(props: Parameters<typeof ChainFlow>[0]) {
    render(<ChainFlow {...props} />)
    await screen.findAllByText('claude · A · opus')
  }

  it('draws every target with its label, used percent and reset', async () => {
    await renderFlow({ links: CHAIN, now: NOW })

    expect(document.querySelectorAll('[data-chain-flow-node]').length).toBe(4)
    expect(screen.getByText('100% used · resets 16:00')).toBeTruthy()
    expect(screen.getByText('42% used')).toBeTruthy()
  })

  it('highlights the current and last-used target', async () => {
    await renderFlow({ links: CHAIN, position: 1, servedBy: 'b', now: NOW })

    const current = document.querySelector('[data-chain-flow-node][data-current]')!
    expect(current.getAttribute('data-chain-flow-node')).toBe('claude · B · sonnet')
    expect(current.querySelector('[data-chain-flow-badge="now"]')).toBeTruthy()
    expect(current.querySelector('[data-chain-flow-badge="served last"]')).toBeTruthy()
  })

  it('dims a skipped link with its reason, and badges a legacy one', async () => {
    await renderFlow({ links: CHAIN, now: NOW })

    const skipped = document.querySelector('[data-chain-flow-node="opencode · X"]') as HTMLElement
    expect(skipped.getAttribute('data-skipped')).toBe('not-installed')
    expect(skipped.getAttribute('title')).toBe('This engine is not installed')
    expect(skipped.style.opacity).toBe('0.5')
    expect(document.querySelector('[data-chain-flow-node="opencode · Y"] [data-chain-flow-badge="from another chain"]')).toBeTruthy()
    expect((document.querySelector('[data-chain-flow-node="claude · B · sonnet"]') as HTMLElement).style.opacity).toBe('1')
  })
})

/* A balanced group is one node listing its members in the order a limit walks them. */

const GROUP_WRITTEN = { group: [{ engine: 'claude' }, { engine: 'claude', profile: 'spare' }, { engine: 'claude', profile: 'work' }] }

const headroom = (account: string, label: string, over: Partial<AccountHeadroom> = {}): AccountHeadroom =>
  ({ account, label, state: 'fresh', headroomPercent: 60, weight: 60, sharePercent: 60, ...over })

const member = (profile: string, index: number, room: AccountHeadroom, over: Partial<ResolvedFallbackLink> = {}): ResolvedFallbackLink => ({
  ...plainResolved({ engine: 'claude', profile }),
  key: `claude|${profile}|`,
  label: `claude · ${profile}`,
  health: { state: 'ok' },
  group: { index, written: GROUP_WRITTEN, headroom: room },
  ...over,
})

const WITH_GROUP: ResolvedFallbackLink[] = [
  link('claude', { label: 'claude · own', key: 'own' }),
  member('spare', 0, headroom('claude:spare', 'claude · spare')),
  member('work', 0, headroom('claude:work', 'claude · work', { headroomPercent: 40, weight: 40, sharePercent: 40 })),
  link('opencode', { label: 'opencode · X', key: 'x' }),
]

describe('buildChainFlow, a balanced group', () => {
  it('draws consecutive members of one group as one node with an edge on each side', () => {
    const graph = buildChainFlow({ links: WITH_GROUP, now: NOW }, 'horizontal')

    expect(graph.nodes.map((n) => n.data.label)).toEqual(['claude · own', 'Balanced group', 'opencode · X'])
    expect(graph.nodes[1].data.members?.map((m) => m.label)).toEqual(['claude · spare', 'claude · work'])
    expect(graph.edges.map((e) => [e.source, e.target])).toEqual([['0', '1'], ['1', '2']])
  })

  it('gives each member its headroom and share, in the order the gateway ranked them', () => {
    const { members } = buildChainFlow({ links: WITH_GROUP, now: NOW }, 'horizontal').nodes[1].data

    expect(members?.map((m) => m.detail)).toEqual(['headroom 60% · share 60%', 'headroom 40% · share 40%'])
  })

  it('keeps two groups apart, and never folds the own target into one', () => {
    const second = [member('spare', 2, headroom('claude:spare', 'claude · spare')), member('work', 2, headroom('claude:work', 'claude · work'))]
    const graph = buildChainFlow({ links: [WITH_GROUP[0], ...WITH_GROUP.slice(1, 3), ...second], now: NOW }, 'horizontal')

    expect(graph.nodes.map((n) => n.data.label)).toEqual(['claude · own', 'Balanced group', 'Balanced group'])
    expect(buildChainFlow({ links: [member('spare', 0, headroom('claude:spare', 'claude · spare')), ...WITH_GROUP.slice(2, 3)], now: NOW }, 'horizontal').nodes).toHaveLength(2)
  })

  it('marks the node and the member the session is on, and the one that served last', () => {
    const graph = buildChainFlow({ links: WITH_GROUP, position: 2, servedBy: 'claude|spare|', now: NOW }, 'horizontal')

    expect(graph.nodes.map((n) => n.data.current)).toEqual([false, true, false])
    expect(graph.nodes[1].data.members?.map((m) => [m.current, m.servedLast])).toEqual([[false, true], [true, false]])
  })

  it('makes the group node taller for each member', () => {
    const [own, group] = buildChainFlow({ links: WITH_GROUP }, 'horizontal').nodes
    expect(group.data.height).toBeGreaterThan(own.data.height)
  })

  it('says where new sessions start on the start node, with its share', () => {
    const startPick: AccountPick = {
      at: '2026-10-19T11:00:00', trigger: 'start', source: 'engine', groupIndex: 0, picked: 'claude:spare', reason: 'weighted',
      candidates: [headroom('claude:spare', 'claude · spare'), headroom('claude:work', 'claude · work', { sharePercent: 40 })],
    }

    const nodes = buildChainFlow({ links: WITH_GROUP, startPick, now: NOW }, 'horizontal').nodes

    expect(nodes[0].data.startNote).toBe('New sessions start on claude · spare (share 60%)')
    expect(nodes[1].data.startNote).toBeNull()
    expect(buildChainFlow({ links: WITH_GROUP }, 'horizontal').nodes[0].data.startNote).toBeNull()
  })
})

describe('ChainFlow, a balanced group', () => {
  it('lists each member in the group node with its headroom and share', async () => {
    render(<ChainFlow links={WITH_GROUP} now={NOW} />)
    await screen.findByText('claude · spare')

    const group = document.querySelector('[data-chain-flow-group]') as HTMLElement
    expect(group.querySelectorAll('[data-chain-flow-member]')).toHaveLength(2)
    expect(group.textContent).toContain('headroom 60% · share 60%')
    expect(group.textContent).toContain('headroom 40% · share 40%')
    expect(document.querySelectorAll('[data-chain-flow-node]')).toHaveLength(3)
  })

  it('shows the start line on the start node', async () => {
    const startPick: AccountPick = { at: '2026-10-19T11:00:00', trigger: 'start', source: 'engine', groupIndex: 0, picked: 'claude:work', reason: 'only-candidate', candidates: [{ account: 'claude:work', label: 'claude · work', state: 'fresh', weight: 1, sharePercent: 100 }] }
    render(<ChainFlow links={WITH_GROUP} startPick={startPick} now={NOW} />)

    expect((await screen.findByText('New sessions start on claude · work (share 100%)')).closest('[data-chain-flow-node]')?.getAttribute('data-chain-flow-node')).toBe('claude · own')
  })

  it('draws a scoped viewer\'s members from their state alone', async () => {
    const stripped = (account: string, label: string, state: AccountHeadroom['state']): AccountHeadroom => ({ account, label, state, weight: 0, sharePercent: 0 })
    // The gateway sends no numbers to a department-scoped viewer: weight and share are absent, not zero.
    const bare = ({ weight: _w, sharePercent: _s, ...rest }: AccountHeadroom) => rest as AccountHeadroom
    const links = [WITH_GROUP[0], member('spare', 0, bare(stripped('claude:spare', 'claude · spare', 'stale'))), member('work', 0, bare(stripped('claude:work', 'claude · work', 'exhausted')))]
    render(<ChainFlow links={links} now={NOW} />)
    await screen.findByText('claude · spare')

    const group = document.querySelector('[data-chain-flow-group]') as HTMLElement
    expect(group.textContent).toContain('stale reading')
    expect(group.textContent).toContain('at its limit')
    expect(group.textContent).not.toContain('NaN')
  })
})

describe('resolveForFlow, a group entry', () => {
  const known = [
    member('work', 1, headroom('claude:work', 'claude · work', { headroomPercent: 70, weight: 70, sharePercent: 70 })),
    member('spare', 1, headroom('claude:spare', 'claude · spare', { headroomPercent: 30, weight: 30, sharePercent: 30 })),
  ]
  const subject = { kind: 'engine' as const, id: 'claude', primary: null, configured: null, legacy: false, effective: known }

  it('expands the group to its members, ranked as the gateway ranked them, leaving out the chain\'s own account', () => {
    const out = resolveForFlow({ engine: 'claude' }, [{ engine: 'codex' }, GROUP_WRITTEN], subject)

    expect(out.map((l) => l.label)).toEqual(['claude', 'codex', 'claude · work', 'claude · spare'])
    expect(out.slice(2).map((l) => l.group?.index)).toEqual([1, 1])
    expect(out[2].group?.headroom?.sharePercent).toBe(70)
  })

  it('draws a group the gateway has not seen (just added) in written order, plain', () => {
    const out = resolveForFlow({ engine: 'claude' }, [GROUP_WRITTEN], undefined)

    expect(out.map((l) => l.label)).toEqual(['claude', 'claude · spare', 'claude · work'])
    expect(out[1].group?.headroom).toBeUndefined()
  })
})
