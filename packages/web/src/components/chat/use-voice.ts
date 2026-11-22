import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { BackgroundActivity } from '@/lib/api'
import { api } from '@/lib/api'
import { gatewayTransport } from '@/lib/gateway-transport'
import { nativeBridge } from '@/platform/native-bridge'
import { deriveBackgroundChip, FRESH_CHIP_MEMORY, type BackgroundChip, type ChipMemory } from '@/lib/voice/background-chip'
import type { VoiceClientConfig } from '@/lib/voice/config'
import type { VoiceController } from '@/lib/voice/controller'
import { NativeVoiceSession, nativeVoiceBridge } from '@/lib/voice/native'
import { BrowserVoiceSession } from '@/lib/voice/session'
import { INITIAL_VOICE_STATE, voicePhase, type VoicePhase, type VoiceUiState } from '@/lib/voice/state'
import { pendingWork } from './pending-work'
import { useVoiceConfig } from './use-voice-config'

type EnabledConfig = Extract<VoiceClientConfig, { enabled: true }>

/** Why this browser cannot run voice mode, or null when it can. */
export function browserVoiceProblem(): string | null {
  const hasAudio = typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined'
  if (hasAudio && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function') return null
  return 'Voice mode needs a secure (HTTPS) connection and a browser that can use the microphone.'
}

function createController(config: EnabledConfig, sessionId: string): VoiceController | null {
  const native = nativeVoiceBridge(nativeBridge())
  if (native) return new NativeVoiceSession(native, { sessionId, mode: config.mode, origin: gatewayTransport().profile.origin })
  if (browserVoiceProblem()) return null
  return new BrowserVoiceSession({ sessionId, mode: config.mode, bargeIn: config.bargeIn })
}

const NO_STATE = () => INITIAL_VOICE_STATE
const NO_SUBSCRIBE = () => () => undefined

export interface UseVoice {
  /** The control exists: voice is enabled on the gateway and this is a chat that exists. */
  enabled: boolean
  /** Why the control cannot start, in words a person can act on. Null when it can. */
  unavailable: string | null
  /** The local speech engine is being installed; 0..1. */
  installing: number | null
  mode: 'hands-free' | 'push-to-talk'
  state: VoiceUiState
  phase: VoicePhase
  controller: VoiceController | null
  chip: BackgroundChip | null
  /** A one-off line the control asked to show (e.g. the reason it is unavailable). */
  note: string | null
  showNote: (text: string) => void
  /** The tap handler: starts, resumes, stops or explains, depending on where voice is. */
  onTap: () => void
}

/** What a tap on the control does. In push-to-talk the button is held to talk, so only the end button stops. */
export function tapAction(phase: VoicePhase, needsTap: boolean, mode: 'hands-free' | 'push-to-talk'): 'start' | 'resume' | 'stop' | 'none' {
  if (phase === 'off') return 'start'
  if (needsTap) return 'resume'
  return mode === 'hands-free' || phase === 'suspended' || phase === 'paused' ? 'stop' : 'none'
}

function unavailableReason(config: EnabledConfig, controller: VoiceController | null): string | null {
  if (!config.available) return config.reason ?? 'Voice mode is not available on this gateway.'
  if (!controller) return browserVoiceProblem()
  return null
}

function installProgress(config: EnabledConfig): number | null {
  return config.install?.state === 'installing' ? config.install.progress : null
}

/** Auto-clears a note after a while. */
function useNote(): { note: string | null; showNote: (text: string) => void } {
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => setNote(null), 6_000)
    return () => clearTimeout(timer)
  }, [note])
  return { note, showNote: setNote }
}

function useBackgroundChip(state: VoiceUiState, controller: VoiceController | null, pending: boolean): BackgroundChip | null {
  const memory = useRef<ChipMemory>(FRESH_CHIP_MEMORY)
  const [, rerender] = useState(0)
  const tasks = state.background
  const derived = deriveBackgroundChip(tasks, pending, memory.current, Date.now())
  useEffect(() => {
    memory.current = derived.memory
    if (derived.done) controller?.clearBackground()
    if (derived.chip?.kind !== 'finished') return
    const timer = setTimeout(() => rerender((n) => n + 1), 1_000)
    return () => clearTimeout(timer)
  })
  return derived.chip
}

function useController(config: EnabledConfig | null, sessionId: string | null | undefined): VoiceController | null {
  const controller = useMemo(
    () => (config && config.available && sessionId ? createController(config, sessionId) : null),
    [config, sessionId],
  )
  useEffect(() => () => controller?.dispose(), [controller])
  return controller
}

interface TapContext {
  config: EnabledConfig | null
  controller: VoiceController | null
  unavailable: string | null
  phase: VoicePhase
  needsTap: boolean
  showNote: (text: string) => void
  refresh: () => void
}

function explainUnavailable({ config, unavailable, showNote, refresh }: TapContext): void {
  if (config?.install?.state === 'not_installed') void api.installVoice().then(refresh, () => undefined)
  if (unavailable) showNote(unavailable)
}

/** The tap handler. Its start and resume run synchronously inside the tap: iOS allows the microphone and audio only there. */
function handleTap(tap: TapContext): void {
  const { config, controller, unavailable, phase, needsTap } = tap
  if (!config) return
  if (unavailable) return explainUnavailable(tap)
  const action = tapAction(phase, needsTap, config.mode)
  if (action === 'start') void controller?.start()
  else if (action === 'resume') void controller?.resumeFromTap()
  else if (action === 'stop') controller?.stop()
}

interface ConfigFacts {
  unavailable: string | null
  installing: number | null
  mode: 'hands-free' | 'push-to-talk'
}

function configFacts(config: EnabledConfig | null, controller: VoiceController | null): ConfigFacts {
  if (!config) return { unavailable: null, installing: null, mode: 'hands-free' }
  return { unavailable: unavailableReason(config, controller), installing: installProgress(config), mode: config.mode }
}

/** How long after a sync-worthy frame the chat is re-read, so the gateway has stored what the frame describes. */
const SYNC_DELAY_MS = 400

/** Calls `onSync` shortly after the voice state says the stored chat changed. */
function useSync(tick: number, onSync: (() => void) | undefined): void {
  const first = useRef(true)
  const latest = useRef(onSync)
  latest.current = onSync
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const timer = setTimeout(() => latest.current?.(), SYNC_DELAY_MS)
    return () => clearTimeout(timer)
  }, [tick])
}

/** Voice mode for one chat: gateway config, the controller, and the state the composer renders. */
export function useVoice(
  sessionId: string | null | undefined,
  backgroundActivity: BackgroundActivity | null | undefined,
  onSync?: () => void,
): UseVoice {
  const { config, refresh } = useVoiceConfig()
  const enabledConfig = config.enabled ? config : null
  const controller = useController(enabledConfig, sessionId)
  const state = useSyncExternalStore(controller?.subscribe ?? NO_SUBSCRIBE, controller?.getSnapshot ?? NO_STATE)
  useSync(state.syncTick, onSync)
  const { note, showNote } = useNote()
  const pending = pendingWork(backgroundActivity ?? null, null, Date.now()) !== null
  const chip = useBackgroundChip(state, controller, pending)
  const facts = configFacts(enabledConfig, controller)
  const phase = voicePhase(state)
  const tap = { config: enabledConfig, controller, unavailable: facts.unavailable, phase, needsTap: state.needsTap, showNote, refresh }
  return {
    ...facts,
    enabled: enabledConfig !== null && Boolean(sessionId),
    state, phase, controller, chip, note, showNote,
    onTap: () => handleTap(tap),
  }
}
