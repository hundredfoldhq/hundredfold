import { VOICE_SPEED_DEFAULT, VOICE_SPEED_PRESETS } from "@hundredfold/gateway-events"
import { FieldRow, SettingsSelect } from "./shared"

/** `1.25×`, without a trailing zero on a round number. */
function times(speed: number): string {
  return `${Number(speed.toFixed(2))}×`
}

/**
 * How fast the assistant speaks its replies in voice mode: the `voice.tts.speed`
 * multiplier in config.yaml, where any value from 0.5 to 2 is allowed. The select
 * offers the named steps; a value the file holds that is not one of them is shown
 * as it is, so opening the page never silently rewrites it. The gateway reads the
 * setting for every sentence, so the next thing said is at the new speed.
 */
export function VoiceSpeedField({
  speed,
  voiceModeOn,
  onChange,
}: {
  speed: unknown
  voiceModeOn: boolean
  onChange: (path: string[], value: unknown) => void
}) {
  const current = typeof speed === "number" && Number.isFinite(speed) ? speed : VOICE_SPEED_DEFAULT
  const preset = VOICE_SPEED_PRESETS.find((p) => p.speed === current)
  return (
    <>
      <FieldRow label="Speaking speed">
        <SettingsSelect
          ariaLabel="Spoken reply speed"
          value={String(current)}
          onChange={(value) => onChange(["voice", "tts", "speed"], Number(value))}
          options={[
            ...VOICE_SPEED_PRESETS.map((p) => ({ value: String(p.speed), label: `${p.label} (${times(p.speed)})` })),
            ...(preset ? [] : [{ value: String(current), label: `Custom (${times(current)})` }]),
          ]}
        />
      </FieldRow>
      <div className="mb-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        How fast voice mode speaks its replies. It applies to the next sentence, with no restart.
        {!voiceModeOn && " Voice mode is off; turn it on with voice.enabled in the config file."}
      </div>
    </>
  )
}
