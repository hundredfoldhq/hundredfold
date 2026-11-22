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
import type { SttProvider, SttStream, VadStream } from "./provider.js";
import type { VoiceClock, CancelTimer } from "./hub-types.js";
import { VAD_HOLD_MS } from "./sidecar/client.js";

/** Bytes of PCM16 mono at the input rate per millisecond. */
const BYTES_PER_MS = (VOICE_INPUT_SAMPLE_RATE * 2) / 1000;
/** Audio kept beyond the pre-roll, for the delay between speech starting and the VAD saying so. */
const VAD_LAG_MS = 1500;
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
  maxUtteranceMs: number;
  /** The VAD's trailing silence: what a live utterance holds past the end of speech, and a catch-up one is given. */
  tailMs?: number;
  pushToTalk: boolean;
  clock: VoiceClock;
  newId(): string;
  events: CaptureEvents;
}

/** One utterance in flight. */
interface Open {
  id: string;
  stream: SttStream;
  abort: AbortController;
  startedAt: number;
  endedAt: number | null;
  audioMs: number;
  partial: string;
  settled: boolean;
  cancelTimeout: CancelTimer | null;
  /** Set while a late start waits for its end: nothing is fed live, the cut is made from the ring at the end. */
  catchUp: { fromByte: number } | null;
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

  constructor(private readonly options: CaptureOptions) {
    options.vad.on((event) => this.onVad(event.kind, event.atMs));
  }

  /** Whether the person is being captured right now. */
  get hearing(): boolean {
    return this.capturing !== null;
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
    if (open.audioMs >= this.options.maxUtteranceMs) this.cutForLength(open);
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
    for (const open of [...this.awaiting, ...(this.capturing ? [this.capturing] : [])]) this.discard(open);
    this.capturing = null;
    this.awaiting.clear();
  }

  private remember(pcm: Buffer): void {
    this.ring.push(pcm);
    this.ringBytes += pcm.length;
    this.written += pcm.length;
    const keep = (this.options.prerollMs + VAD_LAG_MS + VAD_HOLD_MS) * BYTES_PER_MS;
    while (this.ringBytes - this.ring[0].length >= keep) this.ringBytes -= this.ring.shift()!.length;
  }

  private onVad(kind: "start" | "end", atMs: number): void {
    if (this.closed || this.options.pushToTalk) return;
    if (kind === "end") {
      this.options.events.onVad(false);
      this.onVadEnd(atMs);
      return;
    }
    this.options.events.onVad(true);
    if (this.capturing || this.ignoringUntilEnd) return;
    this.onVadStart(Math.max(0, atMs * BYTES_PER_MS));
  }

  private onVadEnd(atMs: number): void {
    const open = this.capturing;
    if (!open?.catchUp) {
      this.ignoringUntilEnd = false;
      this.endSpeech(this.written);
      return;
    }
    // A start and its end can arrive together, between two frames: the length limit holds for that span too.
    const toByte = this.catchUpEnd(atMs);
    if (toByte - open.catchUp.fromByte >= this.options.maxUtteranceMs * BYTES_PER_MS) this.cutForLength(open);
    else this.endSpeech(toByte);
    this.ignoringUntilEnd = false;
  }

  /**
   * A start behind the live frames by more than the VAD's own lag is a catch-up: its audio is cut when its end arrives.
   * A start older than the whole buffer cannot be a held one (the sidecar restarts its offsets at 0 when it is
   * respawned), so it is treated as live and seeded from the most recent window instead.
   */
  private onVadStart(fromByte: number): void {
    const windowBytes = (this.options.prerollMs + VAD_LAG_MS) * BYTES_PER_MS;
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
      endedAt: null, audioMs: 0, partial: "", settled: false, cancelTimeout: null,
      catchUp: catchUp ? { fromByte } : null,
    };
    stream.on((event) => this.onStt(open, event));
    this.capturing = open;
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

  private endSpeech(toByte = this.written): void {
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
    this.awaiting.add(open);
    open.cancelTimeout = this.options.clock.setTimeout(() => this.fail(open), FINAL_TIMEOUT_MS);
    open.stream.end();
  }

  private cutForLength(open: Open): void {
    this.capturing = null;
    if (open.catchUp) this.finishCatchUp(open, Math.min(this.written, open.catchUp.fromByte + this.options.maxUtteranceMs * BYTES_PER_MS));
    this.ignoringUntilEnd = true;
    this.options.events.onTooLong(open.id);
    this.finish(open);
  }

  private onStt(open: Open, event: { type: "partial" | "final" | "error"; text?: string }): void {
    if (open.settled || this.closed) return;
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
    });
  }

  private fail(open: Open): void {
    if (open.settled) return;
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
