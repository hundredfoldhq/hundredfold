import { act, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getVoiceConfig = vi.hoisted(() => vi.fn())
const installVoice = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { getVoiceConfig, installVoice } }))

const controllers = vi.hoisted(() => [] as Array<{ kind: string; options: unknown; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; resumeFromTap: ReturnType<typeof vi.fn> }>)
const nativeState = vi.hoisted(() => ({ bridge: null as unknown }))

vi.mock('@/lib/voice/session', async () => {
  const { VoiceStore } = await import('@/lib/voice/controller')
  class BrowserVoiceSession {
    store = new VoiceStore()
    start = vi.fn(() => { this.store.dispatch({ type: 'connecting', mode: 'hands-free' }); return Promise.resolve() })
    stop = vi.fn(() => this.store.dispatch({ type: 'stopped' }))
    dispose = vi.fn()
    resumeFromTap = vi.fn(() => Promise.resolve())
    dismissNotice = vi.fn()
    clearBackground = vi.fn(() => this.store.dispatch({ type: 'background-cleared' }))
    pttDown = vi.fn()
    pttUp = vi.fn()
    getSnapshot = () => this.store.snapshot
    subscribe = this.store.subscribe
    kind = 'browser'
    constructor(public options: unknown) { controllers.push(this as never) }
  }
  return { BrowserVoiceSession }
})
vi.mock('@/lib/voice/native', async () => {
  const { VoiceStore } = await import('@/lib/voice/controller')
  class NativeVoiceSession {
    store = new VoiceStore()
    start = vi.fn(() => Promise.resolve())
    stop = vi.fn()
    dispose = vi.fn()
    resumeFromTap = vi.fn(() => Promise.resolve())
    dismissNotice = vi.fn()
    clearBackground = vi.fn()
    pttDown = vi.fn()
    pttUp = vi.fn()
    getSnapshot = () => this.store.snapshot
    subscribe = this.store.subscribe
    kind = 'native'
    constructor(_bridge: unknown, public options: unknown) { controllers.push(this as never) }
  }
  return { NativeVoiceSession, nativeVoiceBridge: () => nativeState.bridge }
})
const principal = vi.hoisted(() => ({ member: null as unknown }))
vi.mock('@/hooks/use-principal', () => ({ useMember: () => principal.member }))
const shell = vi.hoisted(() => ({ bridge: undefined as unknown }))
vi.mock('@/platform/native-bridge', () => ({ nativeBridge: () => shell.bridge }))
vi.mock('@/lib/gateway-transport', () => ({ gatewayTransport: () => ({ profile: { origin: 'https://gw.example.test' } }) }))

import { nextChipCheckMs, tapAction, useVoice } from '../use-voice'
import { resetVoiceConfigCache } from '../use-voice-config'

const ENABLED = { enabled: true, available: true, reason: null, mode: 'hands-free', onset: { threshold: 0.02, minSpeechMs: 250 }, bargeIn: { enabled: true }, install: { state: 'ready', progress: 1 } }

function stubBrowserAudio() {
  vi.stubGlobal('AudioContext', class {})
  vi.stubGlobal('AudioWorkletNode', class {})
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
}

beforeEach(() => {
  getVoiceConfig.mockReset()
  installVoice.mockReset()
  controllers.length = 0
  nativeState.bridge = null
  shell.bridge = undefined
  principal.member = null
  resetVoiceConfigCache()
  stubBrowserAudio()
})
afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
})

