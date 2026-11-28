/**
 * What happens between a person starting to speak over the assistant and the
 * words (or the lack of them) that follow (FR-009, FR-010). Playback stops at
 * once and the heard part is kept; the next final then decides: words go to the
 * session as the next message, no words resume speaking from the first sentence
 * not heard.
 */
import type { VoiceClock, CancelTimer } from "./hub-types.js";
import type { ReplyVoice } from "./reply-voice.js";
import { silentTracer, type Tracer } from "./trace.js";

/** How long a stopped reply waits for an utterance to follow before it carries on: a cough the VAD never heard. */
export const BARGE_IN_GRACE_MS = 1500;

export interface BargeInState {
  /** What the person heard of the reply before talking over it. */
  heard: string;
  /** The sentences to speak again from if nothing was said. */
  unheard: string[];
  /** The utterance that belongs to this interruption, once there is one. */
  utteranceId: string | null;
}

export interface BargeInOptions {
  voice: ReplyVoice;
  clock: VoiceClock;
  enabled: boolean;
  trace?: Tracer;
}

export class BargeIn {
  private state: BargeInState | null = null;
  private cancelGrace: CancelTimer | null = null;
  private readonly trace: Tracer;
  /** Diagnostics only: what started the interruption in progress, and when. */
  private origin: { by: "client" | "gateway"; at: number } | null = null;

  constructor(private readonly options: BargeInOptions) {
    this.trace = options.trace ?? silentTracer;
  }

  get active(): boolean {
    return this.state !== null;
  }

  /** The client's onset detector fired and playback there has stopped. */
  fromClient(segmentId: number | null, playedMs: number): void {
    if (!this.options.enabled || this.state) {
      this.trace.info("barge_in_ignored", { by: "client", reason: !this.options.enabled ? "disabled" : "already_active", segment: segmentId });
      return;
    }
    if (segmentId === null && !this.options.voice.speaking()) {
      this.trace.info("barge_in_ignored", { by: "client", reason: "nothing_playing", segment: segmentId });
      return;
    }
    this.begin(segmentId, playedMs, "client");
  }

  /** Speech began. Over playback that is a barge-in the gateway heard first; either way it claims the interruption. */
  utteranceStarted(id: string, speakingNow: boolean): void {
    if (!this.options.enabled) return;
    if (!this.state && speakingNow) this.begin(null, 0, "gateway");
    if (this.state && this.state.utteranceId === null) {
      this.state.utteranceId = id;
      this.trace.info("barge_in_claimed", { utterance: id, since_begin_ms: this.sinceBegin() });
      this.stopGrace();
    }
  }

  /** The utterance had no words, or failed: carry on speaking. */
  emptyFinal(id: string): void {
    if (this.state?.utteranceId === id) this.resume();
  }

  utteranceFailed(id: string): void {
    this.emptyFinal(id);
  }

  /** Words came: the interruption is what they answer. */
  takeForWords(): BargeInState | null {
    const state = this.state;
    if (state) this.trace.info("barge_in_words", { utterance: state.utteranceId, heard_chars: state.heard.length, unheard_sentences: state.unheard.length, since_begin_ms: this.sinceBegin(), outcome: "new_message" });
    this.state = null;
    this.origin = null;
    this.stopGrace();
    return state;
  }

  clear(): void {
    if (this.state) this.trace.info("barge_in_cleared", { since_begin_ms: this.sinceBegin() });
    this.state = null;
    this.origin = null;
    this.stopGrace();
  }

  private sinceBegin(): number | undefined {
    return this.origin ? this.options.clock.now() - this.origin.at : undefined;
  }

  private begin(segmentId: number | null, playedMs: number, by: "client" | "gateway"): void {
    const cut = this.options.voice.cutPlayback(segmentId, playedMs);
    this.state = { heard: cut.heard, unheard: cut.unheard, utteranceId: null };
    this.origin = { by, at: this.options.clock.now() };
    this.trace.info("barge_in_begin", { by, segment: segmentId, played_ms: Math.round(playedMs), heard_chars: cut.heard.length, unheard_sentences: cut.unheard.length, grace_ms: BARGE_IN_GRACE_MS });
    this.cancelGrace = this.options.clock.setTimeout(() => this.noUtteranceFollowed(), BARGE_IN_GRACE_MS);
  }

  private noUtteranceFollowed(): void {
    this.cancelGrace = null;
    if (this.state && this.state.utteranceId === null) {
      this.trace.info("barge_in_grace_expired", { by: this.origin?.by, waited_ms: this.sinceBegin() });
      this.resume();
    }
  }

  private resume(): void {
    const state = this.state;
    if (state) this.trace.info("barge_in_resume", { by: this.origin?.by, utterance: state.utteranceId, replay_sentences: state.unheard.length, since_begin_ms: this.sinceBegin(), outcome: "resume_speaking" });
    this.state = null;
    this.origin = null;
    this.stopGrace();
    if (state) this.options.voice.resumePlayback(state.unheard);
  }

  private stopGrace(): void {
    this.cancelGrace?.();
    this.cancelGrace = null;
  }
}
