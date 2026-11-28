/**
 * The gateway's half of listening (FR-002, FR-003): continuous client audio goes
 * to the VAD; speech opens an STT stream seeded with the audio from just before
 * speech began; the pause that ends speech asks the stream for its final. In
 * push-to-talk the person marks the boundaries and the VAD does not endpoint.
 *
 * `VadStream` events carry `atMs`, a position in the audio written to the
 * stream. `start.atMs` is where to cut from, with the pre-roll ALREADY taken off
 * (never below 0), so it is not taken off again here; `end.atMs` is where speech
 * stopped, before the trailing silence (speech-sidecar.md, VAD offsets).
 *
 * While the local models load the sidecar client holds the audio (up to `VAD_HOLD_MS`)
 * and the VAD's events for it arrive late, in a burst. The ring therefore keeps that
 * whole window. A start that arrives long after it happened (a catch-up start) is
 * opened but fed nothing live: on its end the utterance is cut from the ring by the
 * event offsets, so two utterances spoken during the load stay apart.
 */
import { VOICE_INPUT_SAMPLE_RATE } from "../shared/gateway-events.js";
import type { SttProvider, SttQuality, SttStream, VadEvent, VadStream } from "./provider.js";
import type { VoiceClock, CancelTimer } from "./hub-types.js";
import { VAD_HOLD_MS } from "./sidecar/client.js";
import { errorField, silentTracer, type Tracer } from "./trace.js";
import { looksUnfinished } from "./unfinished-speech.js";

/** Bytes of PCM16 mono at the input rate per millisecond. */
const BYTES_PER_MS = (VOICE_INPUT_SAMPLE_RATE * 2) / 1000;
/** Audio kept beyond the pre-roll, for the delay between speech starting and the VAD saying so, when the options name none. */
const DEFAULT_VAD_LAG_MS = 1500;
/** The VAD says speech started only once it has lasted this long, plus a frame or two: that much lag, and a margin. */
const VAD_LAG_MARGIN_MS = 500;

/** How far behind the audio a live VAD's start can be, for a detector that wants `minSpeechMs` of speech first. */
export function vadLagFor(minSpeechMs: number): number {
  return Math.max(DEFAULT_VAD_LAG_MS, minSpeechMs + VAD_LAG_MARGIN_MS);
}
/** Audio after the end of speech that a catch-up utterance is given when the options name no trailing silence. */
const DEFAULT_TAIL_MS = 700;
/** A provider that never answers the end of an utterance is given up on after this. */
const FINAL_TIMEOUT_MS = 15_000;

export interface FinishedUtterance {
  id: string;
  text: string;
  audioMs: number;
  /** End of speech to the final transcript. */
  sttMs: number;
  startedAt: number;
  /** How long the person was voiced, from the VAD, without pre-roll or silence; absent in push-to-talk (no VAD) or when the VAD did not say. */
  speechMs?: number;
  /** What the provider reported about its confidence, when it reported any. */
  quality?: SttQuality;
}

export interface CaptureEvents {
  onVad(speaking: boolean): void;
  /** Speech began: a new utterance is being captured. */
  onStart(id: string): void;
  onPartial(id: string, text: string): void;
  onFinal(utterance: FinishedUtterance): void;
  onFailed(id: string): void;
  onTooLong(id: string): void;
}

export interface CaptureOptions {
  stt: SttProvider;
  vad: VadStream;
  language: string;
  prerollMs: number;
  /** Extra silence waited after the VAD's end when the transcript so far looks unfinished; 0 or absent: none. */
  unfinishedHoldMs?: number;
  maxUtteranceMs: number;
  /** The VAD's trailing silence: what a live utterance holds past the end of speech, and a catch-up one is given. */
  tailMs?: number;
  /** How long after speech began the VAD may say so while still live (default 1.5 s); see `vadLagFor`. */
  vadLagMs?: number;
  pushToTalk: boolean;
  clock: VoiceClock;
  newId(): string;
  events: CaptureEvents;
  /** Diagnostic lines; absent: nothing is logged. */
  trace?: Tracer;
}

