import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceServerFrame } from '@hundredfold/gateway-events'
import { INITIAL_VOICE_STATE, voiceReducer, type VoiceUiState } from '@/lib/voice/state'
import type { UseVoice } from '../use-voice'
import { VoiceCaption } from '../voice-caption'
import { VoiceControl, voiceControlLabel, voiceControlView } from '../voice-control'

const READY: VoiceServerFrame = {
  type: 'ready', protocol: 1, sessionId: 's', input: { encoding: 'pcm16', sampleRate: 16000 }, output: { encoding: 'pcm16', sampleRate: 24000 },
  stt: { provider: 'local', partials: true }, tts: { provider: 'local', voice: null },
  onset: { threshold: 0.02, minSpeechMs: 250 }, backgrounding: 'native', limits: { maxUtteranceSeconds: 60 },
}

function stateAfter(...frames: VoiceServerFrame[]): VoiceUiState {
  const connecting = voiceReducer(INITIAL_VOICE_STATE, { type: 'connecting', mode: 'hands-free' })
  return [READY, ...frames].reduce((s, frame) => voiceReducer(s, { type: 'frame', frame, now: 1 }), connecting)
}

function voiceWith(overrides: Partial<UseVoice> = {}, state: VoiceUiState = INITIAL_VOICE_STATE): UseVoice {
  const controller = { pttDown: vi.fn(), pttUp: vi.fn(), stop: vi.fn(), dismissNotice: vi.fn() }
  return {
    enabled: true, unavailable: null, installing: null, mode: 'hands-free', state,
    phase: state.status === 'off' ? 'off' : 'listening', controller: controller as unknown as UseVoice['controller'],
    chip: null, note: null, showNote: vi.fn(), onTap: vi.fn(), ...overrides,
  }
}

function withPhase(state: VoiceUiState, overrides: Partial<UseVoice> = {}): UseVoice {
  const phases = { off: 'off', connecting: 'connecting' } as const
  const phase = state.status === 'on'
    ? (state.vadSpeaking || state.partial ? 'hearing' : state.turn === 'idle' ? 'listening' : state.turn)
    : phases[state.status as 'off' | 'connecting'] ?? 'suspended'
  return voiceWith({ phase, ...overrides }, state)
}

beforeEach(() => vi.clearAllMocks())

describe('VoiceControl', () => {
  it('renders nothing when voice is not enabled', () => {
    const { container } = render(<VoiceControl voice={voiceWith({ enabled: false })} />)
    expect(container.innerHTML).toBe('')
  })

  it('starts on a tap when off', () => {
    const voice = voiceWith()
    render(<VoiceControl voice={voice} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start voice mode' }))
    expect(voice.onTap).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['listening', stateAfter(), /listening/i],
    ['hearing', stateAfter({ type: 'vad', speaking: true }), /Hearing you/],
    ['thinking', stateAfter({ type: 'turn', state: 'thinking' }), /thinking/],
    ['working', stateAfter({ type: 'turn', state: 'working', tool: 'Bash' }), /working on Bash/],
    ['speaking', stateAfter({ type: 'turn', state: 'speaking' }), /speaking/],
  ])('shows the %s state', (view, state, label) => {
    render(<VoiceControl voice={withPhase(state)} />)
    const button = document.querySelector('[data-voice-control]') as HTMLElement
    expect(button.getAttribute('data-state')).toBe(view)
    expect(button.getAttribute('aria-label')).toMatch(label)
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('shows unavailable with the reason, and a tap explains rather than starts', () => {
    const voice = voiceWith({ unavailable: 'Python 3.10+ not found' })
    render(<VoiceControl voice={voice} />)
    const button = document.querySelector('[data-voice-control]') as HTMLElement
    expect(button.getAttribute('data-state')).toBe('unavailable')
    expect(button.getAttribute('aria-label')).toBe('Voice mode unavailable: Python 3.10+ not found')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(voice.onTap).toHaveBeenCalledTimes(1)
  })

  it('shows installing with progress', () => {
    const voice = voiceWith({ installing: 0.4 })
    expect(voiceControlView(voice)).toBe('installing')
    expect(voiceControlLabel(voice)).toBe('Setting up voice mode, 40 percent')
  })

  it('says it was suspended and, when a tap is needed, to tap', () => {
    const suspended = voiceReducer(stateAfter(), { type: 'suspended' })
    expect(voiceControlLabel(withPhase(suspended))).toMatch(/suspended by the device/)
    const needsTap = voiceReducer(suspended, { type: 'needs-tap' })
    expect(voiceControlLabel(withPhase(needsTap))).toBe('Voice mode was suspended. Tap to resume')
  })

  it('push-to-talk: hold to talk through the controller, with a separate end button', () => {
    const voice = withPhase(stateAfter(), { mode: 'push-to-talk' })
    render(<VoiceControl voice={voice} />)
    const talk = document.querySelector('[data-voice-control]') as HTMLElement
    fireEvent.pointerDown(talk)
    fireEvent.pointerUp(talk)
    expect(voice.controller?.pttDown).toHaveBeenCalledTimes(1)
    expect(voice.controller?.pttUp).toHaveBeenCalledTimes(1)
    fireEvent.click(talk)
    expect(voice.onTap).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'End voice mode' }))
    expect(voice.controller?.stop).toHaveBeenCalledTimes(1)
  })

  it('push-to-talk releases the key if the pointer is cancelled', () => {
    const voice = withPhase(stateAfter(), { mode: 'push-to-talk' })
    render(<VoiceControl voice={voice} />)
    fireEvent.pointerCancel(document.querySelector('[data-voice-control]') as HTMLElement)
    expect(voice.controller?.pttUp).toHaveBeenCalledTimes(1)
  })
})

