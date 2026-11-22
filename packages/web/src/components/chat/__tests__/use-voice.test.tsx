import { act, renderHook, waitFor } from '@testing-library/react'
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
vi.mock('@/platform/native-bridge', () => ({ nativeBridge: () => undefined }))
vi.mock('@/lib/gateway-transport', () => ({ gatewayTransport: () => ({ profile: { origin: 'https://gw.example.test' } }) }))

import { tapAction, useVoice } from '../use-voice'
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
  resetVoiceConfigCache()
  stubBrowserAudio()
})
afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
})

describe('useVoice', () => {
  it('is disabled, with no controller, while the config is loading and when voice is off', async () => {
    getVoiceConfig.mockResolvedValue({ enabled: false })
    const { result } = renderHook(() => useVoice('s1', null))
    expect(result.current.enabled).toBe(false)
    await waitFor(() => expect(getVoiceConfig).toHaveBeenCalled())
    expect(result.current.enabled).toBe(false)
    expect(controllers).toHaveLength(0)
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

describe('tapAction', () => {
  it('starts when off, resumes when a tap is needed, and stops otherwise in hands-free', () => {
    expect(tapAction('off', false, 'hands-free')).toBe('start')
    expect(tapAction('suspended', true, 'hands-free')).toBe('resume')
    expect(tapAction('speaking', false, 'hands-free')).toBe('stop')
    expect(tapAction('paused', false, 'push-to-talk')).toBe('stop')
    expect(tapAction('listening', false, 'hands-free')).toBe('stop')
  })

  it('in push-to-talk a tap on a running control does nothing: the button is held, the end button stops', () => {
    expect(tapAction('listening', false, 'push-to-talk')).toBe('none')
    expect(tapAction('suspended', false, 'push-to-talk')).toBe('stop')
    expect(tapAction('off', false, 'push-to-talk')).toBe('start')
  })
})