/** One utterance in flight. */
interface Open {
  id: string;
  stream: SttStream;
  abort: AbortController;
  startedAt: number;
  endedAt: number | null;
  audioMs: number;
  /** Voiced time summed over the VAD's ends so far (speech that resumes inside a hold adds to it); null when no end has said. */
  speechMs: number | null;
  /** Speech resumed inside a hold and its end has not come: the voiced time so far is a floor, so it is not reported. */
  resumedOpen: boolean;
  partial: string;
  settled: boolean;
  cancelTimeout: CancelTimer | null;
  /** Set while a late start waits for its end: nothing is fed live, the cut is made from the ring at the end. */
  catchUp: { fromByte: number } | null;
}

/** The voiced time to report: none when no end said, or when speech resumed and its end never came (what is summed is then a floor). */
function voicedOf(open: Open): { speechMs?: number } {
  return open.speechMs === null || open.resumedOpen ? {} : { speechMs: Math.round(open.speechMs) };
}

export class UtteranceCapture {
  private readonly ring: Buffer[] = [];
  private ringBytes = 0;
  /** Bytes of client audio written so far, whole stream. */
  private written = 0;
  private capturing: Open | null = null;
  private readonly awaiting = new Set<Open>();
  /** After a cut for length, the rest of that speech is ignored until it ends. */
  private ignoringUntilEnd = false;
  private pttHeld = false;
  private closed = false;
  /** Set while the VAD said speech ended but the words so far look unfinished, so the end is held. */
  private cancelHold: CancelTimer | null = null;

  private readonly trace: Tracer;

  constructor(private readonly options: CaptureOptions) {
    this.trace = options.trace ?? silentTracer;
    options.vad.on((event) => this.onVad(event));
  }

  /** Whether the person is being captured right now. */
  get hearing(): boolean {
    return this.capturing !== null;
  }

  /** Whether an utterance is open or waiting for its transcript: what the person said is not known yet. */
  get inUtterance(): boolean {
    return this.capturing !== null || this.awaiting.size > 0;
  }

  /** One frame of client audio. */
  write(pcm: Buffer): void {
    if (this.closed) return;
    if (this.options.pushToTalk && !this.pttHeld) return;
    const before = this.capturing;
    this.remember(pcm);
    if (!this.options.pushToTalk) this.options.vad.write(pcm);
    const open = this.capturing;
    if (!open) return;
    if (open.catchUp) return this.checkCatchUpLength(open);
    // An utterance the VAD opened on this very frame was already given it, in its pre-roll.
    if (open === before) {
      open.stream.write(pcm);
      open.audioMs += pcm.length / BYTES_PER_MS;
    }
    if (open.audioMs < this.options.maxUtteranceMs) return;
    // Silence counted during a hold is not speech running long: the utterance has already ended, so it ends normally.
    if (this.cancelHold) this.endSpeech();
    else this.cutForLength(open);
  }

  pttDown(): void {
    if (this.closed || !this.options.pushToTalk || this.pttHeld) return;
    this.pttHeld = true;
    this.begin(this.written);
  }

  pttUp(): void {
    if (!this.pttHeld) return;
    this.pttHeld = false;
    this.ignoringUntilEnd = false;
    this.endSpeech();
  }

  /** Drop everything in flight: no more events. */
  close(): void {
    this.closed = true;
    this.options.vad.close();
    this.clearHold();
    for (const open of [...this.awaiting, ...(this.capturing ? [this.capturing] : [])]) this.discard(open);
    this.capturing = null;
    this.awaiting.clear();
  }

  private remember(pcm: Buffer): void {
    this.ring.push(pcm);
    this.ringBytes += pcm.length;
    this.written += pcm.length;
    const keep = (this.options.prerollMs + this.vadLagMs + VAD_HOLD_MS) * BYTES_PER_MS;
    while (this.ringBytes - this.ring[0].length >= keep) this.ringBytes -= this.ring.shift()!.length;
  }

