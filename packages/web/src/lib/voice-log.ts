/**
 * Diagnostic logging for the voice and read-aloud audio paths.
 *
 * One line per event, `event=<snake_case> key=value ...`, tagged `voice` so it
 * lands in the shared in-app debug log (see debug-log.ts, "Share debug log" in
 * the mobile menu) and is mirrored to the console, where the line starts with
 * `[voice]`. Every line also carries `dt`, the milliseconds since the previous
 * voice line, so stalls show up without doing arithmetic on timestamps.
 *
 * Levels:
 * - `warn`: something that can explain bad audio (a sequence gap, an underrun, a
 *   dropped or undecodable chunk, an unexpected close).
 * - `info` (default): lifecycle and one summary per spoken segment.
 * - `debug`: one line per chunk, frame or read. Off unless switched on, and the
 *   field builder is only run when it is on, so a disabled line costs one check.
 *
 * Debug is switched on without a rebuild: open the app with `?voice_debug=1`
 * (`?voice_debug=0` switches it off again), or set the `hundredfold:voice-debug`
 * localStorage key to `1`, or call `window.__voiceDebug(true)` from a console.
 * The choice is remembered in localStorage where storage is available.
 *
 * Logging never throws and never records secrets or text: callers pass ids,
 * counts, lengths and timings. String values are capped as a last defence.
 */
import { dlog } from "@/lib/debug-log"

export type VoiceLogLevel = "debug" | "info" | "warn"
export type VoiceLogValue = string | number | boolean | null | undefined
export type VoiceLogFields = Record<string, VoiceLogValue>

export const VOICE_LOG_TAG = "voice"
export const VOICE_DEBUG_STORAGE_KEY = "hundredfold:voice-debug"
export const VOICE_DEBUG_PARAM = "voice_debug"

/** Longest string value written to a line; anything longer is cut and marked. */
const MAX_VALUE_CHARS = 64
const SAFE_VALUE = /^[A-Za-z0-9_.:/@+-]+$/

let debugOverride: boolean | null = null
let lastAt: number | null = null

function nowMs(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now()
  } catch { /* fall through */ }
  return Date.now()
}

function storageGet(): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(VOICE_DEBUG_STORAGE_KEY) } catch { return null }
}

function storageSet(on: boolean): void {
  try {
    if (typeof localStorage === "undefined") return
    if (on) localStorage.setItem(VOICE_DEBUG_STORAGE_KEY, "1")
    else localStorage.removeItem(VOICE_DEBUG_STORAGE_KEY)
  } catch { /* storage unavailable: the choice lasts for this page only */ }
}

function paramValue(): string | null {
  try { return typeof location === "undefined" ? null : new URLSearchParams(location.search).get(VOICE_DEBUG_PARAM) } catch { return null }
}

function truthy(value: string | null): boolean {
  return value !== null && ["1", "true", "on", "yes"].includes(value.trim().toLowerCase())
}

/** Resolves the switch once: a URL parameter wins and is remembered, then storage. */
function resolveDebug(): boolean {
  const param = paramValue()
  if (param !== null) {
    const on = truthy(param)
    storageSet(on)
    return on
  }
  return truthy(storageGet())
}

export function voiceDebugEnabled(): boolean {
  if (debugOverride === null) debugOverride = resolveDebug()
  return debugOverride
}

export function setVoiceDebug(on: boolean): void {
  debugOverride = on
  storageSet(on)
}

/** Forgets the cached switch and the previous-line clock; for tests. */
export function resetVoiceLog(): void {
  debugOverride = null
  lastAt = null
}