describe('useVoice', () => {
  it('says whether it runs inside the mobile shell, for the browser-only hint', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const browser = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(browser.result.current.enabled).toBe(true))
    expect(browser.result.current.inShell).toBe(false)
    shell.bridge = {}
    nativeState.bridge = {}
    const inShell = renderHook(() => useVoice('s2', null))
    await waitFor(() => expect(inShell.result.current.enabled).toBe(true))
    expect(inShell.result.current.inShell).toBe(true)
  })

  it('is disabled, with no controller, while the config is loading and when voice is off', async () => {
    getVoiceConfig.mockResolvedValue({ enabled: false })
    const { result } = renderHook(() => useVoice('s1', null))
    expect(result.current.enabled).toBe(false)
    await waitFor(() => expect(getVoiceConfig).toHaveBeenCalled())
    expect(result.current.enabled).toBe(false)
    expect(controllers).toHaveLength(0)
  })

  it('a board member never requests the voice config and gets no control, no error, no note', async () => {
    principal.member = { user: { id: 'u1' }, boards: [] }
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result } = renderHook(() => useVoice('s1', null))
    await new Promise((r) => setTimeout(r, 50))
    expect(getVoiceConfig).not.toHaveBeenCalled()
    expect(result.current.enabled).toBe(false)
    expect(result.current.unavailable).toBeNull()
    expect(result.current.state.error).toBeNull()
    expect(result.current.note).toBeNull()
    expect(controllers).toHaveLength(0)
  })

  it('a member who signs in after an operator does not inherit the operator\'s cached config', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const first = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(first.result.current.enabled).toBe(true))
    first.unmount()
    principal.member = { user: { id: 'u1' }, boards: [] }
    getVoiceConfig.mockClear()
    const second = renderHook(() => useVoice('s1', null))
    await new Promise((r) => setTimeout(r, 50))
    expect(second.result.current.enabled).toBe(false)
    expect(getVoiceConfig).not.toHaveBeenCalled()
  })

  it('an operator still asks', async () => {
    getVoiceConfig.mockResolvedValue({ enabled: false })
    renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(getVoiceConfig).toHaveBeenCalledTimes(1))
  })

  it('stays disabled when the config call fails (no route, no access, an older gateway)', async () => {
    getVoiceConfig.mockRejectedValue(new Error('403'))
    const { result } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(getVoiceConfig).toHaveBeenCalled())
    expect(result.current.enabled).toBe(false)
  })

  it('is enabled once the gateway says so, for an existing chat only', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    expect(result.current.unavailable).toBeNull()
    const none = renderHook(() => useVoice(null, null))
    await waitFor(() => expect(none.result.current.enabled).toBe(false))
  })

  it('a tap starts the controller synchronously and a second tap stops it', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    act(() => { result.current.onTap() })
    expect(controllers[0].start).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.phase).toBe('connecting'))
    act(() => { result.current.onTap() })
    expect(controllers[0].stop).toHaveBeenCalledTimes(1)
  })

  it('starts, stops and starts again as often as asked in one chat, and then in another, with no reload', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result, rerender } = renderHook(({ id }) => useVoice(id, null), { initialProps: { id: 's1' } })
    await waitFor(() => expect(result.current.enabled).toBe(true))
    const first = controllers[0]
    for (let run = 1; run <= 3; run += 1) {
      expect(result.current.phase).toBe('off')
      act(() => { result.current.onTap() })
      expect(first.start).toHaveBeenCalledTimes(run)
      await waitFor(() => expect(result.current.phase).toBe('connecting'))
      act(() => { result.current.onTap() })
      expect(first.stop).toHaveBeenCalledTimes(run)
      await waitFor(() => expect(result.current.phase).toBe('off'))
    }
    // The same controller served every run: nothing was rebuilt, so nothing could be left held by an earlier one.
    expect(controllers).toHaveLength(1)
    expect(result.current.controller).toBe(first)

    rerender({ id: 's2' })
    await waitFor(() => expect(result.current.enabled).toBe(true))
    const second = controllers.at(-1)!
    expect(second).not.toBe(first)
    expect(result.current.phase).toBe('off')
    act(() => { result.current.onTap() })
    expect(second.start).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.phase).toBe('connecting'))
    act(() => { result.current.onTap() })
    await waitFor(() => expect(result.current.phase).toBe('off'))

    // Back in the first chat: a fresh controller, and it starts again.
    rerender({ id: 's1' })
    const third = controllers.at(-1)!
    act(() => { result.current.onTap() })
    expect(third.start).toHaveBeenCalledTimes(1)
  })

  it('creates the browser session with the configured mode and barge-in', async () => {
    getVoiceConfig.mockResolvedValue({ ...ENABLED, mode: 'push-to-talk', bargeIn: { enabled: false } })
    const { result } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    expect(controllers[0].options).toEqual({ sessionId: 's1', mode: 'push-to-talk', bargeIn: false })
  })

  it('stops capturing when the chat goes away', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result, unmount } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    unmount()
    expect(controllers[0].dispose).toHaveBeenCalled()
  })

  it('switching chats disposes the old controller and makes a new one', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result, rerender } = renderHook(({ id }) => useVoice(id, null), { initialProps: { id: 's1' } })
    await waitFor(() => expect(result.current.enabled).toBe(true))
    rerender({ id: 's2' })
    expect(controllers[0].dispose).toHaveBeenCalled()
    expect(controllers.at(-1)?.options).toMatchObject({ sessionId: 's2' })
  })

  it('reports why voice is unavailable and a tap explains instead of starting', async () => {
    getVoiceConfig.mockResolvedValue({ ...ENABLED, available: false, reason: 'OpenAI key not set: OPENAI_API_KEY' })
    const { result } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(result.current.unavailable).toBe('OpenAI key not set: OPENAI_API_KEY'))
    expect(controllers).toHaveLength(0)
    act(() => { result.current.onTap() })
    expect(result.current.note).toBe('OpenAI key not set: OPENAI_API_KEY')
  })

  it('a tap on a not-installed local engine asks the gateway to install it', async () => {
    installVoice.mockResolvedValue({})
    getVoiceConfig.mockResolvedValue({ ...ENABLED, available: false, reason: 'Speech engine not installed', install: { state: 'not_installed', progress: 0 } })
    const { result } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(result.current.unavailable).toBeTruthy())
    act(() => { result.current.onTap() })
    expect(installVoice).toHaveBeenCalledTimes(1)
  })

  it('reports installing progress and asks again while it installs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      getVoiceConfig.mockResolvedValue({ ...ENABLED, available: false, reason: 'installing', install: { state: 'installing', progress: 0.5 } })
      const { result } = renderHook(() => useVoice('s1', null))
      await act(async () => { await Promise.resolve() })
      expect(result.current.installing).toBe(0.5)
      getVoiceConfig.mockResolvedValue(ENABLED)
      await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
      expect(result.current.installing).toBeNull()
      expect(result.current.unavailable).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a browser that cannot capture audio is unavailable, with a reason', async () => {
    vi.unstubAllGlobals()
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    expect(result.current.unavailable).toMatch(/secure \(HTTPS\)/)
  })

  it('uses the native session when the shell offers it', async () => {
    nativeState.bridge = { runtime: 'tauri' }
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    expect(controllers[0]).toMatchObject({ kind: 'native', options: { sessionId: 's1', mode: 'hands-free', origin: 'https://gw.example.test' } })
  })

  it('a tap while a resume is pending resumes instead of stopping', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    const store = (controllers[0] as unknown as { store: { dispatch: (a: unknown) => void } }).store
    act(() => {
      store.dispatch({ type: 'connecting', mode: 'hands-free' })
      store.dispatch({ type: 'suspended' })
      store.dispatch({ type: 'needs-tap' })
    })
    act(() => { result.current.onTap() })
    expect(controllers[0].resumeFromTap).toHaveBeenCalledTimes(1)
    expect(controllers[0].stop).not.toHaveBeenCalled()
  })

  it('re-reads the chat shortly after an utterance lands, and not at mount', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const onSync = vi.fn()
    const { result } = renderHook(() => useVoice('s1', null, onSync))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    await new Promise((r) => setTimeout(r, 450))
    expect(onSync).not.toHaveBeenCalled()
    const store = (controllers[0] as unknown as { store: { dispatch: (a: unknown) => void } }).store
    act(() => {
      store.dispatch({ type: 'connecting', mode: 'hands-free' })
      store.dispatch({ type: 'frame', now: 1, frame: { type: 'transcript', utteranceId: 'u', text: 'run the tests', final: true } })
    })
    expect(onSync).not.toHaveBeenCalled()
    await waitFor(() => expect(onSync).toHaveBeenCalledTimes(1))
  })

  it('a running chip whose background work was never seen turns finished after the grace, with no other render', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result } = renderHook(() => useVoice('s1', null))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const store = (controllers[0] as unknown as { store: { dispatch: (a: unknown) => void } }).store
      act(() => {
        store.dispatch({ type: 'connecting', mode: 'hands-free' })
        store.dispatch({ type: 'frame', now: Date.now(), frame: { type: 'background', taskId: 't1', description: 'run the tests' } })
      })
      expect(result.current.chip?.kind).toBe('running')
      await act(async () => { await vi.advanceTimersByTimeAsync(15_100) })
      expect(result.current.chip?.kind).toBe('finished')
      await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })
      expect(result.current.chip).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a background chip while the session still has background work, then finished', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const busy = { activeStreams: 0, backgroundAgents: 1, lastActivityAt: new Date().toISOString() }
    const { result, rerender } = renderHook(({ activity }) => useVoice('s1', activity), { initialProps: { activity: busy as never } })
    await waitFor(() => expect(result.current.enabled).toBe(true))
    const store = (controllers[0] as unknown as { store: { dispatch: (a: unknown) => void } }).store
    act(() => {
      store.dispatch({ type: 'connecting', mode: 'hands-free' })
      store.dispatch({ type: 'frame', now: Date.now(), frame: { type: 'background', taskId: 't1', description: 'run the tests' } })
    })
    expect(result.current.chip).toEqual({ kind: 'running', label: 'Running in the background: run the tests' })
    rerender({ activity: { activeStreams: 0, lastActivityAt: new Date().toISOString() } as never })
    expect(result.current.chip).toEqual({ kind: 'finished', label: 'Background work finished' })
  })
})

