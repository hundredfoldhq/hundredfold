import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/test/preload-menus'
import type { AccountPick } from '@hundredfold/fallback-chain-wire'
import SettingsPage from '../../page'

/* The Engine Fallbacks section as the operator drives it: chains are edited into the
 * page's config state and land on the wire through the page's own write path
 * button, so every assertion here is about what `api.updateConfig` receives. */

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getOrg: vi.fn(),
  sttStatus: vi.fn(),
  sttUpdateConfig: vi.fn(),
  sttDownload: vi.fn(),
}))
const registry = vi.hoisted(() => ({ current: undefined as unknown }))
const chains = vi.hoisted(() => ({ current: undefined as unknown }))
// `'failed'` stands for a chains request that errored.

vi.mock('@/lib/api', () => ({ api: apiMocks }))
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/routes/providers', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({
    settings: {},
    setAccentColor: vi.fn(),
    setCompanyName: vi.fn(),
    setPortalName: vi.fn(),
    setPortalSubtitle: vi.fn(),
    setOperatorName: vi.fn(),
    setPortalEmoji: vi.fn(),
    setLanguage: vi.fn(),
    resetAll: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-model-registry', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/use-model-registry')>()),
  useModelRegistry: () => ({ data: registry.current }),
}))
vi.mock('@/hooks/use-fallback-chains', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/use-fallback-chains')>()),
  useFallbackChains: () => ({ data: chains.current, isError: chains.current === 'failed' }),
}))
vi.mock('@/hooks/use-onboarding', () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock('@/components/ui/emoji-picker', () => ({ EmojiPicker: () => null }))
vi.mock('@/components/auth/remote-access-panel', () => ({ RemoteAccessPanel: () => null }))
vi.mock('@/routes/auth-provider', () => ({
  useAuth: () => ({ authState: {}, devices: [], createPairingCode: vi.fn(), logout: vi.fn(), unpairDevice: vi.fn() }),
}))

/** Six days out: the case a bare clock time used to render as this afternoon. */
const EXHAUSTED_UNTIL = new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString()

const model = (id: string, label = id) => ({ id, label, supportsEffort: false, effortLevels: [] })

function engine(name: string, available: boolean, defaultModel: string, extra: Record<string, unknown> = {}) {
  return { name, available, defaultModel, effortMechanism: 'none', models: [model(defaultModel)], ...extra }
}

async function renderSettings() {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByRole('switch', { name: 'Interrupt on new message' })
}

/** The chain rows on one card, in the order they are rendered. */
function chainRows(cardSelector: string): string[] {
  const card = document.querySelector(cardSelector)!
  return Array.from(card.querySelectorAll('[data-chain-row]')).map((row) => row.getAttribute('data-chain-row')!)
}
const engineRows = (name: string) => chainRows(`[data-engine-card="${name}"]`)

/** For a test that edits more than once: the write that follows the last edit, once the debounce has gone quiet. */
async function saveLast() {
  await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 700))
  return apiMocks.updateConfig.mock.calls.at(-1)![0] as Record<string, any>
}

/** Settings save themselves; what a test waits for is the write. */
async function save() {
  await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalled())
  return apiMocks.updateConfig.mock.calls[0][0] as Record<string, any>
}

function loadConfig(config: Record<string, unknown>) {
  apiMocks.getConfig.mockResolvedValue({ config, revision: 'rev-1' })
}

beforeEach(() => {
  vi.clearAllMocks()
  chains.current = undefined
  registry.current = {
    default: 'claude',
    engines: {
      claude: engine('claude', true, 'opus', {
        health: { state: 'exhausted', until: EXHAUSTED_UNTIL, window: '7d' },
        models: [model('opus', 'Opus'), model('sonnet', 'Sonnet')],
      }),
      codex: engine('codex', true, 'gpt-5.6-sol'),
      grok: engine('grok', false, 'grok-build', { health: { state: 'degraded' } }),
      opencode: engine('opencode', true, 'x/one', { models: [model('x/one'), model('x/two')] }),
    },
  }
  loadConfig({ engines: { claude: { fallback: [{ engine: 'codex' }] } } })
  apiMocks.updateConfig.mockResolvedValue({})
  apiMocks.getOrg.mockResolvedValue({ employees: [] })
  apiMocks.sttStatus.mockResolvedValue({ available: false, model: null, downloading: false, progress: 0, languages: ['en'] })
  apiMocks.sttUpdateConfig.mockResolvedValue({})
  apiMocks.sttDownload.mockResolvedValue({})
})

