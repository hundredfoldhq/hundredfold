import type { UseVoice } from './use-voice'
import type { VoicePhase } from '@/lib/voice/state'

/* The voice-mode control in the composer toolbar, beside Send.
 * One tap starts listening and speaking, a second tap stops; in push-to-talk
 * mode it is held to talk and a small button beside it ends voice mode.
 *
 * The control is absent unless the gateway has voice on, so with voice off the
 * composer is exactly what it was. */

export type VoiceControlView = VoicePhase | 'unavailable' | 'installing'

export function voiceControlView(voice: UseVoice): VoiceControlView {
  if (voice.phase === 'off' && voice.installing !== null) return 'installing'
  if (voice.phase === 'off' && voice.unavailable) return 'unavailable'
  return voice.phase
}

type LabelFn = (voice: UseVoice) => string

const heldLabel = (voice: UseVoice, held: string, free: string) => (voice.mode === 'push-to-talk' ? held : free)

const LABELS: Record<VoiceControlView, LabelFn> = {
  unavailable: (v) => `Voice mode unavailable: ${v.unavailable}`,
  installing: (v) => `Setting up voice mode, ${Math.round((v.installing ?? 0) * 100)} percent`,
  off: () => 'Start voice mode',
  connecting: () => 'Connecting voice mode',
  listening: (v) => heldLabel(v, 'Voice mode on. Hold to talk', 'Voice mode on, listening. Tap to stop'),
  hearing: (v) => heldLabel(v, 'Hearing you. Release to send', 'Hearing you. Tap to stop voice mode'),
  thinking: () => 'Voice mode on, thinking. Tap to stop',
  working: (v) => `Voice mode on, working${v.state.tool ? ` on ${v.state.tool}` : ''}. Tap to stop`,
  speaking: () => 'Voice mode on, speaking. Talk to interrupt, or tap to stop',
  paused: () => 'Voice mode paused by a call or another app. Tap to stop',
  'user-paused': () => 'Voice paused. Tap to resume',
  suspended: (v) => (v.state.needsTap ? 'Voice paused. Tap to resume' : 'Voice paused by the device. Tap to stop'),
}

export function voiceControlLabel(voice: UseVoice): string {
  return LABELS[voiceControlView(voice)](voice)
}

const SPIN = 'animate-[voice-spin_1s_linear_infinite]'

function Bars({ animation }: { animation: string }) {
  const heights = [6, 12, 16, 12, 6]
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {heights.map((h, i) => (
        <rect
          key={i}
          x={3 + i * 4.5}
          y={12 - h / 2}
          width="2.6"
          height={h}
          rx="1.3"
          fill="currentColor"
          style={animation ? { transformOrigin: `${4.3 + i * 4.5}px 12px`, animation: `${animation} ${0.9 + (i % 3) * 0.15}s ease-in-out ${i * 0.08}s infinite` } : undefined}
        />
      ))}
    </svg>
  )
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={SPIN} aria-hidden="true">
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
  )
}

function Icon({ view }: { view: VoiceControlView }) {
  switch (view) {
    case 'connecting':
    case 'thinking':
    case 'working':
    case 'installing':
      return <Spinner />
    case 'listening': return <Bars animation="voice-bar-calm" />
    case 'hearing':
    case 'speaking': return <Bars animation="voice-bar-live" />
    default: return <Bars animation="" />
  }
}

const BASE = 'relative w-[40px] h-[40px] md:w-[36px] md:h-[36px] shrink-0 rounded-full flex items-center justify-center border-none transition-[scale,background-color,color] duration-150 ease-in-out active:scale-[0.96] touch-none select-none cursor-pointer'

function tone(view: VoiceControlView): string {
  switch (view) {
    case 'off': return 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]'
    case 'unavailable': return 'bg-transparent text-[var(--text-tertiary)] opacity-60'
    case 'installing': return 'bg-[var(--fill-secondary)] text-[var(--text-secondary)]'
    case 'paused':
    case 'user-paused':
    case 'suspended': return 'bg-[var(--fill-secondary)] text-[var(--text-secondary)] outline outline-1 outline-dashed outline-[var(--text-tertiary)]'
    case 'hearing': return 'bg-[var(--accent)] text-[var(--accent-contrast)]'
    default: return 'bg-[var(--accent-fill)] text-[var(--accent)]'
  }
}

function EndButton({ onEnd }: { onEnd: () => void }) {
  return (
    <button
      type="button"
      data-voice-end
      aria-label="End voice mode"
      title="End voice mode"
      onClick={onEnd}
      className="w-[28px] h-[28px] shrink-0 rounded-full flex items-center justify-center border-none bg-transparent text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] cursor-pointer"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  )
}

function Slash() {
  return (
    <svg className="absolute" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l16 16" />
    </svg>
  )
}

const KEYFRAMES = `
  @keyframes voice-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes voice-bar-calm { 0%, 100% { transform: scaleY(0.55); } 50% { transform: scaleY(0.9); } }
  @keyframes voice-bar-live { 0%, 100% { transform: scaleY(0.4); } 50% { transform: scaleY(1.5); } }
  @media (prefers-reduced-motion: reduce) { [data-voice-control] svg * { animation: none !important; } }
`

/** In push-to-talk the button is held rather than tapped, once voice mode is running. */
function isHeld(voice: UseVoice): boolean {
  const idle = ['off', 'connecting', 'suspended', 'paused', 'user-paused'].includes(voice.phase)
  return voice.mode === 'push-to-talk' && !idle
}

const HOLD_KEYS = new Set([' ', 'Enter'])

/**
 * Hold-to-talk. The pointer is captured so a release anywhere ends the talk,
 * losing capture, a cancel or focus leaving the button end it too, and Space
 * or Enter hold it for keyboard users. The controller's `pttUp` is idempotent.
 */
function pressProps(voice: UseVoice, held: boolean) {
  if (!held) return { onClick: voice.onTap }
  const down = () => voice.controller?.pttDown()
  const up = () => voice.controller?.pttUp()
  return {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not capturable: the window-level fallbacks below end the talk */ }
      down()
    },
    onPointerUp: up,
    onPointerCancel: up,
    onLostPointerCapture: up,
    onBlur: up,
    onKeyDown: (e: React.KeyboardEvent) => { if (HOLD_KEYS.has(e.key) && !e.repeat) { e.preventDefault(); down() } },
    onKeyUp: (e: React.KeyboardEvent) => { if (HOLD_KEYS.has(e.key)) { e.preventDefault(); up() } },
  }
}

export function VoiceControl({ voice }: { voice: UseVoice }) {
  if (!voice.enabled) return null
  const view = voiceControlView(voice)
  const label = voiceControlLabel(voice)
  const held = isHeld(voice)
  return (
    <div className="flex shrink-0 items-center gap-[var(--space-1)]" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        data-voice-control
        data-state={view}
        aria-label={label}
        title={label}
        aria-pressed={voice.phase !== 'off'}
        aria-disabled={view === 'unavailable' || undefined}
        aria-busy={view === 'connecting' || view === 'installing' || undefined}
        className={`${BASE} ${tone(view)}`}
        {...pressProps(voice, held)}
      >
        <Icon view={view} />
        {view === 'unavailable' && <Slash />}
      </button>
      {held && <EndButton onEnd={() => voice.controller?.stop()} />}
      <style>{KEYFRAMES}</style>
    </div>
  )
}