describe('VoiceCaption', () => {
  it('renders nothing when voice is off, so the composer is unchanged', () => {
    const { container } = render(<VoiceCaption voice={voiceWith()} />)
    expect(container.innerHTML).toBe('')
    const disabled = render(<VoiceCaption voice={voiceWith({ enabled: false })} />)
    expect(disabled.container.innerHTML).toBe('')
  })

  it('shows the live transcript while the user speaks', () => {
    const state = stateAfter({ type: 'vad', speaking: true }, { type: 'transcript', utteranceId: 'u', text: 'run the tests', final: false })
    render(<VoiceCaption voice={withPhase(state)} />)
    expect(screen.getByRole('status').textContent).toBe('“run the tests”')
  })

  it.each([
    [stateAfter({ type: 'turn', state: 'thinking' }), 'Thinking…'],
    [stateAfter({ type: 'turn', state: 'working', tool: 'Bash' }), 'Working · Bash'],
    [stateAfter({ type: 'turn', state: 'speaking' }), 'Speaking'],
    [stateAfter(), 'Listening'],
  ])('says what it is doing: %#', (state, text) => {
    render(<VoiceCaption voice={withPhase(state)} />)
    expect(screen.getByRole('status').textContent).toBe(text)
  })

  it('shows installation progress while off', () => {
    render(<VoiceCaption voice={voiceWith({ installing: 0.25 })} />)
    expect(screen.getByRole('status').textContent).toBe('Setting up voice… 25%')
  })

  it('shows the suspension notice with a way to dismiss it', () => {
    const state = voiceReducer(stateAfter(), { type: 'suspended' })
    const voice = withPhase(state)
    render(<VoiceCaption voice={voice} />)
    expect(document.querySelector('[data-voice-message]')?.textContent).toBe('Voice mode was suspended by the device.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(voice.controller?.dismissNotice).toHaveBeenCalled()
  })

  it('shows an error as an alert', () => {
    const state = stateAfter({ type: 'error', code: 'stt_failed', message: 'Speech recognition failed.' })
    render(<VoiceCaption voice={withPhase(state)} />)
    expect(screen.getByRole('alert').textContent).toBe('Speech recognition failed.')
  })

  it('shows the background chip, running and then finished', () => {
    const { rerender } = render(<VoiceCaption voice={withPhase(stateAfter(), { chip: { kind: 'running', label: 'Running in the background: run the tests' } })} />)
    expect(document.querySelector('[data-voice-chip="running"]')?.textContent).toBe('Running in the background: run the tests')
    rerender(<VoiceCaption voice={withPhase(stateAfter(), { chip: { kind: 'finished', label: 'Background work finished' } })} />)
    expect(document.querySelector('[data-voice-chip="finished"]')?.textContent).toBe('Background work finished')
  })

  it('shows the chip even after voice mode was turned off', () => {
    render(<VoiceCaption voice={voiceWith({ chip: { kind: 'running', label: 'Running in the background' } })} />)
    expect(document.querySelector('[data-voice-chip]')).not.toBeNull()
  })

  it('a one-off note (why it is unavailable) shows', () => {
    render(<VoiceCaption voice={voiceWith({ note: 'OpenAI key not set: OPENAI_API_KEY' })} />)
    expect(document.querySelector('[data-voice-message]')?.textContent).toBe('OpenAI key not set: OPENAI_API_KEY')
  })

  it('does not spend an act warning on a rerender', () => {
    const { rerender } = render(<VoiceCaption voice={voiceWith()} />)
    act(() => rerender(<VoiceCaption voice={voiceWith()} />))
  })
})
