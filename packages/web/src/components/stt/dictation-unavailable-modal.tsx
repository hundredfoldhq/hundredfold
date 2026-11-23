import { Link } from "react-router-dom"

/**
 * Shown when a dictation mic (Notes, Todo quick capture) is tapped while voice mode's speech engine is off or
 * not ready. Dictation has no engine of its own: it runs on the one voice mode is set up with, so the way out
 * is the voice settings. Shared by both mics.
 */

interface DictationUnavailableModalProps {
  open: boolean
  reason: string | null
  onClose: () => void
}

export function DictationUnavailableModal({ open, reason, onClose }: DictationUnavailableModalProps) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-labelledby="dictation-unavailable-title"
        className="bg-[var(--bg)] rounded-[var(--radius-lg)] p-[var(--space-6)] max-w-[400px] w-[90%] shadow-[var(--shadow-overlay)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="dictation-unavailable-title"
          className="text-[length:var(--text-headline)] font-[var(--weight-bold)] text-[var(--text-primary)] mb-[var(--space-2)]"
        >
          Dictation needs voice mode
        </h3>

        <p className="text-[length:var(--text-body)] text-[var(--text-secondary)] mb-[var(--space-5)] leading-[var(--leading-relaxed)]">
          {reason ?? "Dictation uses voice mode's speech engine."}
        </p>

        <div className="flex gap-[var(--space-3)] justify-end">
          <button
            onClick={onClose}
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] text-[var(--text-primary)] border-none cursor-pointer text-[length:var(--text-body)]"
          >
            Close
          </button>
          <Link
            to="/settings"
            onClick={onClose}
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-black no-underline text-[length:var(--text-body)] font-[var(--weight-semibold)]"
          >
            Open settings
          </Link>
        </div>
      </div>
    </div>
  )
}