describe('nextChipCheckMs', () => {
  const task = { taskId: 't', description: null, startedAt: 1000 }
  it('waits out the first-read grace for an unseen running chip, never less than 50 ms', () => {
    expect(nextChipCheckMs('running', false, [task], 6000)).toBe(10_000)
    expect(nextChipCheckMs('running', false, [task], 99_000)).toBe(50)
  })
  it('needs no check while pending work is reported, or with no chip', () => {
    expect(nextChipCheckMs('running', true, [task], 6000)).toBeNull()
    expect(nextChipCheckMs(undefined, false, [], 6000)).toBeNull()
  })
  it('re-checks a finished chip every second so it can go away', () => {
    expect(nextChipCheckMs('finished', false, [task], 6000)).toBe(1000)
  })
})

describe('tapAction', () => {
  it('starts when off, resumes when a tap is needed, and stops otherwise in hands-free', () => {
    expect(tapAction('off', false, 'hands-free')).toBe('start')
    expect(tapAction('suspended', true, 'hands-free')).toBe('resume')
    expect(tapAction('speaking', false, 'hands-free')).toBe('stop')
    expect(tapAction('paused', false, 'push-to-talk')).toBe('stop')
    expect(tapAction('listening', false, 'hands-free')).toBe('stop')
  })

  it('a tap while connecting cancels, in push-to-talk too', () => {
    expect(tapAction('connecting', false, 'hands-free')).toBe('stop')
    expect(tapAction('connecting', false, 'push-to-talk')).toBe('stop')
  })

  it('in push-to-talk a tap on a running control does nothing: the button is held, the end button stops', () => {
    expect(tapAction('listening', false, 'push-to-talk')).toBe('none')
    expect(tapAction('suspended', false, 'push-to-talk')).toBe('stop')
    expect(tapAction('off', false, 'push-to-talk')).toBe('start')
  })
})

