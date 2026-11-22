import "@/test/preload-menus"
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import type { AccountPick } from '@hundredfold/fallback-chain-wire'
import type { EngineRegistryEntry, EnginesResponse } from '@/lib/api'

/* The new-chat picker when the opencode engine's chain opens with a group of opencode accounts: the
 * account new sessions are balanced from says so, on its row and on the chip. Every other account, and
 * an existing chat, reads as before. */

const apiMocks = vi.hoisted(() => ({ getEngineLimits: vi.fn(), refreshEngines: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: apiMocks }))

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id.slice(id.indexOf('/') + 1), supportsEffort: false, effortLevels: [], ...extra })
const claude: EngineRegistryEntry = { name: 'claude', available: true, defaultModel: 'opus', effortMechanism: 'claude-flag', models: [{ id: 'opus', label: 'Opus 4.8', supportsEffort: false, effortLevels: [] }] }
const opencode: EngineRegistryEntry = {
  name: 'opencode', available: true, defaultModel: 'opencode-go/glm-5.3', effortMechanism: 'none',
  models: [model('opencode-go/glm-5.3'), model('opencode-go-b/glm-5.3', { account: 'go-b' })],
}
const REG: EnginesResponse = { default: 'claude', engines: { claude, opencode } }
vi.mock('@/hooks/use-model-registry', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-model-registry')>()
  return { ...actual, useModelRegistry: () => ({ data: REG, isLoading: false }) }
})

const DECLARED = {
  generatedAt: 'now', default: 'claude', engines: {},
  accounts: { opencode: [
    { account: 'go-a', label: 'go-a', provider: 'opencode-go' },
    { account: 'go-b', label: 'go-b', provider: 'opencode-go-b', base: 'opencode-go' },
  ] },
}

const PICK: AccountPick = {
  at: '2026-11-22T14:02:00', trigger: 'start', source: 'engine', groupIndex: 0, picked: 'opencode/opencode-go', reason: 'weighted',
  candidates: [{ account: 'opencode/opencode-go', label: 'go-a', state: 'fresh', headroomPercent: 60, weight: 60, sharePercent: 60 }],
}
const subject = (kind: 'engine' | 'employee', id: string, primaryModel: string, startPick?: AccountPick) =>
  ({ kind, id, primary: { engine: 'opencode', model: primaryModel }, configured: null, legacy: false, effective: [], ...(startPick ? { startPick } : {}) })

const state: { subjects: ReturnType<typeof subject>[] } = { subjects: [] }
vi.mock('@/hooks/use-fallback-chains', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-fallback-chains')>()
  return { ...actual, useFallbackChains: () => ({ data: { profiles: [], subjects: state.subjects } }) }
})

import { ModelSelectorRow, type SelectorValue } from '../model-selector-row'

beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  if (!g.ResizeObserver) g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({ matches: true, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) as MediaQueryList
  }
})

beforeEach(() => {
  state.subjects = []
  apiMocks.getEngineLimits.mockReset()
  apiMocks.getEngineLimits.mockResolvedValue(DECLARED)
})

function renderUi(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
function Harness({ mode = 'new', initial }: { mode?: 'new' | 'existing'; initial: SelectorValue }) {
  const [val, setVal] = useState(initial)
  return <ModelSelectorRow mode={mode} allowProfiles value={val} onChange={setVal} />
}
const chip = () => screen.getByRole('button', { name: /model and effort/i })
async function openEnginePanel() {
  fireEvent.keyDown(chip(), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
  await screen.findByRole('menuitem', { name: /^back$/i })
}
const rows = () => screen.getAllByRole('menuitem').map((el) => el.textContent ?? '')

describe('the new-chat picker on a balanced opencode chain', () => {
  it('says the account new sessions are balanced from is balanced by headroom, and no other', async () => {
    state.subjects = [subject('engine', 'opencode', 'opencode-go/glm-5.3', PICK)]
    renderUi(<Harness initial={{ engine: 'opencode', model: 'opencode-go/glm-5.3' }} />)
    await waitFor(() => expect(apiMocks.getEngineLimits).toHaveBeenCalled())

    await waitFor(() => expect(chip().getAttribute('aria-label')).toBe('Model and effort: opencode · go-a · balanced by headroom · glm-5.3'))
    await openEnginePanel()
    expect(rows()).toContain('opencode · go-a · balanced by headroom')
    expect(rows()).toContain('opencode · go-b')
  })

  it('leaves the Claude row as it was: an opencode pick is not a Claude balance', async () => {
    state.subjects = [subject('engine', 'opencode', 'opencode-go/glm-5.3', PICK)]
    renderUi(<Harness initial={{ engine: 'claude', model: 'opus' }} />)
    await waitFor(() => expect(apiMocks.getEngineLimits).toHaveBeenCalled())

    await openEnginePanel()
    expect(rows().some((r) => /claude.*balanced/i.test(r))).toBe(false)
  })

  it('names nothing balanced when the chain has no group, or an existing chat is open', async () => {
    state.subjects = [subject('engine', 'opencode', 'opencode-go/glm-5.3')]
    const first = renderUi(<Harness initial={{ engine: 'opencode', model: 'opencode-go/glm-5.3' }} />)
    await waitFor(() => expect(chip().getAttribute('aria-label')).toBe('Model and effort: opencode · go-a · glm-5.3'))
    first.unmount()

    state.subjects = [subject('engine', 'opencode', 'opencode-go/glm-5.3', PICK)]
    renderUi(<Harness mode="existing" initial={{ engine: 'opencode', model: 'opencode-go/glm-5.3' }} />)
    await waitFor(() => expect(chip().getAttribute('aria-label')).toBe('Model and effort: opencode · go-a · glm-5.3'))
  })

  it('does not call a model on another account balanced', async () => {
    state.subjects = [subject('engine', 'opencode', 'opencode-go/glm-5.3', PICK)]
    renderUi(<Harness initial={{ engine: 'opencode', model: 'opencode-go-b/glm-5.3' }} />)
    await waitFor(() => expect(chip().getAttribute('aria-label')).toBe('Model and effort: opencode · go-b · glm-5.3'))
  })
})