  private get vadLagMs(): number {
    return this.options.vadLagMs ?? DEFAULT_VAD_LAG_MS;
  }

  private onVad({ kind, atMs, speechMs }: VadEvent): void {
    if (this.closed || this.options.pushToTalk) return;
    this.trace.debug("vad_event", () => ({ kind, at_ms: Math.round(atMs), speech_ms: speechMs === undefined ? undefined : Math.round(speechMs), written_ms: Math.round(this.written / BYTES_PER_MS) }));
    if (kind === "reset") return this.onReset(atMs);
    if (kind === "end") return this.onVadEnd(atMs, speechMs);
    // Speech resumed inside a hold: the same utterance goes on.
    const resumed = this.cancelHold !== null && this.capturing !== null;
    this.clearHold();
    if (resumed) {
      this.capturing!.resumedOpen = true;
      return this.options.events.onVad(true);
    }
    const fromByte = Math.max(0, atMs * BYTES_PER_MS);
    // The VAD does not start twice without an end between, and a replaced detector says so (a reset), so this is a fallback
    // for one that did not: what was open stops where this speech begins (never past what was written).
    if (this.capturing) {
      this.options.events.onVad(false);
      this.closeOpen(Math.min(this.written, fromByte));
      this.ignoringUntilEnd = false;
    }
    this.options.events.onVad(true);
    if (!this.ignoringUntilEnd) this.onVadStart(fromByte);
  }

  private onVadEnd(atMs: number, speechMs: number | undefined): void {
    this.options.events.onVad(false);
    if (this.capturing) this.capturing.resumedOpen = false;
    if (this.capturing && speechMs !== undefined) this.capturing.speechMs = (this.capturing.speechMs ?? 0) + speechMs;
    const catchUp = this.capturing?.catchUp;
    // Only a live utterance has words to judge; a catch-up one ends where the VAD says.
    if (!catchUp && this.holdEnd()) {
      this.trace.info("utterance_end_held", { utterance: this.capturing?.id, hold_ms: this.options.unfinishedHoldMs });
      return;
    }
    this.closeOpen(catchUp ? this.catchUpEnd(atMs) : this.written);
    this.ignoringUntilEnd = false;
  }

  /**
   * The detector behind the VAD was replaced: the speech it was in the middle of will never get an end. The open
   * utterance ends here, at the byte the new detector counts from. A live one already holds everything up to that byte;
   * a catch-up one is cut from its start to it. What the new detector reports from now on starts at or after it.
   */
  private onReset(atMs: number): void {
    // A held utterance already told the client its speech ended.
    if ((this.capturing && !this.cancelHold) || this.ignoringUntilEnd) this.options.events.onVad(false);
    this.closeOpen(Math.min(this.written, Math.max(0, atMs * BYTES_PER_MS)));
    this.ignoringUntilEnd = false;
  }

  /** End the open utterance. A live one has had its audio as it came; a catch-up one is cut from the ring, to `toByte`. */
  private closeOpen(toByte: number): void {
    const open = this.capturing;
    if (!open) return;
    // A start and its end can arrive together, between two frames: the length limit holds for that span too.
    if (open.catchUp && toByte - open.catchUp.fromByte >= this.options.maxUtteranceMs * BYTES_PER_MS) this.cutForLength(open);
    else this.endSpeech(toByte);
  }

  /**
   * A start behind the live frames by more than the VAD's own lag is a catch-up: its audio is cut when its end arrives.
   * A start older than the whole buffer cannot be cut from it (the VAD is further behind than the sidecar holds), so it
   * is treated as live and seeded from the most recent window instead.
   */
  private onVadStart(fromByte: number): void {
    const windowBytes = (this.options.prerollMs + this.vadLagMs) * BYTES_PER_MS;
    if (fromByte < this.written - this.ringBytes) return this.begin(Math.max(fromByte, this.written - windowBytes));
    this.begin(fromByte, this.written - fromByte > windowBytes);
  }