describe('useVoice on a new chat', () => {
  const starter = { create: vi.fn(() => Promise.resolve('new-1')), bind: vi.fn(), discard: vi.fn() }

  it('shows the control on a new chat when voice is enabled, and not when voice is off', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const on = renderHook(() => useVoice(null, null, undefined, starter))
    await waitFor(() => expect(on.result.current.enabled).toBe(true))
    expect(on.result.current.unavailable).toBeNull()
    getVoiceConfig.mockResolvedValue({ enabled: false })
    resetVoiceConfigCache()
    const off = renderHook(() => useVoice(null, null, undefined, starter))
    await waitFor(() => expect(getVoiceConfig).toHaveBeenCalledTimes(2))
    expect(off.result.current.enabled).toBe(false)
  })

  it('stays hidden on a new chat for a board member', async () => {
    principal.member = { user: { id: 'u1' }, boards: [] }
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result } = renderHook(() => useVoice(null, null, undefined, starter))
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.enabled).toBe(false)
    expect(controllers).toHaveLength(0)
  })

  it('stays hidden on a new chat when the pane offers no way to create one', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result } = renderHook(() => useVoice(null, null))
    await waitFor(() => expect(getVoiceConfig).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current.enabled).toBe(false)
  })

  it('one tap starts the one controller, made with the starter rather than an id', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result } = renderHook(() => useVoice(null, null, undefined, starter))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    act(() => result.current.onTap())
    expect(controllers).toHaveLength(1)
    expect((controllers[0].options as { sessionId: unknown }).sessionId).toBe(starter)
    expect(controllers[0].start).toHaveBeenCalledTimes(1)
  })

  it('binding the pane to the chat the controller created keeps that controller running', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result, rerender } = renderHook(({ id, s }: { id: string | null; s: typeof starter | null }) => useVoice(id, null, undefined, s), {
      initialProps: { id: null as string | null, s: starter as typeof starter | null },
    })
    await waitFor(() => expect(result.current.enabled).toBe(true))
    const first = controllers[0] as unknown as { boundSessionId?: () => string | null; dispose: ReturnType<typeof vi.fn> }
    first.boundSessionId = () => 'new-1'
    rerender({ id: 'new-1', s: null })
    expect(controllers).toHaveLength(1)
    expect(first.dispose).not.toHaveBeenCalled()
    expect(result.current.controller).toBe(first)
  })

  it('moving to another chat ends the run', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { result, rerender } = renderHook(({ id, s }: { id: string | null; s: typeof starter | null }) => useVoice(id, null, undefined, s), {
      initialProps: { id: null as string | null, s: starter as typeof starter | null },
    })
    await waitFor(() => expect(result.current.enabled).toBe(true))
    const first = controllers[0] as unknown as { boundSessionId?: () => string | null; dispose: ReturnType<typeof vi.fn> }
    first.boundSessionId = () => 'new-1'
    rerender({ id: 'other', s: null })
    expect(first.dispose).toHaveBeenCalled()
    expect(controllers).toHaveLength(2)
  })
  it('a pane that remounts onto the chat the controller created takes the controller over; the old pane leaves it running', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { offerHandoff } = await import('@/lib/voice/controller')
    const seen: { latest: ReturnType<typeof useVoice> | null } = { latest: null }
    function Pane({ id }: { id: string | null }) {
      seen.latest = useVoice(id, null, undefined, id ? null : starter)
      return null
    }
    // The keyed pane: a new key unmounts the old pane and mounts a new one in one commit, rendering the new one first.
    const view = render(<Pane key="tab" id={null} />)
    await waitFor(() => expect(seen.latest?.enabled).toBe(true))
    const first = controllers[0] as unknown as { dispose: ReturnType<typeof vi.fn> }
    offerHandoff('new-1', first as never)
    view.rerender(<Pane key="new-1" id="new-1" />)
    expect(first.dispose).not.toHaveBeenCalled()
    expect(controllers).toHaveLength(1)
    expect(seen.latest?.controller).toBe(first)
    view.unmount()
    expect(first.dispose).toHaveBeenCalledTimes(1)
  })

  it('a pane that is torn down first and replaced a moment later still hands the controller over, past the grace too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      getVoiceConfig.mockResolvedValue(ENABLED)
      const { offerHandoff, HANDOFF_GRACE_MS } = await import('@/lib/voice/controller')
      const old = renderHook(() => useVoice(null, null, undefined, starter))
      await waitFor(() => expect(old.result.current.enabled).toBe(true))
      const first = controllers[0] as unknown as { dispose: ReturnType<typeof vi.fn> }
      offerHandoff('new-3', first as never)
      old.unmount()
      expect(first.dispose).not.toHaveBeenCalled()
      const next = renderHook(() => useVoice('new-3', null))
      expect(next.result.current.controller).toBe(first)
      // The old pane's grace timer still fires; the controller the new pane claimed carries on.
      vi.advanceTimersByTime(HANDOFF_GRACE_MS + 10)
      expect(first.dispose).not.toHaveBeenCalled()
      expect(next.result.current.controller).toBe(first)
      next.unmount()
      expect(first.dispose).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('an offered controller nobody claims is disposed once the grace runs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      getVoiceConfig.mockResolvedValue(ENABLED)
      const { offerHandoff, HANDOFF_GRACE_MS } = await import('@/lib/voice/controller')
      const old = renderHook(() => useVoice(null, null, undefined, starter))
      await waitFor(() => expect(old.result.current.enabled).toBe(true))
      const first = controllers[0] as unknown as { dispose: ReturnType<typeof vi.fn> }
      offerHandoff('new-4', first as never)
      old.unmount()
      expect(first.dispose).not.toHaveBeenCalled()
      vi.advanceTimersByTime(HANDOFF_GRACE_MS + 10)
      expect(first.dispose).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('a controller that was stopped is not handed over', async () => {
    getVoiceConfig.mockResolvedValue(ENABLED)
    const { offerHandoff, dropHandoff } = await import('@/lib/voice/controller')
    const old = renderHook(() => useVoice(null, null, undefined, starter))
    await waitFor(() => expect(old.result.current.enabled).toBe(true))
    const first = controllers[0]
    offerHandoff('new-2', first as never)
    dropHandoff(first as never)
    renderHook(() => useVoice('new-2', null))
    await waitFor(() => expect(controllers).toHaveLength(2))
  })
})

