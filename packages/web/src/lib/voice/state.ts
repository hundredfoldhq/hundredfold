import {
  VOICE_CLOSE,
  type VoiceBackgrounding,
  type VoiceCueSettings,
  type VoiceDetachReason,
  type VoiceMode,
  type VoiceOnsetSettings,
  type VoiceServerFrame,
  type VoiceTurnState,
} from "@hundredfold/gateway-events"
import type { NativeStateEvent } from "@/platform/native-bridge"
import { parseCueSettings } from "./cues"

/** What the control shows. `off` means voice mode is not running for this chat. */
export type VoicePhase = "off" | "paused" | "connecting" | "listening" | "hearing" | "thinking" | "working" | "speaking" | "suspended"

export interface VoiceBackgroundTask {
  taskId: string
  description: string | null
  startedAt: number
}

export interface VoiceReadyInfo {
  onset: VoiceOnsetSettings
  cues: VoiceCueSettings
  backgrounding: VoiceBackgrounding
  partials: boolean
  maxUtteranceSeconds: number
}

export interface VoiceUiState {
  status: "off" | "connecting" | "on" | "suspended" | "paused"
  mode: VoiceMode
  turn: VoiceTurnState
  /** The gateway's voice-activity state: someone is talking. */
  vadSpeaking: boolean
  /** The live, not yet settled transcript of what the user is saying. */
  partial: string
  /** The tool running while `turn` is `working`. */
  tool: string | null
  /** The tool running while `turn` is `working` was moved to the background (it no longer holds the foreground). */
  toolBackgrounded: boolean
  /** Set while a holding line is being spoken. */
  holding: string | null
  ready: VoiceReadyInfo | null
  background: VoiceBackgroundTask[]
  /** Time to first audio of the latest spoken exchange. */
  ttfaMs: number | null
  /** Something to tell the user that is not an error, e.g. the device suspended voice mode. */
  notice: string | null
  error: string | null
  /** Bumped whenever the stored chat has likely changed (an utterance was sent, an exchange settled), so the view can re-read it. */
  syncTick: number
  /** Resuming needs a tap (the browser wants a fresh gesture for the microphone or audio). */
  needsTap: boolean
  /** The assistant hung up at the user's request: the close or stop that follows is the expected end, not a lost connection. */
  hungUp: boolean
}

export const INITIAL_VOICE_STATE: VoiceUiState = {
  status: "off",
  mode: "hands-free",
  turn: "idle",
  vadSpeaking: false,
  partial: "",
  tool: null,
  toolBackgrounded: false,
  holding: null,
  ready: null,
  background: [],
  ttfaMs: null,
  notice: null,
  error: null,
  syncTick: 0,
  needsTap: false,
  hungUp: false,
}

export type VoiceAction =
  | { type: "connecting"; mode: VoiceMode }
  | { type: "frame"; frame: VoiceServerFrame; now: number }
  | { type: "closed"; code: number; reason: string; requested: boolean }
  | { type: "suspended" }
  | { type: "native-state"; state: NativeStateEvent["state"]; reason?: NativeStateEvent["reason"]; code?: number }
  | { type: "resumed" }
  | { type: "needs-tap" }
  | { type: "dismiss-notice" }
  | { type: "background-cleared" }
  | { type: "stopped" }
  | { type: "failed"; message: string }

export const SUSPENDED_NOTICE = "Voice mode was suspended by the device."
export const PAUSED_NOTICE = "Voice mode is paused by a call or another app. It resumes when that ends."

const NATIVE_STOP_ERRORS: Partial<Record<NonNullable<NativeStateEvent["reason"]>, string>> = {
  error: "Voice mode stopped on this device.",
  socket_closed: "Voice connection lost.",
}

/** Why the shell's socket closed, by the close code it forwards. */
const NATIVE_CLOSE_MESSAGES: Record<number, string> = {
  [VOICE_CLOSE.inUse]: "Voice is in use on this chat by someone else.",
  [VOICE_CLOSE.limit]: "Too many voice sessions on this gateway.",
  [VOICE_CLOSE.accessLost]: "You no longer have access to this chat.",
  [VOICE_CLOSE.sessionGone]: "This chat no longer exists.",
}

