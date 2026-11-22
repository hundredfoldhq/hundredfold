/**
 * Reply text to speech frames, sentence by sentence (FR-005, FR-007). One
 * pipeline per attachment: deltas go in, binary audio frames and
 * `segment_start` / `segment_end` frames come out of the sink.
 *
 * Synthesis of sentence N+1 overlaps the sending of N (a prefetch of one), so
 * the gap between sentences is the provider's tail, not its whole latency. A
 * barge-in is `cut()`: synchronous, so no frame of an already-queued segment is
 * sent after it returns.
 */
import type { TtsProvider } from "./provider.js";
import { VOICE_OUTPUT_SAMPLE_RATE, type VoiceServerFrame } from "../shared/gateway-events.js";
import { audioFrameHeader, pcmDurationMs, Pcm16Resampler, pcmPieces } from "./pcm.js";
import { SpeakableSplitter, speakableSentence } from "./speakable-splitter.js";

export interface SpeechSink {
  json(frame: VoiceServerFrame): void;
  /** A complete downstream binary frame: header and PCM. */
  audio(frame: Buffer): void;
}

export type SegmentState = "queued" | "synthesising" | "sent" | "played" | "cut";

export interface Segment {
  id: number;
  text: string;
  state: SegmentState;
  /** A line spoken with no model turn behind it (a holding line). */
  holding?: boolean;
  /** The reply this sentence belongs to, for `spokenFor`. */
  replyKey?: number;
  /** Milliseconds of audio sent to the client for this segment so far. */
  sentMs: number;
}

export interface PipelineOptions {
  tts: TtsProvider;
  sink: SpeechSink;
  voice: string | null;
  speed: number;
  language: string;
  /** The first audio frame of a segment went out. */
  onAudio?: (segment: Segment) => void;
  /** Synthesis of a sentence failed; the reply stays as text. The cause is for the log, never the client. */
  onSynthesisError?: (error: unknown) => void;
}

/** What a barge-in left behind. */
export interface CutResult {
  /** What the user heard of the reply, whole sentences and the part of the one playing. */
  heard: string;
  /** The sentences to speak again from, the first one heard only in part or not at all. */
  unheard: string[];
}

/** Synthesis of one segment, filled as the provider yields. */
interface Job {
  chunks: Buffer[];
  done: boolean;
  error?: unknown;
  wake: (() => void) | null;
}

const RETAINED_SEGMENTS = 200;

