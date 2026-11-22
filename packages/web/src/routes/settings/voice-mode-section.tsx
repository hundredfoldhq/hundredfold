import { parseCueSettings } from "@/lib/voice/cues"
import { FieldRow, Section, ToggleSwitch } from "./shared"

/**
 * Voice mode (the spoken conversation with a chat), as opposed to the Talk
 * orb's speech-to-speech provider in the Voice section above. Only the sound
 * cues are set here; the rest of the `voice:` block is in config.yaml and
 * docs/voice.md.
 *
 * The block is read tolerantly: a missing or wrong key shows its default, and a
 * write adds only the key that changed.
 */
export interface VoiceModeSectionProps {
  /** `config.voice?.cues`, as stored. */
  cues: unknown
  onChange: (path: string[], value: unknown) => void
}

export function VoiceModeSection({ cues, onChange }: VoiceModeSectionProps) {
  const { enabled, volume } = parseCueSettings(cues)
  const percent = Math.round(volume * 100)
  return (
    <Section title="Voice mode">
      <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
        Soft ticks while the assistant is thinking and a different pair while it runs a tool, so silence does not feel
        like a hang. They stop the moment it speaks or you do. Applies the next time voice mode starts.
      </div>
      <FieldRow label="Sound cues">
        <ToggleSwitch checked={enabled} ariaLabel="Voice mode sound cues" onChange={(value) => onChange(["voice", "cues", "enabled"], value)} />
      </FieldRow>
      <FieldRow label="Cue volume">
        <div className="flex items-center gap-[var(--space-3)]">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={percent}
            disabled={!enabled}
            aria-label="Voice mode cue volume"
            aria-valuetext={`${percent}%`}
            onChange={(event) => onChange(["voice", "cues", "volume"], Number(event.target.value) / 100)}
            className="min-h-[40px] w-full accent-[var(--system-blue)] md:min-h-0"
          />
          <span className="w-10 shrink-0 text-right text-[length:var(--text-footnote)] text-[var(--text-secondary)] tabular-nums">{percent}%</span>
        </div>
      </FieldRow>
    </Section>
  )
}
