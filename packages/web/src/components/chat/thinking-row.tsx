import React, { useId } from 'react'
import { ChevronDown, Sparkles } from '@/components/ui/icon'
import type { Message } from '@/lib/conversations'
import { cn } from '@/lib/utils'
import { TimestampDivider } from './message-timestamps'
import { turnSpacerClass } from './turn-spacer'
import { usePersistentExpansion } from './transcript-expansion'

/** The first line worth showing of a block of reasoning, for the collapsed row. */
export function thinkingPreview(content: string): string {
  for (const line of content.split('\n')) {
    const text = line.trim()
    if (text) return text
  }
  return ''
}

/**
 * One block of the model's reasoning, as a quiet disclosure in the assistant column.
 *
 * Collapsed it reads "Thought" (or "Thinking…", shimmering, while it is the block being written)
 * with the first line trailing off in tertiary colour. Open, the whole text sits in secondary colour
 * as plain text beside a hairline rule: line breaks kept, markdown left as written, because it is
 * the model talking to itself and not a reply to be formatted.
 */
export const ThinkingRow = React.memo(function ThinkingRow({ msg, index, live, prevRole, showTimestamp, formattedTimestamp }: {
  msg: Message
  index: number
  /** This is the block being written right now: nothing has come after it and the turn is running. */
  live: boolean
  prevRole: Message['role'] | null
  showTimestamp: boolean
  formattedTimestamp: string
}) {
  const [open, setOpen] = usePersistentExpansion(`thinking:${msg.id || index}`, false)
  const panelId = useId()
  const text = msg.content.trim()
  if (!text) return null

  return (
    <div data-message-id={msg.id || `idx-${index}`} data-thinking-row data-live={live || undefined}>
      {showTimestamp && <TimestampDivider label={formattedTimestamp} />}
      {!showTimestamp && prevRole && <div className={turnSpacerClass(prevRole, 'thinking')} />}
      {/* Share the assistant text gutter so the row lines up with the prose around it. */}
      <div className="assistant-msg-row mb-[var(--space-1)] min-w-0">
        <ThinkingToggle
          live={live}
          open={open}
          preview={thinkingPreview(text)}
          panelId={panelId}
          onToggle={() => setOpen(!open)}
        />
        {open && (
          <div
            id={panelId}
            className="mt-1 ml-[7px] whitespace-pre-wrap border-l border-[var(--separator)] pl-3 text-[length:var(--text-body)] leading-[var(--leading-relaxed)] text-[var(--text-secondary)] [overflow-wrap:anywhere]"
          >
            {text}
          </div>
        )}
      </div>
    </div>
  )
})

function ThinkingToggle({ live, open, preview, panelId, onToggle }: {
  live: boolean
  open: boolean
  preview: string
  panelId: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      className="group -ml-1.5 inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] border-none bg-transparent px-1.5 text-left text-[length:var(--text-caption1)] text-[var(--text-tertiary)] transition-colors duration-150 ease-[var(--ease-smooth)] hover:text-[var(--text-secondary)]"
    >
      <Sparkles size={13} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]" />
      <span className={cn('shrink-0 font-[var(--weight-medium)]', live && 'thinking-shimmer')}>
        {live ? 'Thinking…' : 'Thought'}
      </span>
      {!open && preview && <span className="min-w-0 truncate text-[var(--text-tertiary)]">{preview}</span>}
      <ChevronDown
        size={13}
        aria-hidden="true"
        className={cn('shrink-0 text-[var(--text-quaternary)] transition-transform duration-150 ease-[var(--ease-smooth)]', open && 'rotate-180')}
      />
    </button>
  )
}