describe('Engine Fallbacks section', () => {
  it('is titled for what it configures — the chain a limited engine falls through to', async () => {
    await renderSettings()

    expect(screen.getByText('Engine Fallbacks')).toBeTruthy()
  })

  it('lists every engine with its installed state, default model and health', async () => {
    await renderSettings()

    expect(screen.getByText('Installed · opus')).toBeTruthy()
    expect(screen.getByText('Installed · gpt-5.6-sol')).toBeTruthy()
    // Uninstalled engines are listed too, not hidden.
    expect(screen.getByText('Not installed · grok-build')).toBeTruthy()
    expect(screen.getByText('Weekly limit, back in 6d')).toBeTruthy()
    expect(screen.getByText('Degraded')).toBeTruthy()
    expect(screen.getAllByText('Healthy').length).toBeGreaterThan(0)
  })

  it('shows each link as engine, profile (Claude only) and model, with the profile choices Default plus the declared accounts', async () => {
    loadConfig({ engines: { claude: {
      accounts: { work: { configDir: '/w' } },
      fallback: [{ engine: 'claude', profile: 'work', model: 'sonnet' }, { engine: 'opencode', model: 'x/two' }],
    } } })
    await renderSettings()

    const profile = screen.getByRole('combobox', { name: 'Profile of link 1 of the Claude chain' }) as HTMLSelectElement
    expect(profile.value).toBe('work')
    expect(within(profile).getAllByRole('option').map((o) => o.textContent)).toEqual(['Default profile', 'work'])
    expect(screen.getByRole('button', { name: 'Model of link 1 of the Claude chain: Sonnet' })).toBeTruthy()
    // opencode takes no profile: its row has two fields, not three.
    expect(screen.queryByRole('combobox', { name: 'Profile of link 2 of the Claude chain' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Model of link 2 of the Claude chain: x/two' })).toBeTruthy()
  })

  it('saves an added target as an object link, the array replaced as a whole', async () => {
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))
    expect(engineRows('claude')).toEqual(['codex', 'opencode'])

    expect((await save()).engines.claude.fallback).toEqual([{ engine: 'codex' }, { engine: 'opencode' }])
  })

  it('saves a changed engine, profile and model on the row that changed', async () => {
    loadConfig({ engines: { claude: { accounts: { work: { configDir: '/w' } }, fallback: [{ engine: 'codex' }] } } })
    await renderSettings()
    fireEvent.change(screen.getByRole('combobox', { name: 'Engine of link 1 of the Claude chain' }), { target: { value: 'claude' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Profile of link 1 of the Claude chain' }), { target: { value: 'work' } })
    fireEvent.keyDown(screen.getByRole('button', { name: /Model of link 1 of the Claude chain/ }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Sonnet/ }))

    expect((await saveLast()).engines.claude.fallback).toEqual([{ engine: 'claude', profile: 'work', model: 'sonnet' }])
  })

  it('writes no model for "Same model" / "Engine default", and says which one it is', async () => {
    loadConfig({ engines: { claude: {
      accounts: { a: { configDir: '/a' } },
      fallback: [{ engine: 'claude', profile: 'a', model: 'sonnet' }, { engine: 'codex', model: 'gpt-5.6-sol' }],
    } } })
    await renderSettings()
    fireEvent.keyDown(screen.getByRole('button', { name: /Model of link 2 of the Claude chain/ }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Engine default' }))

    expect((await save()).engines.claude.fallback[1]).toEqual({ engine: 'codex' })
    expect(screen.getByRole('button', { name: 'Model of link 2 of the Claude chain: Engine default' })).toBeTruthy()
  })

  it('asks for the gateway view of the chains again once a save has landed', async () => {
    const { queryClient } = await import('@/lib/query-client')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))
    await save()

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['fallback-chains'] }))
  })

  it('saves a chain emptied in the UI as [], and says the engine waits', async () => {
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Codex from the Claude chain' }))

    expect(screen.getByText('No fallback. Claude waits for its own limit to reset.')).toBeTruthy()
    expect((await save()).engines.claude.fallback).toEqual([])
  })

  it('reorders with the move controls a keyboard can reach', async () => {
    loadConfig({ engines: { claude: { fallback: [{ engine: 'codex' }, { engine: 'opencode' }] } } })
    await renderSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Move opencode earlier in the Claude chain' }))
    expect(engineRows('claude')).toEqual(['opencode', 'codex'])
    expect((await save()).engines.claude.fallback).toEqual([{ engine: 'opencode' }, { engine: 'codex' }])
  })

  it('refuses a duplicate under its row in the loader sentence, and writes nothing', async () => {
    loadConfig({ engines: { claude: { fallback: [{ engine: 'codex' }] } } })
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))
    fireEvent.change(screen.getAllByRole('combobox', { name: /^Engine of link 2/ })[0], { target: { value: 'codex' } })

    const problem = document.querySelector('[data-chain-problem]')!
    expect(problem.textContent).toBe('engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex): a chain tries each target once, so list it once')
    expect(problem.closest('[data-engine-card]')?.getAttribute('data-engine-card')).toBe('claude')
    expect(await screen.findByText(/Cannot save: engines\.claude\.fallback\[1\] duplicates/)).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()
  })

  it('shows the map on the engine that falls through rather than on the stand-in', async () => {
    loadConfig({
      engines: {
        claude: { fallback: [{ engine: 'codex' }] },
        codex: { fallback: [{ engine: 'claude' }], fallbackModelMap: { 'gpt-5.6-luna': 'haiku' } },
      },
    })
    await renderSettings()
    const codexCard = document.querySelector('[data-engine-card="codex"]') as HTMLElement

    expect(within(codexCard).getByText('Models carried onto the stand-in')).toBeTruthy()
    expect(codexCard.querySelector('[data-model-map-pair="gpt-5.6-luna"]')).toBeTruthy()
    expect(document.querySelector('[data-engine-card="claude"] [data-model-map-pair]')).toBeNull()
  })

  it('states the floor rule for an engine with no mappings, rather than nothing at all', async () => {
    await renderSettings()

    expect(document.querySelectorAll('[data-model-map-pair]').length).toBe(0)
    expect(document.querySelector('[data-engine-card="claude"] [data-model-map-floor]')?.textContent)
      .toContain("Codex's own default")
  })

  it('waits for the gateway before offering a chain written in engine names for editing', async () => {
    loadConfig({ engines: { claude: { fallback: ['codex', { engine: 'opencode', model: 'x/two' }] } } })
    await renderSettings()
    expect(document.querySelector('[data-engine-card="claude"] [data-chain-loading]')).toBeTruthy()
    expect(engineRows('claude')).toEqual([])
  })

  it('says the gateway could not be read, rather than loading for ever, when the chains request fails', async () => {
    loadConfig({ engines: { claude: { fallback: ['codex', { engine: 'opencode', model: 'x/two' }] } } })
    chains.current = 'failed'
    await renderSettings()
    expect(document.querySelector('[data-engine-card="claude"] [data-chain-unreadable]')?.textContent).toContain('could not say how this chain runs')
    expect(document.querySelector('[data-engine-card="claude"] [data-chain-loading]')).toBeNull()
    expect(engineRows('claude')).toEqual([])
  })

  it('reads a chain of mixed string and object entries, whichever way each was written', async () => {
    loadConfig({ engines: { claude: { fallback: ['codex', { engine: 'opencode', model: 'x/two' }, { engine: 'codex', model: 'gpt-5.6-sol' }] } } })
    // As the gateway answers: each link with the model it would run, and the link as written.
    const run = (written: { engine: string; model?: string }, model: string) => ({ ...written, model, key: `${written.engine}||${model}`, account: written.engine, label: written.engine, origin: 'config' as const, written })
    const effective = [run({ engine: 'codex' }, 'gpt-mapped'), run({ engine: 'opencode', model: 'x/two' }, 'x/two'), run({ engine: 'codex', model: 'gpt-5.6-sol' }, 'gpt-5.6-sol')]
    chains.current = { profiles: [], subjects: [{ kind: 'engine', id: 'claude', primary: null, configured: null, legacy: true, effective }] }
    await renderSettings()
    expect(engineRows('claude')).toEqual(['codex', 'opencode · x/two', 'codex · gpt-5.6-sol'])
    expect(document.querySelector('[data-engine-card="claude"] [data-chain-legacy-notice]')).toBeTruthy()
    expect(document.querySelector('[data-engine-card="claude"] [data-model-map-floor]')?.textContent).toContain("Codex's own default") // only the bare "codex" link names no model
  })

  it('hides the map when every link names a model, since it would translate nothing', async () => {
    loadConfig({ engines: { claude: { fallback: [{ engine: 'codex', model: 'gpt-5.6-sol' }] } } })
    await renderSettings()

    expect(document.querySelector('[data-engine-card="claude"] [data-model-map-floor]')).toBeNull()
  })

  it('keeps the map for a link without a model', async () => {
    loadConfig({ engines: { claude: { fallback: [{ engine: 'codex', model: 'gpt-5.6-sol' }, { engine: 'opencode' }] } } })
    await renderSettings()

    expect(document.querySelector('[data-engine-card="claude"] [data-model-map-floor]')?.textContent).toContain("opencode's own default")
  })

  it('surfaces a failed save and leaves the edited chain on screen', async () => {
    apiMocks.updateConfig.mockRejectedValue(new Error('engines.claude.fallback[1] "opencode" is not a known engine'))
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))

    expect(await screen.findByText(/Failed to save: engines\.claude\.fallback\[1\]/)).toBeTruthy()
    expect(engineRows('claude')).toEqual(['codex', 'opencode'])
  })
})

