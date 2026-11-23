import { Section } from "./shared"
import { VoiceSpeedField } from "./voice-speed-field"

interface VoiceSectionProps {
  onChange: (path: string[], value: unknown) => void
  /** `voice.tts.speed`: how fast voice mode speaks its replies. */
  spokenSpeed?: unknown
  /** `voice.enabled`. */
  voiceModeOn?: boolean
}

/** The Voice settings section: the fields that shape voice mode. */
export function VoiceSection({ onChange, spokenSpeed, voiceModeOn }: VoiceSectionProps) {
  return (
    <Section title="Voice">
      <VoiceSpeedField speed={spokenSpeed} voiceModeOn={voiceModeOn ?? false} onChange={onChange} />
    </Section>
  )
}