function nativeStopError(a: ActionOf<"native-state">): string | null {
  if (a.reason === "socket_closed" && a.code !== undefined && NATIVE_CLOSE_MESSAGES[a.code]) return NATIVE_CLOSE_MESSAGES[a.code]
  return a.reason ? (NATIVE_STOP_ERRORS[a.reason] ?? null) : null
}

const TURN_PHASE: Record<VoiceTurnState, VoicePhase> = {
  idle: "listening",
  thinking: "thinking",
  working: "working",
  speaking: "speaking",
}

const OFF_PHASE: Record<Exclude<VoiceUiState["status"], "on">, VoicePhase> = {
  off: "off",
  connecting: "connecting",
  suspended: "suspended",
  paused: "paused",
}

/** What to call the state, from the gateway's turn and the voice-activity flag. */
export function voicePhase(state: VoiceUiState): VoicePhase {
  if (state.status !== "on") return OFF_PHASE[state.status]
  if (state.vadSpeaking || state.partial) return "hearing"
  return TURN_PHASE[state.turn]
}

const CLOSE_MESSAGES: Record<number, string> = {
  [VOICE_CLOSE.protocolError]: "Voice mode hit a protocol error.",
  [VOICE_CLOSE.accessLost]: "You no longer have access to this chat.",
  [VOICE_CLOSE.sessionGone]: "This chat no longer exists.",
  [VOICE_CLOSE.inUse]: "Voice mode is already in use on this chat, in another tab or by someone else.",
  [VOICE_CLOSE.limit]: "Too many voice connections are open on this gateway.",
}

/** A hang-up the assistant made at the user's request is not an error: it ends with nothing to explain. */
const DETACH_MESSAGES: Record<VoiceDetachReason, string | null> = {
  taken_over: "Voice mode moved to another tab.",
  session_gone: "This chat no longer exists.",
  disabled: "Voice was turned off on the gateway.",
  access_lost: "You no longer have access to this chat.",
  shutdown: "The gateway is restarting.",
  ended: null,
}

function ended(state: VoiceUiState, patch: Partial<VoiceUiState>): VoiceUiState {
  return { ...INITIAL_VOICE_STATE, mode: state.mode, ttfaMs: state.ttfaMs, background: state.background, syncTick: state.syncTick + 1, ...patch }
}

function closed(state: VoiceUiState, action: Extract<VoiceAction, { type: "closed" }>): VoiceUiState {
  if (action.requested) return ended(state, {})
  if (state.hungUp) return ended(state, { hungUp: true })
  if (state.status === "suspended") return { ...state, needsTap: true }
  const known = CLOSE_MESSAGES[action.code]
  // A close the gateway already explained with a `detached` frame keeps that explanation.
  // Only once it has ended: a live error frame (a failed utterance) is not an explanation of this close.
  if (!known && state.error && state.status === "off") return ended(state, { error: state.error })
  return ended(state, { error: known ?? "Voice connection lost." })
}

type FrameOf<K extends VoiceServerFrame["type"]> = Extract<VoiceServerFrame, { type: K }>
type FrameHandlers = { [K in VoiceServerFrame["type"]]?: (state: VoiceUiState, frame: FrameOf<K>, now: number) => VoiceUiState }

function onTurn(state: VoiceUiState, f: FrameOf<"turn">): VoiceUiState {
  return {
    ...state, turn: f.state, tool: f.state === "working" ? (f.tool ?? null) : null, holding: null,
    // A new turn state is new work: only the tool that was running when the task was announced counts as moved.
    toolBackgrounded: false,
    // The utterance was handed to the session: whatever partial is left over is stale.
    partial: f.state === "thinking" ? "" : state.partial,
    syncTick: f.state === "idle" && state.turn !== "idle" ? state.syncTick + 1 : state.syncTick,
  }
}

function onBackground(state: VoiceUiState, f: FrameOf<"background">, now: number): VoiceUiState {
  const toolBackgrounded = state.turn === "working" || state.toolBackgrounded
  if (state.background.some((task) => task.taskId === f.taskId)) return toolBackgrounded === state.toolBackgrounded ? state : { ...state, toolBackgrounded }
  return { ...state, toolBackgrounded, background: [...state.background, { taskId: f.taskId, description: f.description, startedAt: now }] }
}

