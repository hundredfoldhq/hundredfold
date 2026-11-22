import "@/test/preload-menus"
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AccountPick } from '@hundredfold/fallback-chain-wire'
import type { EnginesResponse } from '@/lib/api'

/* The new-chat picker when the chosen subject's chain opens with a balanced group: the default
 * option is the weighted split ("Balanced (by headroom)"), sends no profile, and choosing a
 * profile still sends claude:<name>. */

function renderRow(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  if (!g.ResizeObserver) g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
})

const REG: EnginesResponse = {
  default: 'claude',
  engines: {
    claude: {
      name: 'claude', available: true, defaultModel: 'opus', effortMechanism: 'claude-flag',
      models: [{ id: 'opus', label: 'Opus 4.8', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] }],
    },
    opencode: {
      name: 'opencode', available: true, defaultModel: 'opencode-go/x', effortMechanism: 'none',
      models: [{ id: 'opencode-go/x', label: 'X', supportsEffort: false, effortLevels: [] }],
    },
  },
}

vi.mock('@/hooks/use-model-registry', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-model-registry')>()
  return { ...actual, useModelRegistry: () => ({ data: REG, isLoading: false }) }
})

const PICK: AccountPick = {
  at: '2026-11-22T14:02:00', trigger: 'start', source: 'engine', groupIndex: 0, picked: 'claude:work', reason: 'weighted',
  candidates: [{ account: 'claude:work', label: 'work', state: 'fresh', headroomPercent: 60, weight: 60, sharePercent: 60 }],
}
const subject = (kind: 'engine' | 'employee', id: string, startPick?: AccountPick) =>
  ({ kind, id, primary: null, configured: null, legacy: false, effective: [], ...(startPick ? { startPick } : {}) })

const state: { subjects: ReturnType<typeof subject>[]; employees: (string | undefined)[] } = { subjects: [], employees: [] }
vi.mock('@/hooks/use-fallback-chains', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-fallback-chains')>()
  return {
    ...actual,
    useFallbackChains: (employee?: string) => {
      state.employees.push(employee)
      return { data: { profiles: [{ name: 'work', account: 'claude:work', configDir: '/x/work' }], subjects: state.subjects } }
    },
  }
})

import { ModelSelectorRow, type SelectorValue } from '../model-selector-row'
import { composeSessionEngine } from '../new-chat-helpers'

function Harness({ mode = 'new', employee, employeeRemote, initial = { engine: 'claude', model: 'opus' }, onChange }: {
  mode?: 'new' | 'existing'
  employee?: string
  employeeRemote?: boolean
  initial?: SelectorValue
  onChange?: (v: SelectorValue) => void
}) {
  const [val, setVal] = useState<SelectorValue>(initial)
  return <ModelSelectorRow mode={mode} allowProfiles employee={employee} employeeRemote={employeeRemote} value={val} onChange={(v) => { setVal(v); onChange?.(v) }} />
}

const chip = () => screen.getByRole('button', { name: /model and effort/i })
async function openEnginePanel() {
  fireEvent.keyDown(chip(), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
}

beforeEach(() => { state.subjects = []; state.employees = [] })

describe('the new-chat default option on a balanced subject', () => {
  it('reads "Balanced (by headroom)" for the Claude engine\'s own chain, in the picker and on the chip', async () => {
    state.subjects = [subject('engine', 'claude', PICK)]
    renderRow(<Harness />)

    expect(chip().getAttribute('aria-label')).toContain('Claude · Balanced (by headroom) · Opus 4.8')
    await openEnginePanel()
    expect(await screen.findByRole('menuitem', { name: /^claude · balanced \(by headroom\)$/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /own login/i })).toBeNull()
  })

  it('picking it sends no profile, and picking a profile still sends claude:<name>', async () => {
    state.subjects = [subject('engine', 'claude', PICK)]
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', profile: 'work' }} onChange={onChange} />)

    await openEnginePanel()
    fireEvent.click(await screen.findByRole('menuitem', { name: /claude · balanced/i }))
    const balanced = onChange.mock.calls.at(-1)?.[0] as SelectorValue
    expect(balanced.engine).toBe('claude')
    expect(balanced.profile).toBeUndefined()
    expect(composeSessionEngine(balanced.engine, balanced.profile)).toBe('claude')

    // Picking a row goes back to the model panel with the menu still open.
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /claude · work/i }))
    const named = onChange.mock.calls.at(-1)?.[0] as SelectorValue
    expect(composeSessionEngine(named.engine, named.profile)).toBe('claude:work')
  })

  it('asks for the chosen employee\'s chain and follows the employee\'s subject, not the engine\'s', () => {
    state.subjects = [subject('engine', 'claude'), subject('employee', 'builder', PICK)]
    renderRow(<Harness employee="builder" />)

    expect(state.employees).toContain('builder')
    expect(chip().getAttribute('aria-label')).toContain('Balanced (by headroom)')
  })

  it('stays "Own login" for an employee whose chain has no home group, even when the engine\'s has one', () => {
    state.subjects = [subject('engine', 'claude', PICK), subject('employee', 'builder')]
    renderRow(<Harness employee="builder" />)

    expect(chip().getAttribute('aria-label')).toContain('Claude · Own login')
  })

  it('stays "Own login" when the chain has no group', async () => {
    state.subjects = [subject('engine', 'claude')]
    renderRow(<Harness />)
    await openEnginePanel()
    expect(await screen.findByRole('menuitem', { name: /^claude · own login$/i })).toBeTruthy()
  })

  it('never calls an existing chat\'s plain row "Balanced": it shows the account the session is on', async () => {
    state.subjects = [subject('engine', 'claude', PICK)]
    renderRow(<Harness mode="existing" />)

    expect(chip().getAttribute('aria-label')).toContain('Claude · Own login')
    await openEnginePanel()
    expect(await screen.findByRole('menuitem', { name: /^claude · own login$/i })).toBeTruthy()
  })
})
