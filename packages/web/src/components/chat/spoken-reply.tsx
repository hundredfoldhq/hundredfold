import { useMemo } from 'react'
import type { Message } from '@/lib/conversations'
import { formatTtfa, splitUnheard, voiceMeta, type UnheardSplit } from '@/lib/voice/message-meta'
import { formatMessage } from './message-markdown'

/* How voice shows up in the transcript: a mic mark on what the user said aloud,
 * the part of an interrupted reply that was never spoken set apart and dimmed,
 * and the time to first audio on the reply. A message with no `voice` facts is
 * a typed one and renders exactly as before. */

export interface VoiceFacts {
  /** The user said this aloud. */
  spoken: boolean
  /** The reply was cut off: where, when the match is trustworthy. */
  unheard: UnheardSplit | null
  ttfaMs: number | null
}

const NO_FACTS: VoiceFacts = { spoken: false, unheard: null, ttfaMs: null }

export function useVoiceFacts(msg: Message, text: string): VoiceFacts {
  const meta = msg.meta
  return useMemo(() => {
    const voice = voiceMeta(meta)
    if (!voice) return NO_FACTS
    if (msg.role === 'user') return { ...NO_FACTS, spoken: voice.utteranceId !== undefined }
    const unheard = voice.interrupted && voice.spokenText !== undefined && !msg.partial ? splitUnheard(text, voice.spokenText) : null
    return { spoken: false, unheard, ttfaMs: voice.ttfaMs ?? null }
  }, [meta, msg.role, msg.partial, text])
}

/** The reply as heard, then a divider, then what was not spoken. */
export function SpokenReplyContent({ split }: { split: UnheardSplit }) {
  const heard = useMemo(() => (split.heard ? formatMessage(split.heard) : null), [split.heard])
  const unheard = useMemo(() => formatMessage(split.unheard), [split.unheard])
  return (
    <>
      {heard}
      <div data-voice-unheard className="mt-[var(--space-2)]">
        <div className="mb-1 flex items-center gap-[var(--space-2)] text-[length:var(--text-caption2,11px)] uppercase tracking-wide text-[var(--text-tertiary)]">
          <span aria-hidden="true" className="h-px w-4 bg-[var(--separator,currentColor)] opacity-40" />
          <span>not spoken</span>
        </div>
        <div className="opacity-55">{unheard}</div>
      </div>
    </>
  )
}

export function VoiceMark() {
  return (
    <span data-voice-mark title="Spoken" role="img" aria-label="Sent by voice" className="mt-1 inline-flex text-[var(--text-tertiary)]">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      </svg>
    </span>
  )
}

export function TtfaReadout({ ms }: { ms: number }) {
  return (
    <div data-voice-ttfa className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
      First audio in {formatTtfa(ms)}
    </div>
  )
}
