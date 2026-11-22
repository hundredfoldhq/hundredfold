import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { parseVoiceConfig, VOICE_DISABLED, type VoiceClientConfig } from '@/lib/voice/config'

/** While the local speech engine installs, ask again this often. */
const INSTALL_POLL_MS = 2_000

/** One answer shared by every pane; an enabled config is refreshed only while it installs. */
let cached: { value: VoiceClientConfig; at: number } | null = null
const CACHE_MS = 60_000

async function fetchVoiceConfig(): Promise<VoiceClientConfig> {
  const read = (api as { getVoiceConfig?: () => Promise<unknown> }).getVoiceConfig
  if (typeof read !== 'function') return VOICE_DISABLED
  try {
    return parseVoiceConfig(await read())
  } catch {
    // No route (voice absent), no access, or a gateway that predates voice: the control stays hidden.
    return VOICE_DISABLED
  }
}

export function resetVoiceConfigCache(): void {
  cached = null
}

/** The gateway's voice configuration. Disabled until it says otherwise, so nothing shows while it loads. */
export function useVoiceConfig(): { config: VoiceClientConfig; refresh: () => void } {
  const [config, setConfig] = useState<VoiceClientConfig>(cached?.value ?? VOICE_DISABLED)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fresh = cached && Date.now() - cached.at < CACHE_MS && tick === 0
    if (fresh) return
    void fetchVoiceConfig().then((value) => {
      cached = { value, at: Date.now() }
      if (!cancelled) setConfig(value)
    })
    return () => { cancelled = true }
  }, [tick])

  const installing = config.enabled && config.install?.state === 'installing'
  useEffect(() => {
    if (!installing) return
    const timer = setInterval(() => setTick((n) => n + 1), INSTALL_POLL_MS)
    return () => clearInterval(timer)
  }, [installing])

  return { config, refresh: () => setTick((n) => n + 1) }
}