  /** Where a catch-up utterance's audio stops: the end of speech and the VAD's trailing silence, never past what was written. */
  private catchUpEnd(endAtMs: number): number {
    const tail = this.options.tailMs ?? DEFAULT_TAIL_MS;
    return Math.min(this.written, (endAtMs + tail) * BYTES_PER_MS);
  }

  /**
   * Open an STT stream. A live start is given the audio from `fromByte` on, then the live frames. A catch-up start is
   * given nothing yet: the VAD is behind, so "now" is not the end of this utterance.
   */
  private begin(fromByte: number, catchUp = false): void {
    const abort = new AbortController();
    const stream = this.options.stt.open({ language: this.options.language, sampleRate: VOICE_INPUT_SAMPLE_RATE, signal: abort.signal });
    const open: Open = {
      id: this.options.newId(), stream, abort, startedAt: this.options.clock.now(),
      endedAt: null, audioMs: 0, speechMs: null, resumedOpen: false, partial: "", settled: false, cancelTimeout: null,
      catchUp: catchUp ? { fromByte } : null,
    };
    stream.on((event) => this.onStt(open, event));
    this.capturing = open;
    this.trace.info("utterance_open", {
      utterance: open.id, catch_up: catchUp, from_ms: Math.round(fromByte / BYTES_PER_MS), written_ms: Math.round(this.written / BYTES_PER_MS),
      preroll_ms: catchUp ? undefined : Math.round((this.written - fromByte) / BYTES_PER_MS), mode: this.options.pushToTalk ? "push-to-talk" : "hands-free",
    });
    this.options.events.onStart(open.id);
    if (!catchUp) this.feed(open, fromByte, this.written);
  }

  /** Give the stream the buffered audio between two absolute byte offsets. */
  private feed(open: Open, fromByte: number, toByte: number): void {
    const audio = this.slice(fromByte, toByte);
    if (audio.length === 0) return;
    open.stream.write(audio);
    open.audioMs += audio.length / BYTES_PER_MS;
  }

  /** A copy of the buffered audio from absolute byte `fromByte` to `toByte`: only the chunks that cut touches. */
  private slice(fromByte: number, toByte: number): Buffer {
    const ringStart = this.written - this.ringBytes;
    const from = Math.max(ringStart, Math.floor(fromByte) - (Math.floor(fromByte) % 2));
    const to = Math.min(this.written, Math.floor(toByte));
    const parts: Buffer[] = [];
    let position = ringStart;
    for (const chunk of this.ring) {
      if (position >= to) break;
      const end = position + chunk.length;
      if (end > from) parts.push(chunk.subarray(Math.max(0, from - position), Math.min(chunk.length, to - position)));
      position = end;
    }
    return Buffer.concat(parts);
  }

  /** A catch-up utterance still waiting for its end is cut for length when it reaches the limit or its start leaves the ring. */
  private checkCatchUpLength(open: Open): void {
    const fromByte = open.catchUp?.fromByte ?? this.written;
    const spanMs = (this.written - fromByte) / BYTES_PER_MS;
    if (spanMs >= this.options.maxUtteranceMs || fromByte < this.written - this.ringBytes) this.cutForLength(open);
  }

  /** Wait a little longer before ending an utterance whose words so far look unfinished. */
  private holdEnd(): boolean {
    const open = this.capturing;
    const hold = this.options.unfinishedHoldMs ?? 0;
    if (!open || hold <= 0 || !looksUnfinished(open.partial)) return false;
    this.clearHold();
    this.cancelHold = this.options.clock.setTimeout(() => {
      this.cancelHold = null;
      if (!this.closed && this.capturing === open) this.endSpeech();
    }, hold);
    return true;
  }

  private clearHold(): void {
    this.cancelHold?.();
    this.cancelHold = null;
  }

