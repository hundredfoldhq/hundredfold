import { Textarea } from "@/components/ui/textarea"
import { Section } from "./shared"

/** The same limit the gateway puts on `voice.stylePrompt`. */
export const VOICE_STYLE_MAX_CHARS = 2000

const EXAMPLE = "Replies much shorter, more personal, a bit funny. Make jokes."

/**
 * Your own directions for how spoken replies sound, added to the voice
 * instructions on every voice turn (`voice.stylePrompt` in config.yaml).
 * Shown only when voice mode is on: the key means nothing without it.
 */
export function VoiceStyleSection({
  value,
  onChange,
}: {
  value: string
  onChange: (path: string[], value: unknown) => void
}) {
  return (
    <Section title="Voice style">
      <label
        htmlFor="voice-style-prompt"
        className="block pb-[var(--space-2)] text-[length:var(--text-subheadline)] text-[var(--text-secondary)]"
      >
        How should spoken replies sound?
      </label>
      <Textarea
        id="voice-style-prompt"
        aria-label="Voice style prompt"
        rows={3}
        maxLength={VOICE_STYLE_MAX_CHARS}
        value={value}
        placeholder={EXAMPLE}
        onChange={(event) => onChange(["voice", "stylePrompt"], event.target.value)}
      />
      <div className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        Added to the voice instructions on every voice turn, in the browser and the app. Leave it empty for the
        default. Applies on the next spoken turn.
      </div>
    </Section>
  )
}