export class SpeechPipeline {
  private readonly splitter = new SpeakableSplitter();
  private queue: Segment[] = [];
  private readonly history: Segment[] = [];
  private jobs = new Map<number, Job>();
  private nextId = 1;
  private replyKey: number | undefined;
  private seq = 0;
  private generation = 0;
  private abort = new AbortController();
  private held = false;
  private running = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: PipelineOptions) {}

  /** A reply delta; sentences it completes are queued to be spoken. */
  feed(delta: string): void {
    for (const sentence of this.splitter.push(delta)) this.enqueue(sentence);
  }

  /** The reply ended: its last, unfinished sentence is spoken too. */
  endReply(): void {
    for (const sentence of this.splitter.flush()) this.enqueue(sentence);
  }

  /** Speak a whole text (a missed reply), not a stream. */
  speakText(text: string): void {
    const splitter = new SpeakableSplitter();
    for (const sentence of [...splitter.push(`${text}\n`), ...splitter.flush()]) this.enqueue(sentence);
  }

  /** Speak one self-contained line with no model turn behind it, and tell the client. */
  speakLine(text: string): void {
    const line = speakableSentence(text);
    if (!line) return;
    this.options.sink.json({ type: "holding", text: line });
    this.enqueue(line, true);
  }

  /** Sentences queued from now on belong to this reply. */
  markReply(key: number): void {
    this.replyKey = key;
  }

  /** What was spoken of a reply: its sentences that went out to the client. */
  spokenFor(key: number): string {
    return this.history
      .filter((s) => s.replyKey === key && s.sentMs > 0)
      .map((s) => s.text)
      .join(" ");
  }

  /** Stop starting segments; whatever arrives is kept in order. */
  hold(): void {
    this.held = true;
  }

  release(): void {
    this.held = false;
    this.kick();
  }

  /** Whether any sentence is queued, being made, or sent and not yet reported played. */
  hasUnplayed(): boolean {
    return this.queue.length > 0 || this.history.some((s) => s.state === "queued" || s.state === "synthesising" || s.state === "sent");
  }

  /** The client reported a segment played in full. */
  markPlayed(segmentId: number): void {
    const segment = this.history.find((s) => s.id === segmentId);
    if (segment && segment.state === "sent") segment.state = "played";
    this.notifyIdle();
  }

  /**
   * Stop speaking now. `segmentId` is the segment the client was playing and
   * `playedMs` how much of it, or null when the gateway cut on its own hearing
   * and knows only what was reported played.
   */
  cut(segmentId: number | null, playedMs: number): CutResult {
    this.generation += 1;
    this.abort.abort();
    this.abort = new AbortController();
    this.wakeAll();
    this.jobs = new Map();
    const result = this.heardAndUnheard(segmentId, playedMs);
    for (const segment of this.history) {
      if (segment.state === "queued" || segment.state === "synthesising" || segment.state === "sent") segment.state = "cut";
    }
    this.queue = [];
    this.splitter.reset();
    this.notifyIdle();
    return result;
  }

  /** Sentences held since a cut are dropped: the new turn will bring its own reply. */
  discardQueued(): void {
    this.queue = [];
    this.splitter.reset();
    this.notifyIdle();
  }

  /** Speak these again ahead of anything queued since the cut. */
  resumeWith(texts: readonly string[]): void {
    const segments = texts.map((text) => this.newSegment(text));
    this.queue = [...segments, ...this.queue];
    this.kick();
  }

  /** Resolves once nothing is queued or being made. */
  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    this.generation += 1;
    this.abort.abort();
    this.wakeAll();
    this.queue = [];
    this.splitter.reset();
    this.notifyIdle();
  }

  private heardAndUnheard(segmentId: number | null, playedMs: number): CutResult {
    const sent = this.history.filter((s) => s.state === "sent" || s.state === "played");
    const upTo = segmentId ?? Number.POSITIVE_INFINITY;
    const whole = sent.filter((s) => (segmentId === null ? s.state === "played" : s.id < upTo));
    const playing = segmentId === null ? undefined : sent.find((s) => s.id === segmentId);
    const ratio = playing && playing.sentMs > 0 ? Math.min(1, Math.max(0, playedMs / playing.sentMs)) : 0;
    const heard = [...whole.map((s) => s.text), ...(playing ? [partOf(playing.text, ratio)] : [])].filter(Boolean).join(" ");
    const wholeIds = new Set(whole.map((s) => s.id));
    const unheard = [...this.history.filter((s) => !wholeIds.has(s.id) && s.state !== "cut" && s.state !== "played"), ...this.queue]
      .filter((s, i, all) => all.indexOf(s) === i && (s.id !== playing?.id || ratio < 1))
      .map((s) => s.text);
    return { heard, unheard };
  }

  private enqueue(text: string, holding = false): void {
    if (this.closed) return;
    this.queue.push(this.newSegment(text, holding));
    this.kick();
    this.prefetch();
  }

  /** While a segment is being sent, the one after it is already being made. */
  private prefetch(): void {
    if (!this.running || this.held || this.closed) return;
    for (const segment of this.queue.slice(0, 2)) this.ensureJob(segment);
  }

  private newSegment(text: string, holding = false): Segment {
    const segment: Segment = { id: this.nextId++, text, state: "queued", sentMs: 0 };
    if (holding) segment.holding = true;
    else if (this.replyKey !== undefined) segment.replyKey = this.replyKey;
    this.history.push(segment);
    if (this.history.length > RETAINED_SEGMENTS) this.history.shift();
    return segment;
  }

  private kick(): void {
    if (this.running || this.held || this.closed || this.queue.length === 0) return;
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
      this.notifyIdle();
      this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (!this.held && !this.closed && this.queue.length > 0) {
      const generation = this.generation;
      const segment = this.queue[0];
      this.ensureJob(segment);
      if (this.queue[1]) this.ensureJob(this.queue[1]);
      await this.send(segment, generation);
      if (generation === this.generation) this.queue.shift();
    }
  }

  private notifyIdle(): void {
    if (this.running || this.queue.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private ensureJob(segment: Segment): Job {
    const existing = this.jobs.get(segment.id);
    if (existing) return existing;
    const job: Job = { chunks: [], done: false, wake: null };
    this.jobs.set(segment.id, job);
    if (segment.state === "queued") segment.state = "synthesising";
    void this.synthesise(segment, job, this.abort.signal);
    return job;
  }

  private async synthesise(segment: Segment, job: Job, signal: AbortSignal): Promise<void> {
    const { tts, voice, speed, language } = this.options;
    const resampler = new Pcm16Resampler(tts.sampleRate, VOICE_OUTPUT_SAMPLE_RATE);
    try {
      const request = { ...(voice ? { voice } : {}), speed, language, signal };
      for await (const chunk of tts.synthesize(segment.text, request)) {
        if (signal.aborted) return;
        const pcm = resampler.push(chunk);
        if (pcm.length > 0) job.chunks.push(pcm);
        this.wake(job);
      }
    } catch (error) {
      if (!signal.aborted) job.error = error;
    } finally {
      job.done = true;
      this.wake(job);
    }
  }

  /** Let every sender waiting on a job see that the generation moved on. */
  private wakeAll(): void {
    for (const job of this.jobs.values()) this.wake(job);
  }

  private wake(job: Job): void {
    const wake = job.wake;
    job.wake = null;
    wake?.();
  }

  /** Stream one segment's frames as they are made. A cut ends it without another frame. */
  private async send(segment: Segment, generation: number): Promise<void> {
    const job = this.ensureJob(segment);
    let index = 0;
    let started = false;
    while (generation === this.generation) {
      if (index < job.chunks.length) {
        started = this.sendChunk(segment, job.chunks[index++], started);
        continue;
      }
      if (job.done) break;
      await new Promise<void>((resolve) => { job.wake = resolve; });
    }
    if (generation !== this.generation) return;
    this.finishSegment(segment, job, started);
  }

  private sendChunk(segment: Segment, pcm: Buffer, started: boolean): boolean {
    const { sink } = this.options;
    if (!started) {
      segment.state = "sent";
      sink.json({ type: "segment_start", segmentId: segment.id, messageId: null, text: segment.text });
    }
    for (const piece of pcmPieces(pcm)) {
      sink.audio(Buffer.concat([audioFrameHeader(this.seq++, segment.id), piece]));
      segment.sentMs += pcmDurationMs(piece.length, VOICE_OUTPUT_SAMPLE_RATE);
      if (!started) {
        this.options.onAudio?.(segment);
        started = true;
      }
    }
    return true;
  }

  private finishSegment(segment: Segment, job: Job, started: boolean): void {
    if (job.error !== undefined) this.options.onSynthesisError?.(job.error);
    if (started) this.options.sink.json({ type: "segment_end", segmentId: segment.id });
    else if (segment.state !== "cut") segment.state = "played";
    this.jobs.delete(segment.id);
  }
}

/** The leading part of a sentence heard when `ratio` of its audio played, cut at a word. */
export function partOf(text: string, ratio: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, Math.floor(words.length * ratio)).join(" ");
}
