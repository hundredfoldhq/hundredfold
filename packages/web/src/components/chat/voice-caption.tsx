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
  'user-paused': () => 'Voice paused. Tap the voice button to resume',
  suspended: (v) => (v.state.needsTap ? 'Voice paused. Tap the voice button to resume' : 'Voice paused'),
}

/** Said once while voice is paused in a browser: only the mobile app keeps it going with the screen locked. */
export const LOCKED_SCREEN_HINT = 'Voice keeps working with the screen locked in the mobile app.'

export function voiceHintText(voice: UseVoice): string | null {
  return voice.phase === 'suspended' && !voice.inShell ? LOCKED_SCREEN_HINT : null
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

function captionParts(voice: UseVoice) {
  return { status: voiceStatusText(voice), message: voice.state.error ?? voice.state.notice ?? voice.note, hint: voiceHintText(voice) }
}

export function VoiceCaption({ voice }: { voice: UseVoice }) {
  if (!voice.enabled) return null
  const { status, message, hint } = captionParts(voice)
  if (!status && !message && !hint && !voice.chip) return null
  return (
    <div data-voice-caption className="relative z-[12] mb-[var(--composer-overlap,0px)] shrink-0 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
      {/* The same centred column and side insets as the composer card and the
          message rows (--chat-measure, space-3 / space-8), so the line starts
          and ends where the thread text does instead of hugging the pane edge. */}
      <div data-voice-caption-measure className="mx-auto flex w-full max-w-[var(--chat-measure)] flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-1)] px-3 py-[var(--space-2)] lg:px-8">
        {status && <span role="status" aria-live="polite" data-voice-status={voice.phase} className="min-w-0 truncate">{status}</span>}
        {message && <Message voice={voice} text={message} />}
        {hint && <span data-voice-hint>{hint}</span>}
        {voice.chip && (
          <span data-voice-chip={voice.chip.kind} className="rounded-full bg-[var(--fill-secondary)] px-[var(--space-3)] py-[2px] text-[var(--text-secondary)]">
            {voice.chip.label}
          </span>
        )}
      </div>
    </div>
  )
}
