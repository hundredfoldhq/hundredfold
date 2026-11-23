import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type React from 'react'
import { ChatPane } from '../chat-pane'
import { claimHandoff, dropHandoff, type VoiceController, type VoiceSessionStarter } from '@/lib/voice/controller'
import { INITIAL_VOICE_STATE } from '@/lib/voice/state'

const apiMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(() => Promise.resolve({})),
  updateSession: vi.fn(() => Promise.resolve({})),
  sendMessage: vi.fn(() => Promise.resolve({})),
}))
vi.mock('@/lib/api', () => ({ api: apiMocks }))

const voiceCalls = vi.hoisted(() => [] as Array<{ sessionId: unknown; newChat: VoiceSessionStarter | null | undefined }>)
vi.mock('@/components/chat/use-voice', () => ({
  useVoice: (sessionId: unknown, _activity: unknown, _onSync: unknown, newChat?: VoiceSessionStarter | null) => {
    voiceCalls.push({ sessionId, newChat })
    return {
      enabled: false, unavailable: null, installing: null, mode: 'hands-free', state: INITIAL_VOICE_STATE, phase: 'off',
      controller: null, chip: null, note: null, showNote: () => {}, onTap: () => {},
    }
  },
}))

const principal = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/hooks/use-principal', () => ({ usePrincipal: () => principal.value }))

const keep = vi.hoisted(() => vi.fn())
vi.mock('@/components/chat/pane-tabs-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/chat/pane-tabs-context')>()),
  usePaneTabsKeep: () => keep,
}))

const orgResult = vi.hoisted(() => ({ data: { employees: [] } }))
vi.mock('@/hooks/use-employees', () => ({ useOrg: () => orgResult }))
vi.mock('@/hooks/use-features', () => ({
  useFeatures: () => ({ data: { notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 300_000, staleAfterMinutes: 60 } }, isPending: false }),
}))

const liveSession = vi.hoisted(() => ({
  messages: [], streamingText: '', loading: false, hydrating: false, session: null, error: null, liveContextTokens: null,
  backgroundActivity: null, reload: () => {}, beginSend: () => {}, failSend: () => {}, appendLocal: () => {}, reset: () => {},
}))
vi.mock('@/hooks/use-live-session', () => ({ useLiveSession: () => liveSession }))
vi.mock('@/components/chat/chat-input', () => ({ ChatInput: () => <div data-testid="chat-input" /> }))
vi.mock('@/components/chat/model-selector-row', () => ({ ModelSelectorRow: () => null }))
vi.mock('@/components/chat/chat-messages', () => ({ ChatMessages: () => <div data-testid="messages" /> }))
vi.mock('@/components/chat/chat-employee-picker', () => ({ ChatEmployeePicker: () => null }))
vi.mock('@/components/chat/background-activity-status', () => ({ BackgroundActivityStatus: () => null }))
vi.mock('@/components/chat/cli-keybar', () => ({ CliKeybar: () => null }))

function renderPane(props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  return render(<ChatPane sessionId={null} isActive onFocus={() => {}} subscribe={() => () => {}} {...props} />)
}

const latestStarter = () => voiceCalls[voiceCalls.length - 1]?.newChat ?? null
const OPERATOR = { kind: 'operator' }
const MEMBER = { kind: 'member', user: { id: 'u1' }, boards: [] }

beforeEach(() => {
  voiceCalls.length = 0
  principal.value = OPERATOR
  apiMocks.createSession.mockReset()
  apiMocks.createSession.mockResolvedValue({ id: 'new-1' })
  apiMocks.deleteSession.mockClear()
  keep.mockClear()
  localStorage.clear()
})

describe('ChatPane voice on a new chat', () => {
  it('offers a way to create the chat to the operator', () => {
    renderPane()
    expect(latestStarter()).not.toBeNull()
  })

  it('offers no way to create a chat to a board member, so the control stays hidden', () => {
    principal.value = MEMBER
    renderPane()
    expect(voiceCalls.length).toBeGreaterThan(0)
    expect(voiceCalls.every((call) => call.newChat === null)).toBe(true)
  })

  it('offers no starter on a chat that already exists', () => {
    renderPane({ sessionId: 's1' })
    expect(latestStarter()).toBeNull()
  })

  it('creating the chat moves nothing: the pane, the tab and the chat list wait for the controller to bind', async () => {
    const onSessionCreated = vi.fn()
    const onRefresh = vi.fn()
    renderPane({ onSessionCreated, onRefresh })
    await expect(latestStarter()!.create()).resolves.toBe('new-1')
    expect(apiMocks.createSession).toHaveBeenCalledTimes(1)
    expect(apiMocks.createSession.mock.calls[0][0]).toMatchObject({ speech: true })
    expect(apiMocks.createSession.mock.calls[0][0]).not.toHaveProperty('prompt')
    expect(onSessionCreated).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(keep).not.toHaveBeenCalled()
  })

  it('a run stopped while the chat was being created discards it, and the pane never binds to it', async () => {
    const onSessionCreated = vi.fn()
    const onRefresh = vi.fn()
    renderPane({ onSessionCreated, onRefresh })
    const starter = latestStarter()!
    const id = await starter.create()
    starter.discard(id)
    expect(apiMocks.deleteSession).toHaveBeenCalledWith('new-1')
    expect(onSessionCreated).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(keep).not.toHaveBeenCalled()
    expect(claimHandoff('new-1')).toBeUndefined()
  })

  it('binding a live run moves the pane onto the chat and leaves the controller for the pane that replaces it', async () => {
    const onSessionCreated = vi.fn()
    const onRefresh = vi.fn()
    renderPane({ onSessionCreated, onRefresh })
    const starter = latestStarter()!
    const controller = { dispose: vi.fn() } as unknown as VoiceController
    const id = await starter.create()
    starter.bind(id, controller)
    expect(onSessionCreated).toHaveBeenCalledExactlyOnceWith('new-1')
    expect(keep).toHaveBeenCalledExactlyOnceWith('new-1')
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(claimHandoff('new-1')).toBe(controller)
    dropHandoff(controller)
  })

  it('two taps while the chat is being created make one chat', async () => {
    renderPane()
    const starter = latestStarter()!
    const [a, b] = await Promise.all([starter.create(), starter.create()])
    expect(a).toBe('new-1')
    expect(b).toBe('new-1')
    expect(apiMocks.createSession).toHaveBeenCalledTimes(1)
  })
})