/* A balanced group in a chain: one row, written back as the members config spells, never the
 * models the gateway resolved them to. */
describe('Engine Fallbacks section, balanced groups', () => {
  const WRITTEN = { group: [{ engine: 'claude' }, { engine: 'claude', profile: 'spare' }, { engine: 'claude', profile: 'work' }] }
  const ACCOUNTS = { spare: { configDir: '/s' }, work: { configDir: '/w' } }
  const PROFILES = [{ name: 'spare', account: 'claude:spare', configDir: '/s' }, { name: 'work', account: 'claude:work', configDir: '/w' }]

  /** What the gateway says of the chain: each member resolved to the model it would run, in headroom order. */
  const member = (profile: string, headroomPercent: number) => ({
    engine: 'claude', profile, model: 'opus', key: `claude|${profile}|opus`, account: `claude:${profile}`, label: `claude · ${profile} · opus`, origin: 'config',
    written: { engine: 'claude', profile }, health: { state: 'ok' },
    group: { index: 0, written: WRITTEN, headroom: { account: `claude:${profile}`, label: `claude · ${profile}`, state: 'fresh', headroomPercent, weight: headroomPercent, sharePercent: headroomPercent } },
  })
  const START: AccountPick = {
    at: '2026-11-22T14:02:00', trigger: 'start', source: 'engine', groupIndex: 0, picked: 'claude:work', reason: 'weighted',
    candidates: [
      { account: 'claude:work', label: 'claude · work', state: 'fresh', headroomPercent: 70, weight: 70, sharePercent: 70 },
      { account: 'claude:spare', label: 'claude · spare', state: 'fresh', headroomPercent: 30, weight: 30, sharePercent: 30 },
    ],
  }
  const subject = (over: Record<string, unknown> = {}) => ({
    kind: 'engine', id: 'claude', primary: null, configured: [WRITTEN, { engine: 'codex' }], legacy: false,
    effective: [member('work', 70), member('spare', 30), { engine: 'codex', key: 'codex||', account: 'codex', label: 'codex', origin: 'config', written: { engine: 'codex' } }],
    startPick: START, ...over,
  })

  beforeEach(() => {
    loadConfig({ engines: { claude: { accounts: ACCOUNTS, fallback: [WRITTEN, { engine: 'codex' }] } } })
    chains.current = { profiles: PROFILES, subjects: [subject()] }
  })

  it('shows the group as one row beside the links', async () => {
    await renderSettings()

    expect(engineRows('claude')).toEqual(['Balanced group (default login, spare, work)', 'codex'])
  })

  it('leaves a stored group exactly as written when another row is edited', async () => {
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))

    const saved = (await save()).engines.claude.fallback
    expect(saved.slice(0, 2)).toEqual([WRITTEN, { engine: 'codex' }])
  })

  it('saves an edited group as its written members, with no resolved model on any of them', async () => {
    await renderSettings()
    fireEvent.click(screen.getByRole('checkbox', { name: 'spare in link 1 of the Claude chain' }))

    const saved = (await save()).engines.claude.fallback
    expect(saved).toEqual([{ group: [{ engine: 'claude' }, { engine: 'claude', profile: 'work' }] }, { engine: 'codex' }])
    expect(JSON.stringify(saved)).not.toContain('opus')
  })

  it('saves a group added from the button, reordered like any link', async () => {
    loadConfig({ engines: { claude: { accounts: ACCOUNTS, fallback: [{ engine: 'codex' }] } } })
    chains.current = { profiles: PROFILES, subjects: [] }
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a balanced group to the Claude chain' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Balanced group (default login, spare) earlier in the Claude chain' }))

    expect((await saveLast()).engines.claude.fallback).toEqual([{ group: [{ engine: 'claude' }, { engine: 'claude', profile: 'spare' }] }, { engine: 'codex' }])
  })

  it('shows a chain written in names that holds a group as that group, and saves it as written', async () => {
    loadConfig({ engines: { claude: { accounts: ACCOUNTS, fallback: ['codex', WRITTEN] } } })
    chains.current = { profiles: PROFILES, subjects: [subject({ legacy: true, configured: ['codex', WRITTEN], effective: [
      { engine: 'codex', key: 'codex||', account: 'codex', label: 'codex', origin: 'config', written: { engine: 'codex' } },
      { ...member('work', 70), group: { ...member('work', 70).group, index: 1 } },
      { ...member('spare', 30), group: { ...member('spare', 30).group, index: 1 } },
    ] })] }
    await renderSettings()

    expect(engineRows('claude')).toEqual(['codex', 'Balanced group (default login, spare, work)'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'work in link 2 of the Claude chain' }))
    expect((await save()).engines.claude.fallback).toEqual([{ engine: 'codex' }, { group: [{ engine: 'claude' }, { engine: 'claude', profile: 'spare' }] }])
  })

  it('draws the group as one node of members with their headroom, and the shares of new sessions on the start node', async () => {
    await renderSettings()
    fireEvent.click(within(document.querySelector('[data-engine-card="claude"]') as HTMLElement).getByRole('button', { name: 'Diagram' }))

    const group = await waitFor(() => {
      const node = document.querySelector('[data-engine-card="claude"] [data-chain-flow-group]') as HTMLElement
      expect(node).toBeTruthy()
      return node
    })
    expect(Array.from(group.querySelectorAll('[data-chain-flow-member]')).map((m) => m.getAttribute('data-chain-flow-member'))).toEqual(['claude · work · opus', 'claude · spare · opus'])
    expect(group.textContent).toContain('headroom 70%')
    expect(group.textContent).toContain('headroom 30%')
    expect(group.textContent).not.toContain('share')
    expect(document.querySelector('[data-engine-card="claude"] [data-chain-flow-start-note]')?.textContent).toBe('New sessions start on claude · work (share 70%)')
  })
})
