/**
 * Per-message text-to-speech controller — the state machine behind the chat
 * read-aloud (play↔pause) button.
 *
 * Responsibilities (pure; no browser APIs — those live in tts-engine.ts):
 *   - Track ONE active message at a time. Starting message B stops message A,
 *     so the other rows reset to "play".
 *   - Drive the idle → loading → playing lifecycle and notify subscribers.
 *   - Survive races: an async `start()` that resolves after a newer toggle is
 *     superseded (its playback is stopped, its callbacks ignored) via a monotonic
 *     generation counter.
 *
 * Playback itself is injected as `TtsStart`, so this class is fully unit-testable
 * with a mock and the real engine swaps in transparently.
 */

import { voiceLog, voiceNow } from "@/lib/voice-log"

export type TtsPhase = "idle" | "loading" | "playing"

export interface TtsSnapshot {
  /** Message id currently active (loading or playing), or null when idle. */
  id: string | null
  phase: TtsPhase
}

export interface TtsStartCallbacks {
  /** Audio actually began (HTMLAudioElement "playing" / utterance "start"). */
  onPlaying: () => void
  /** Natural end of playback. */
  onEnd: () => void
  /** Playback failed. */
  onError: () => void
}

/**
 * Begin playback of `text`. Resolves with a `stop()` that halts it. Implementations
 * choose the backend (custom Kokoro audio vs browser Web Speech) — see tts-engine.ts.
 */
export type TtsStart = (text: string, cbs: TtsStartCallbacks) => Promise<() => void>

const IDLE: TtsSnapshot = { id: null, phase: "idle" }

export class TtsController {
  private id: string | null = null
  private phase: TtsPhase = "idle"
  private stopFn: (() => void) | null = null
  /** Bumped on every (re)start and reset; stale async callbacks check it and drop. */
  private gen = 0
  /** Diagnostics only: when the active message was toggled on. */
  private startedAt = 0
  private snapshot: TtsSnapshot = IDLE
  private listeners = new Set<() => void>()

  constructor(private start: TtsStart) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Stable-reference snapshot (only rebuilt on real transitions) for useSyncExternalStore. */
  getSnapshot = (): TtsSnapshot => this.snapshot

  /** The phase for a specific message — "idle" unless it's the active one. */
  phaseFor(id: string): TtsPhase {
    return this.snapshot.id === id ? this.snapshot.phase : "idle"
  }

  /** Toggle read-aloud for `id`: stop if it's the active message, else start it. */
  toggle(id: string, text: string): void {
    if (this.id === id && this.phase !== "idle") {
      voiceLog.info("tts_toggle", { message: id, action: "stop", phase: this.phase })
      this.stop()
      return
    }
    voiceLog.info("tts_toggle", { message: id, action: "start", chars: text.length, replaces: this.id, phase: this.phase })
    void this.begin(id, text)
  }

  /** Stop any active playback and return to idle. */
  stop(): void {
    this.reset()
  }

  private async begin(id: string, text: string): Promise<void> {
    this.stopActive() // halt prior playback (without emitting an idle flash)
    const gen = ++this.gen
    this.id = id
    this.phase = "loading"
    this.startedAt = voiceNow()
    this.emit()

    try {
      const stop = await this.start(text, {
        onPlaying: () => {
          voiceLog.info("tts_playing", { message: id, stale: this.gen !== gen, since_toggle_ms: voiceNow() - this.startedAt })
          if (this.gen === gen) {
            this.phase = "playing"
            this.emit()
          }
        },
        onEnd: () => {
          voiceLog.info("tts_ended", { message: id, stale: this.gen !== gen, since_toggle_ms: voiceNow() - this.startedAt })
          if (this.gen === gen) this.reset()
        },
        onError: () => {
          voiceLog.warn("tts_error", { message: id, stale: this.gen !== gen, phase: this.phase, since_toggle_ms: voiceNow() - this.startedAt })
          if (this.gen === gen) this.reset()
        },
      })
      if (this.gen !== gen) {
        voiceLog.info("tts_superseded", { message: id, since_toggle_ms: voiceNow() - this.startedAt })
        // A newer toggle (or stop) superseded us while starting — kill this one.
        try {
          stop()
        } catch {
          /* best effort */
        }
        return
      }
      this.stopFn = stop
    } catch (error) {
      voiceLog.warn("tts_start_threw", { message: id, stale: this.gen !== gen, err: error instanceof Error ? error.name : typeof error })
      if (this.gen === gen) this.reset()
    }
  }

  private stopActive(): void {
    if (this.stopFn) {
      try {
        this.stopFn()
      } catch {
        /* best effort */
      }
      this.stopFn = null
    }
  }

  private reset(): void {
    this.stopActive()
    this.id = null
    this.phase = "idle"
    this.gen++ // invalidate any in-flight start callbacks
    this.emit()
  }

  private emit(): void {
    if (this.id === this.snapshot.id && this.phase === this.snapshot.phase) return
    voiceLog.info("tts_phase", { message: this.id ?? this.snapshot.id, from: this.snapshot.phase, to: this.phase, active_ms: this.startedAt === 0 ? null : voiceNow() - this.startedAt })
    this.snapshot = { id: this.id, phase: this.phase }
    for (const fn of this.listeners) fn()
  }
}

export const TTS_IDLE_SNAPSHOT = IDLE
