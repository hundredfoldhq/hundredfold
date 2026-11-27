import type { VoiceCueSettings, VoiceTurnState } from "@hundredfold/gateway-events"
import type { PlayerAudioContext, PlayerBuffer, PlayerSource } from "./player"

/**
 * Soft sound cues for voice mode, so silence while the assistant works does not
 * feel like a hang. Two sounds, never at the same time and never over speech:
 *
 * - `thinking`: one soft, low note about every 1.6 seconds, while the model
 *   works and nothing is being spoken yet.
 * - `tool`: a pair of notes, the second a little higher, about every 1.8 seconds,
 *   while a tool runs.
 *
 * They are synthesised here (no file, no network) and the same recipe is
 * implemented natively in `packages/shell/src-tauri/voice-core/src/cues.rs`,
 * so the web app and the mobile app sound the same. Which cue plays is decided
 * from the gateway's own `turn`, `vad` and `background` frames (see `wantedCue`),
 * never guessed from the audio.
 *
 * A third sound, the start cue, is not one of these loops: three short high beeps played once, the moment voice
 * mode is live and listening (see `START_CUE`). It is the same synthesis, played on the same cue path.
 *
 * Echo: a cue never goes through `VoicePlayer`, so it never arms the barge-in
 * detector (which only listens while speech is playing); it is silenced the
 * moment speech is audible or the user is heard; and it is quiet and made of
 * short soft notes with long gaps, nothing that holds a level for `minSpeechMs`
 * or that a voice-activity detector takes for speech. docs/voice.md says more.
 */
export type VoiceCue = "thinking" | "tool"

export const DEFAULT_CUE_SETTINGS: VoiceCueSettings = { enabled: true, volume: 0.3 }

/** Loudest a note gets (volume 1), as a share of full scale: about -16 dBFS. Default volume gives about -26 dBFS. */
export const CUE_PEAK = 0.16

/** How long the start cue sounds: its last beep ends at 340 ms. */
export const START_CUE_MS = 340

/**
 * How long after the start cue ends the microphone stays muted toward the gateway (and the barge-in detector
 * stays unfed): the room can still be ringing, and the speaker's output can reach the microphone a little late.
 */
export const START_CUE_TAIL_MS = 250

interface Blip {
  atMs: number
  durMs: number
  hz: number
}

interface CuePattern {
  loopMs: number
  blips: Blip[]
}

/**
 * The first note comes `atMs` after the cue starts, so a short pause in the work makes no sound at all.
 * Pitches are in the warm middle of the voice range (about G4, then F4 to A4), and every note is well
 * under the 250 ms an utterance needs, with a clear gap before the next.
 */
export const CUE_PATTERNS: Record<VoiceCue, CuePattern> = {
  thinking: { loopMs: 1600, blips: [{ atMs: 300, durMs: 140, hz: 392 }] },
  tool: { loopMs: 1800, blips: [{ atMs: 300, durMs: 110, hz: 349 }, { atMs: 500, durMs: 110, hz: 440 }] },
}

/**
 * Three quick, high beeps (A6, 1760 Hz) played once when voice mode has started and is listening: "voice is live".
 * Each is 60 ms with a 60 ms gap, so the whole cue is about a third of a second, far from the 250 ms an utterance
 * needs. The first comes a moment after the cue starts, so the audio output is up before the first beep.
 * The same recipe is in `cues.rs`.
 */
export const START_CUE: CuePattern = {
  loopMs: START_CUE_MS,
  blips: [0, 1, 2].map((n) => ({ atMs: 40 + n * 120, durMs: 60, hz: 1760 })),
}

/** Share of a note's length spent rising; the rest is a slower, gentler fall, so a note swells and fades like a soft bell. */
const ATTACK = 0.3

/**
 * One loop of a cue as mono floats with a peak of at most 1. Every note is a
 * plain sine (no overtones, so nothing bright or sharp) under a smooth envelope:
 * a raised-cosine rise over the first `ATTACK` of the note and a raised-cosine
 * fall over the rest, so it starts and ends at zero and never clicks.
 */
export function renderCueLoop(cue: VoiceCue, sampleRate: number): Float32Array {
  return renderPattern(CUE_PATTERNS[cue], sampleRate)
}

/** The start cue: three beeps, once, as mono floats with a peak of at most 1. */
export function renderStartCue(sampleRate: number): Float32Array {
  return renderPattern(START_CUE, sampleRate)
}

function renderPattern(pattern: CuePattern, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round((pattern.loopMs * sampleRate) / 1000))
  for (const blip of pattern.blips) {
    const start = Math.round((blip.atMs * sampleRate) / 1000)
    const length = Math.round((blip.durMs * sampleRate) / 1000)
    for (let i = 0; i < length && start + i < out.length; i++) {
      const t = i / sampleRate
      const x = i / length
      const window = x < ATTACK ? Math.sin((Math.PI / 2) * (x / ATTACK)) ** 2 : Math.cos((Math.PI / 2) * ((x - ATTACK) / (1 - ATTACK))) ** 2
      out[start + i] += window * Math.sin(2 * Math.PI * blip.hz * t)
    }
  }
  return out
}

/** Settings from a `ready` frame, `GET /api/voice/config` or anything else: a missing or wrong key falls back to its default. */
export function parseCueSettings(raw: unknown): VoiceCueSettings {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const volume = typeof value.volume === "number" && Number.isFinite(value.volume) ? Math.min(1, Math.max(0, value.volume)) : DEFAULT_CUE_SETTINGS.volume
  return { enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_CUE_SETTINGS.enabled, volume }
}

