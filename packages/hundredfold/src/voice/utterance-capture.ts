/**
 * The gateway's half of listening (FR-002, FR-003): continuous client audio goes
 * to the VAD; speech opens an STT stream seeded with the audio from just before
 * speech began; the pause that ends speech asks the stream for its final. In
 * push-to-talk the person marks the boundaries and the VAD does not endpoint.
 *
 * `VadStream` events carry `atMs`, the position in the audio written to the
 * stream where speech began or ended.
 */
import { VOICE_INPUT_SAMPLE_RATE } from "../shared/gateway-events.js";
import type { SttProvider, SttStream, VadStream } from "./provider.js";
import type { VoiceClock, CancelTimer } from "./hub-types.js";

/** Bytes of PCM16 mono at the input rate per millisecond. */
const BYTES_PER_MS = (VOICE_INPUT_SAMPLE_RATE * 2) / 1000;
/** Audio kept beyond the pre-roll, for the delay between speech starting and the VAD saying so. */
const VAD_LAG_MS = 1500;
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
    const keep = (this.options.prerollMs + VAD_LAG_MS) * BYTES_PER_MS;
    while (this.ringBytes - this.ring[0].length >= keep) this.ringBytes -= this.ring.shift()!.length;
  }

  private onVad(kind: "start" | "end", atMs: number): void {
    if (this.closed || this.options.pushToTalk) return;
    if (kind === "end") {
      this.options.events.onVad(false);
      this.ignoringUntilEnd = false;
      this.endSpeech();
      return;
    }
    this.options.events.onVad(true);
    if (this.capturing || this.ignoringUntilEnd) return;
    this.begin(Math.max(0, atMs * BYTES_PER_MS - this.options.prerollMs * BYTES_PER_MS));
  }

  /** Open an STT stream and give it the audio from `fromByte` on. */
  private begin(fromByte: number): void {
    const abort = new AbortController();
    const stream = this.options.stt.open({ language: this.options.language, sampleRate: VOICE_INPUT_SAMPLE_RATE, signal: abort.signal });
    const open: Open = {
      id: this.options.newId(), stream, abort, startedAt: this.options.clock.now(),
      endedAt: null, audioMs: 0, partial: "", settled: false, cancelTimeout: null,
    };
    stream.on((event) => this.onStt(open, event));
    this.capturing = open;
    this.options.events.onStart(open.id);
    const seed = this.seedFrom(fromByte);
    if (seed.length > 0) {
      stream.write(seed);
      open.audioMs += seed.length / BYTES_PER_MS;
    }
  }

  /** The buffered audio from absolute byte `fromByte` to now. */
  private seedFrom(fromByte: number): Buffer {
    const all = Buffer.concat(this.ring);
    const ringStart = this.written - all.length;
    const from = Math.min(all.length, Math.max(0, fromByte - ringStart));
    return all.subarray(from - (from % 2));
  }

  private endSpeech(): void {
    const open = this.capturing;
    if (!open) return;
    this.capturing = null;
    this.finish(open);
  }

  private finish(open: Open): void {
    open.endedAt = this.options.clock.now();
    this.awaiting.add(open);
    open.cancelTimeout = this.options.clock.setTimeout(() => this.fail(open), FINAL_TIMEOUT_MS);
    open.stream.end();
  }

  private cutForLength(open: Open): void {
    this.capturing = null;
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
