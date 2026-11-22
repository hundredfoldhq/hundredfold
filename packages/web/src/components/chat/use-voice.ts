import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { BackgroundActivity } from '@/lib/api'
import { api } from '@/lib/api'
import { gatewayTransport } from '@/lib/gateway-transport'
import { nativeBridge } from '@/platform/native-bridge'
import { BACKGROUND_FIRST_READ_GRACE_MS, deriveBackgroundChip, FRESH_CHIP_MEMORY, type BackgroundChip, type ChipMemory } from '@/lib/voice/background-chip'
import type { VoiceClientConfig } from '@/lib/voice/config'
import { awaitsClaim, claimHandoff, dropHandoff, HANDOFF_GRACE_MS, wasAdopted, isClaimed, releaseClaim, type VoiceController, type VoiceSessionStarter } from '@/lib/voice/controller'
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

function createController(config: EnabledConfig, sessionId: string | VoiceSessionStarter): VoiceController | null {
  const native = nativeVoiceBridge(nativeBridge())
  if (native) return new NativeVoiceSession(native, { sessionId, mode: config.mode, origin: gatewayTransport().profile.origin })
  if (browserVoiceProblem()) return null
  return new BrowserVoiceSession({ sessionId, mode: config.mode, bargeIn: config.bargeIn })
}

const NO_STATE = () => INITIAL_VOICE_STATE
const NO_SUBSCRIBE = () => () => undefined

export interface UseVoice {
  /** The control exists: voice is enabled on the gateway and this is a chat that exists, or a new chat voice can create. */
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

/** When the chip next needs a look with no new input: the first-read grace ending, or a finished chip's visible time running out. */
export function nextChipCheckMs(kind: BackgroundChip['kind'] | undefined, pending: boolean, tasks: VoiceUiState['background'], now: number): number | null {
  if (kind === 'finished') return 1_000
  if (kind !== 'running' || pending || tasks.length === 0) return null
  const since = Math.min(...tasks.map((task) => task.startedAt))
  return Math.max(50, since + BACKGROUND_FIRST_READ_GRACE_MS - now)
}

function useBackgroundChip(state: VoiceUiState, controller: VoiceController | null, pending: boolean): BackgroundChip | null {
  const memory = useRef<ChipMemory>(FRESH_CHIP_MEMORY)
  const [, rerender] = useState(0)
  const tasks = state.background
  const derived = deriveBackgroundChip(tasks, pending, memory.current, Date.now())
  useEffect(() => {
    memory.current = derived.memory
    if (derived.done) controller?.clearBackground()
    const wait = nextChipCheckMs(derived.chip?.kind, pending, tasks, Date.now())
    if (wait === null) return
    const timer = setTimeout(() => rerender((n) => n + 1), wait)
    return () => clearTimeout(timer)
  })
  return derived.chip
}

/**
 * The controller for the chat in the pane. On a new chat it is made with a way to create the chat on the first tap; once
 * the pane is bound to the chat it created, that same controller carries on (a new one would stop the conversation).
 */
function useController(
  config: EnabledConfig | null,
  sessionId: string | null | undefined,
  newChat: VoiceSessionStarter | null | undefined,
): VoiceController | null {
  const held = useRef<VoiceController | null>(null)
  const controller = useMemo(() => {
    if (!config || !config.available) return null
    if (sessionId && held.current?.boundSessionId?.() === sessionId) { dropHandoff(held.current); return held.current }
    const handedOver = sessionId ? claimHandoff(sessionId) : undefined
    if (handedOver) return handedOver
    const target = sessionId || newChat
    return target ? createController(config, target) : null
    // The starter is read at tap time through its own ref; only the chat and the config decide the controller.
  }, [config, sessionId, Boolean(newChat)])
  held.current = controller
  useEffect(() => {
    if (controller) releaseClaim(controller)
    // A pane that remounts onto the chat its controller created has claimed it: it carries on in the new pane.
    return () => {
      if (!controller || isClaimed(controller)) return
      if (!awaitsClaim(controller)) { controller.dispose(); return }
      // Offered but not yet claimed: the pane that replaces this one may mount a moment after this one goes.
      setTimeout(() => {
        if (wasAdopted(controller)) return
        dropHandoff(controller)
        controller.dispose()
      }, HANDOFF_GRACE_MS)
    }
  }, [controller])
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
  newChat?: VoiceSessionStarter | null,
): UseVoice {
  const { config, refresh } = useVoiceConfig()
  const enabledConfig = config.enabled ? config : null
  const controller = useController(enabledConfig, sessionId, newChat)
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
    enabled: enabledConfig !== null && (Boolean(sessionId) || Boolean(newChat)),
    state, phase, controller, chip, note, showNote,
    onTap: () => handleTap(tap),
  }
}