export interface CueInputs {
  settings: VoiceCueSettings
  /** Voice mode is running and not suspended or paused. */
  running: boolean
  turn: VoiceTurnState
  /** The user is being heard: the gateway's voice activity, a live partial transcript, or push-to-talk held. */
  hearing: boolean
  /** The assistant's speech (a reply or a holding line) is audible or about to be. */
  speechAudible: boolean
  /** The tool the turn is on was moved to the background. */
  toolBackgrounded: boolean
}

/**
 * Which cue should sound now, or null for none.
 *
 * - `thinking` turn: the thinking cue.
 * - `working` turn: the tool cue, until the tool is moved to the background; the
 *   work then belongs to the background chip, and the assistant is free to answer,
 *   so the thinking cue takes over until the turn ends. Background work that keeps
 *   running after the turn ended is silent.
 * - `speaking`, `idle`: none. Nor while the user is heard, speech is audible, or cues are off.
 */
export function wantedCue(input: CueInputs): VoiceCue | null {
  if (!input.settings.enabled || input.settings.volume <= 0 || !input.running) return null
  if (input.hearing || input.speechAudible) return null
  if (input.turn === "thinking") return "thinking"
  if (input.turn === "working") return input.toolBackgrounded ? "thinking" : "tool"
  return null
}

// ── playing ──────────────────────────────────────────────────────────────────

export interface CueParam {
  value: number
  setValueAtTime(value: number, time: number): unknown
  linearRampToValueAtTime(value: number, time: number): unknown
}
export interface CueGain {
  readonly gain: CueParam
  connect(destination: unknown): unknown
  disconnect(): void
}
export interface CueSource extends PlayerSource {
  loop: boolean
}
/** The slice of an AudioContext the cue player uses, so tests can supply a fake clock. */
export interface CueAudioContext extends PlayerAudioContext {
  createBufferSource(): CueSource
  createGain(): CueGain
}

export interface VoiceCuePlayerLike {
  /** Plays this cue until told otherwise; null stops. The same cue again changes nothing. */
  set(cue: VoiceCue | null, volume: number): void
  /** Plays the start cue (three beeps) once, beside whatever loop is running. Returns how long it sounds, in ms. */
  playStart(volume: number): number
  dispose(): void
}

/** Seconds a cue takes to fade out when it stops, so a stop mid-tick does not click. */
const FADE_S = 0.02

interface Running {
  cue: VoiceCue
  source: CueSource
  gain: CueGain
}

/** Loops a cue through its own gain node on the voice AudioContext. Not the speech player: see the file comment. */
export class VoiceCuePlayer implements VoiceCuePlayerLike {
  private running: Running | null = null
  private readonly buffers = new Map<VoiceCue, PlayerBuffer>()
  private readonly startCues = new Set<() => void>()

  constructor(private readonly ctx: CueAudioContext, private readonly sampleRate = 24_000) {}

  set(cue: VoiceCue | null, volume: number): void {
    if (this.running && this.running.cue === cue) {
      this.running.gain.gain.value = CUE_PEAK * volume
      return
    }
    this.fadeOut()
    if (cue) this.begin(cue, volume)
  }

  playStart(volume: number): number {
    const samples = renderStartCue(this.sampleRate)
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate)
    buffer.getChannelData(0).set(samples)
    const source = this.ctx.createBufferSource()
    const gain = this.ctx.createGain()
    source.buffer = buffer
    source.loop = false
    gain.gain.value = CUE_PEAK * volume
    source.connect(gain)
    gain.connect(this.ctx.destination)
    source.onended = () => {
      source.disconnect()
      gain.disconnect()
      this.startCues.delete(stop)
    }
    const stop = () => { try { source.stop() } catch { /* already stopped */ } }
    this.startCues.add(stop)
    source.start(this.ctx.currentTime)
    return START_CUE_MS
  }

  dispose(): void {
    this.fadeOut()
    for (const stop of this.startCues) stop()
    this.startCues.clear()
  }

  private bufferFor(cue: VoiceCue): PlayerBuffer {
    const cached = this.buffers.get(cue)
    if (cached) return cached
    const samples = renderCueLoop(cue, this.sampleRate)
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate)
    buffer.getChannelData(0).set(samples)
    this.buffers.set(cue, buffer)
    return buffer
  }

  private begin(cue: VoiceCue, volume: number): void {
    const source = this.ctx.createBufferSource()
    const gain = this.ctx.createGain()
    source.buffer = this.bufferFor(cue)
    source.loop = true
    gain.gain.value = CUE_PEAK * volume
    source.connect(gain)
    gain.connect(this.ctx.destination)
    source.start(this.ctx.currentTime)
    this.running = { cue, source, gain }
  }

  private fadeOut(): void {
    const running = this.running
    if (!running) return
    this.running = null
    const now = this.ctx.currentTime
    try {
      running.gain.gain.setValueAtTime(running.gain.gain.value, now)
      running.gain.gain.linearRampToValueAtTime(0, now + FADE_S)
      running.source.stop(now + FADE_S)
    } catch { /* already stopped */ }
    running.source.onended = () => {
      running.source.disconnect()
      running.gain.disconnect()
    }
  }
}
