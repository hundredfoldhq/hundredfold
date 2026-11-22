import type { VoiceMode, VoiceOnsetSettings } from "@hundredfold/gateway-events"

export type VoiceInstallState = "not_installed" | "installing" | "ready" | "failed"

export interface VoiceInstall {
  state: VoiceInstallState
  progress: number
  reason: string | null
}

/** `GET /api/voice/config` as the control uses it. Never carries keys, URLs or the prompt. */
export type VoiceClientConfig =
  | { enabled: false }
  | {
      enabled: true
      available: boolean
      /** Why it is unavailable, in words a person can act on. */
      reason: string | null
      mode: VoiceMode
      bargeIn: boolean
      onset: VoiceOnsetSettings
      install: VoiceInstall | null
    }

export const VOICE_DISABLED: VoiceClientConfig = { enabled: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseInstall(value: unknown): VoiceInstall | null {
  if (!isRecord(value)) return null
  const state = value.state
  if (state !== "not_installed" && state !== "installing" && state !== "ready" && state !== "failed") return null
  const progress = typeof value.progress === "number" ? Math.min(1, Math.max(0, value.progress)) : 0
  return { state, progress, reason: typeof value.reason === "string" ? value.reason : null }
}

function parseOnset(value: unknown): VoiceOnsetSettings {
  const onset = isRecord(value) ? value : {}
  return {
    threshold: typeof onset.threshold === "number" ? onset.threshold : 0.02,
    minSpeechMs: typeof onset.minSpeechMs === "number" ? onset.minSpeechMs : 250,
  }
}

/** Anything that is not an enabled config reads as disabled, so a broken answer never shows a control. */
export function parseVoiceConfig(raw: unknown): VoiceClientConfig {
  if (!isRecord(raw) || raw.enabled !== true) return VOICE_DISABLED
  const bargeIn = isRecord(raw.bargeIn) ? raw.bargeIn.enabled !== false : true
  return {
    enabled: true,
    available: raw.available === true,
    reason: typeof raw.reason === "string" ? raw.reason : null,
    mode: raw.mode === "push-to-talk" ? "push-to-talk" : "hands-free",
    bargeIn,
    onset: parseOnset(raw.onset),
    install: parseInstall(raw.install),
  }
}
