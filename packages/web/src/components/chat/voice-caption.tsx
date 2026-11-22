import type { VoicePhase } from '@/lib/voice/state'
import type { UseVoice } from './use-voice'

/* The line above the composer while voice mode has something to say: what it
 * is doing (with the live transcript while the user speaks), a notice such as
 * "suspended by the device", an error, and the chip for work that moved to the
 * background. Renders nothing otherwise, so an idle composer is unchanged. */

const STATUS: Record<VoicePhase, (voice: UseVoice) => string | null> = {
  off: (v) => (v.installing !== null ? `Setting up voice… ${Math.round(v.installing * 100)}%` : null),
  connecting: () => 'Connecting…',
  listening: (v) => (v.mode === 'push-to-talk' ? 'Hold the voice button to talk' : 'Listening'),
  hearing: (v) => (v.state.partial ? `“${v.state.partial}”` : 'Hearing you…'),
  thinking: () => 'Thinking…',
  working: (v) => (v.state.tool ? `Working · ${v.state.tool}` : 'Working…'),
  speaking: (v) => v.state.holding ?? 'Speaking',
  paused: () => 'Paused',
  suspended: (v) => (v.state.needsTap ? 'Tap the voice button to resume' : 'Suspended'),
}

export function voiceStatusText(voice: UseVoice): string | null {
  return STATUS[voice.phase](voice)
}

function Dismiss({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="h-5 w-5 shrink-0 cursor-pointer rounded-full border-none bg-transparent text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)]">
      ×
    </button>
  )
}

function Message({ voice, text }: { voice: UseVoice; text: string }) {
  const { state } = voice
  const dismissible = Boolean(state.error || state.notice)
  return (
    <span className="flex items-center gap-1">
      <span role={state.error ? 'alert' : 'status'} data-voice-message className={state.error ? 'text-[var(--system-red)]' : ''}>{text}</span>
      {dismissible && <Dismiss label="Dismiss" onClick={() => voice.controller?.dismissNotice()} />}
    </span>
  )
}

export function VoiceCaption({ voice }: { voice: UseVoice }) {
  if (!voice.enabled) return null
  const status = voiceStatusText(voice)
  const message = voice.state.error ?? voice.state.notice ?? voice.note
  if (!status && !message && !voice.chip) return null
  return (
    <div
      data-voice-caption
      className="relative z-[12] mb-[var(--composer-overlap,0px)] flex shrink-0 flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-1)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]"
    >
      {status && <span role="status" aria-live="polite" data-voice-status={voice.phase} className="min-w-0 truncate">{status}</span>}
      {message && <Message voice={voice} text={message} />}
      {voice.chip && (
        <span data-voice-chip={voice.chip.kind} className="rounded-full bg-[var(--fill-secondary)] px-[var(--space-3)] py-[2px] text-[var(--text-secondary)]">
          {voice.chip.label}
        </span>
      )}
    </div>
  )
}