function missedNotice(count: number): string {
  return count === 1 ? "A reply finished while you were away. Playing it now." : `${count} replies finished while you were away. Playing them now.`
}

const FRAME_HANDLERS: FrameHandlers = {
  ready: (state, f) => ({
    ...state, status: "on", turn: "idle", error: null, needsTap: false,
    ready: { onset: f.onset, cues: parseCueSettings(f.cues), backgrounding: f.backgrounding, partials: f.stt.partials, maxUtteranceSeconds: f.limits.maxUtteranceSeconds },
  }),
  vad: (state, f) => ({ ...state, vadSpeaking: f.speaking }),
  transcript: (state, f) => ({
    ...state, partial: f.final ? "" : f.text, error: null,
    syncTick: f.final && f.text.trim() ? state.syncTick + 1 : state.syncTick,
  }),
  turn: onTurn,
  holding: (state, f) => ({ ...state, holding: f.text }),
  background: onBackground,
  missed: (state, f) => ({ ...state, notice: missedNotice(f.messageIds.length) }),
  metrics: (state, f) => ({ ...state, ttfaMs: f.ttfaMs ?? state.ttfaMs, syncTick: state.syncTick + 1 }),
  // A failed utterance is over: its partial and voice-activity flag must not hold the control on "hearing".
  error: (state, f) => ({ ...state, error: f.message, partial: "", vadSpeaking: false }),
  detached: (state, f) => ended(state, { error: DETACH_MESSAGES[f.reason], hungUp: f.reason === "ended" }),
}

function frame(state: VoiceUiState, f: VoiceServerFrame, now: number): VoiceUiState {
  const handler = FRAME_HANDLERS[f.type] as ((s: VoiceUiState, frame: VoiceServerFrame, now: number) => VoiceUiState) | undefined
  return handler ? handler(state, f, now) : state
}

/** The mobile shell's own state: a stop from the lock screen goes back to idle, a call pauses, a failure says so. */
function nativeState(state: VoiceUiState, a: ActionOf<"native-state">): VoiceUiState {
  switch (a.state) {
    case "paused": return state.status === "off" ? state : { ...state, status: "paused", notice: PAUSED_NOTICE, vadSpeaking: false, partial: "" }
    case "running": return state.status === "paused" ? { ...state, status: state.ready ? "on" : "connecting", notice: null } : state
    case "stopped": return state.hungUp ? ended(state, { hungUp: true }) : ended(state, { error: nativeStopError(a) })
    case "connecting": return state
  }
}

type ActionOf<K extends VoiceAction["type"]> = Extract<VoiceAction, { type: K }>
type ActionHandlers = { [K in VoiceAction["type"]]: (state: VoiceUiState, action: ActionOf<K>) => VoiceUiState }

const ACTION_HANDLERS: ActionHandlers = {
  connecting: (state, a) => ({ ...INITIAL_VOICE_STATE, status: "connecting", mode: a.mode, ttfaMs: state.ttfaMs, background: state.background }),
  frame: (state, a) => frame(state, a.frame, a.now),
  closed,
  suspended: (state) => (state.status === "off" ? state : { ...state, status: "suspended", notice: SUSPENDED_NOTICE, vadSpeaking: false, partial: "" }),
  "native-state": nativeState,
  // The chat is re-read on return: replies that finished while the device was away are in it by now.
  // The suspended notice described a state that is over; any other notice stays until dismissed.
  resumed: (state) => ({ ...state, status: "on", needsTap: false, notice: state.notice === SUSPENDED_NOTICE ? null : state.notice, syncTick: state.syncTick + 1 }),
  "needs-tap": (state) => ({ ...state, needsTap: true }),
  "dismiss-notice": (state) => ({ ...state, notice: null, error: null }),
  "background-cleared": (state) => (state.background.length === 0 ? state : { ...state, background: [] }),
  stopped: (state) => ended(state, {}),
  failed: (state, a) => ended(state, { error: a.message }),
}

export function voiceReducer(state: VoiceUiState, action: VoiceAction): VoiceUiState {
  const handler = ACTION_HANDLERS[action.type] as (s: VoiceUiState, a: VoiceAction) => VoiceUiState
  return handler(state, action)
}