  private endSpeech(toByte = this.written): void {
    this.clearHold();
    const open = this.capturing;
    if (!open) return;
    this.capturing = null;
    this.finishCatchUp(open, toByte);
    this.finish(open);
  }

  /** The cut a catch-up utterance was waiting for: its audio, from its start to `toByte`, and no more. */
  private finishCatchUp(open: Open, toByte: number): void {
    if (!open.catchUp) return;
    this.feed(open, open.catchUp.fromByte, Math.max(toByte, open.catchUp.fromByte));
    open.catchUp = null;
  }

  private finish(open: Open): void {
    open.endedAt = this.options.clock.now();
    this.trace.info("utterance_closed", {
      utterance: open.id, audio_ms: Math.round(open.audioMs), speech_ms: open.speechMs === null ? undefined : Math.round(open.speechMs),
      live_ms: open.endedAt - open.startedAt, partial_chars: open.partial.length, catch_up: open.catchUp !== null,
    });
    this.awaiting.add(open);
    open.cancelTimeout = this.options.clock.setTimeout(() => this.fail(open), FINAL_TIMEOUT_MS);
    open.stream.end();
  }

  private cutForLength(open: Open): void {
    this.capturing = null;
    if (open.catchUp) this.finishCatchUp(open, Math.min(this.written, open.catchUp.fromByte + this.options.maxUtteranceMs * BYTES_PER_MS));
    this.ignoringUntilEnd = true;
    this.trace.warn("utterance_too_long", { utterance: open.id, max_ms: this.options.maxUtteranceMs });
    this.options.events.onTooLong(open.id);
    this.finish(open);
  }

  private onStt(open: Open, event: { type: "partial" | "final" | "error"; text?: string; message?: string; quality?: SttQuality }): void {
    if (open.settled || this.closed) return;
    this.traceStt(open, event);
    if (event.type === "partial") {
      open.partial = event.text ?? "";
      this.options.events.onPartial(open.id, open.partial);
      return;
    }
    if (event.type === "error") return this.fail(open);
    this.settle(open);
    const now = this.options.clock.now();
    this.options.events.onFinal({
      id: open.id, text: event.text ?? "", audioMs: Math.round(open.audioMs),
      sttMs: Math.max(0, now - (open.endedAt ?? now)), startedAt: open.startedAt,
      ...voicedOf(open),
      ...(event.quality === undefined ? {} : { quality: event.quality }),
    });
  }

  /** One line per recognition event: a partial at debug, the final and an error at info and warn. */
  private traceStt(open: Open, event: { type: "partial" | "final" | "error"; text?: string; message?: string; quality?: SttQuality }): void {
    const base = { utterance: open.id, audio_ms: Math.round(open.audioMs) };
    if (event.type === "partial") return this.trace.debug("stt_partial", () => ({ utterance: open.id, chars: (event.text ?? "").length }));
    if (event.type === "error") return this.trace.warn("stt_error", { ...base, error: errorField(event.message ?? "unknown") });
    const now = this.options.clock.now();
    this.trace.info("stt_final", { ...base, chars: (event.text ?? "").length, stt_ms: Math.max(0, now - (open.endedAt ?? now)), confidence: event.quality?.confidence, no_speech: event.quality?.noSpeechProb });
  }

  private fail(open: Open): void {
    if (open.settled) return;
    this.trace.warn("stt_gave_up", { utterance: open.id, audio_ms: Math.round(open.audioMs), waited_ms: open.endedAt === null ? undefined : this.options.clock.now() - open.endedAt });
    this.discard(open);
    if (this.capturing === open) this.capturing = null;
    this.options.events.onFailed(open.id);
  }

  private settle(open: Open): void {
    open.settled = true;
    open.cancelTimeout?.();
    this.awaiting.delete(open);
  }

  private discard(open: Open): void {
    this.settle(open);
    open.abort.abort();
    open.stream.abort();
  }
}