function formatValue(value: Exclude<VoiceLogValue, undefined>): string {
  if (value === null) return "null"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value)
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000)
  }
  if (typeof value === "boolean") return value ? "1" : "0"
  const text = value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}...` : value
  return SAFE_VALUE.test(text) ? text : JSON.stringify(text)
}

/** `event=name key=value ...`; undefined values are left out. */
export function formatVoiceEvent(event: string, fields?: VoiceLogFields): string {
  let line = `event=${event}`
  if (fields) {
    for (const key of Object.keys(fields)) {
      const value = fields[key]
      if (value !== undefined) line += ` ${key}=${formatValue(value)}`
    }
  }
  return line
}

type FieldsInput = VoiceLogFields | (() => VoiceLogFields)

function emit(level: VoiceLogLevel, event: string, input?: FieldsInput): void {
  try {
    if (level === "debug" && !voiceDebugEnabled()) return
    const fields = typeof input === "function" ? input() : input
    const at = nowMs()
    const dt = lastAt === null ? 0 : Math.max(0, Math.round(at - lastAt))
    lastAt = at
    const line = `${formatVoiceEvent(event, fields)} dt=${dt}`
    dlog(VOICE_LOG_TAG, line)
    const text = `[${VOICE_LOG_TAG}] ${line}`
    if (level === "warn") console.warn(text)
    else if (level === "info") console.info(text)
    else console.debug(text)
  } catch { /* logging must never break audio */ }
}

export const voiceLog = {
  debug: (event: string, fields?: FieldsInput): void => emit("debug", event, fields),
  info: (event: string, fields?: FieldsInput): void => emit("info", event, fields),
  warn: (event: string, fields?: FieldsInput): void => emit("warn", event, fields),
}

/** The clock the voice log uses, in milliseconds (monotonic where the browser has one). */
export function voiceNow(): number {
  return nowMs()
}

/** An error as a loggable pair: its name and a short message with any URL taken out. */
export function errorFields(error: unknown): VoiceLogFields {
  try {
    // Duck-typed: a DOMException from another realm is not `instanceof Error`.
    if (error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string") {
      const { name, message } = error as { name: string; message?: unknown }
      return { err: name, err_msg: typeof message === "string" ? message.replace(/\S+:\/\/\S+/g, "<url>").slice(0, 80) : undefined }
    }
    if (typeof error === "string") return { err_msg: error.replace(/\S+:\/\/\S+/g, "<url>").slice(0, 80) }
    return { err: typeof error }
  } catch {
    return { err: "unknown" }
  }
}

/** What an AudioContext says about itself, tolerating the partial fakes tests use. */
export function contextFields(ctx: unknown, prefix = "ctx"): VoiceLogFields {
  try {
    const c = ctx as { sampleRate?: unknown; state?: unknown; baseLatency?: unknown; outputLatency?: unknown; currentTime?: unknown }
    const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
    return {
      [`${prefix}_rate`]: num(c.sampleRate),
      [`${prefix}_state`]: typeof c.state === "string" ? c.state : undefined,
      [`${prefix}_base_latency_ms`]: num(c.baseLatency) === undefined ? undefined : Math.round((c.baseLatency as number) * 1000),
      [`${prefix}_output_latency_ms`]: num(c.outputLatency) === undefined ? undefined : Math.round((c.outputLatency as number) * 1000),
    }
  } catch {
    return {}
  }
}

/**
 * Logs every state change of an AudioContext until the returned function is
 * called. Safe on a context that cannot take listeners.
 */
export function traceContextState(ctx: unknown, label: string): () => void {
  try {
    const target = ctx as { state?: string; addEventListener?: (type: string, fn: () => void) => void; removeEventListener?: (type: string, fn: () => void) => void }
    if (typeof target.addEventListener !== "function") return () => undefined
    let previous = target.state
    const changed = () => {
      voiceLog.info("audio_context_state", { owner: label, from: previous, to: target.state, ...contextFields(ctx) })
      previous = target.state
    }
    target.addEventListener("statechange", changed)
    return () => { try { target.removeEventListener?.("statechange", changed) } catch { /* gone */ } }
  } catch {
    return () => undefined
  }
}

// A console switch for the operator; harmless where there is no window.
try {
  if (typeof window !== "undefined") {
    ;(window as unknown as { __voiceDebug?: (on?: boolean) => boolean }).__voiceDebug = (on?: boolean) => {
      if (typeof on === "boolean") setVoiceDebug(on)
      return voiceDebugEnabled()
    }
  }
} catch { /* no window */ }
