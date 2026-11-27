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
import { audioFrameHeader, pcmDurationMs, Pcm16Resampler, Pcm16TimeStretcher, pcmPieces } from "./pcm.js";
import { SpeakableSplitter, speakableSentence } from "./speakable-splitter.js";
import { errorField, silentTracer, type Tracer } from "./trace.js";

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
  /** The stored assistant message the sentence belongs to, when it is known (a reply the client missed). */
  messageId?: string;
  /** The reply this sentence belongs to, for `spokenFor`. */
  replyKey?: number;
  /** Milliseconds of audio sent to the client for this segment so far. */
  sentMs: number;
  /** The segment this one speaks again after a barge-in cut it: once this has been sent, that one no longer counts. */
  replaces?: number;
  /** Where it fell in what the client was sent (so in what it plays), set when its audio starts: a replay jumps ahead of the queue, so ids do not say. */
  sentOrder?: number;
  /** Diagnostics only: when it was queued, when its first frame and its end went out, and how many frames and bytes were sent. */
  enqueuedAt?: number;
  startedAt?: number;
  endedAt?: number;
  sentFrames?: number;
  sentBytes?: number;
}

export interface PipelineOptions {
  tts: TtsProvider;
  sink: SpeechSink;
  voice: string | null;
  /** Speaking-rate multiplier; a function is asked for each sentence, so a change applies to the next one. */
  speed: number | (() => number);
  language: string;
  /** The first audio frame of a segment went out. */
  onAudio?: (segment: Segment) => void;
  /** Synthesis of a sentence failed; the reply stays as text. The cause is for the log, never the client. */
  onSynthesisError?: (error: unknown) => void;
  /** Diagnostic lines for the segment lifecycle; absent: nothing is logged. */
  trace?: Tracer;
}

/** What a barge-in left behind. */
export interface CutResult {
  /** What the user heard of the reply, whole sentences and the part of the one playing. */
  heard: string;
  /** The sentences to speak again from, the first one heard only in part or not at all. */
  unheard: string[];
  /** The reply the cut belongs to (as `markReply` named it), when it had one. */
  replyKey?: number;
  /** `heard`, split by the stored message each sentence belongs to, for a reply made of several stored messages. */
  heardBy: HeardPart[];
  /** The stored message of each of `unheard`, in step with it; undefined for a streamed reply. */
  unheardIds: Array<string | undefined>;
  /**
   * Other replies that had sentences waiting or sent and not played when the cut fell (a report sent between a
   * streamed reply's sentences), each as the cut left it: what of it was heard, what was not.
   */
  others?: CutResult[];
}

/** What was heard of one stored message of a cut reply. */
export interface HeardPart {
  messageId: string | undefined;
  text: string;
  /** Every sentence of the message was heard to its end. */
  complete: boolean;
}

/** Synthesis of one segment, filled as the provider yields. */
interface Job {
  chunks: Buffer[];
  done: boolean;
  error?: unknown;
  wake: (() => void) | null;
  /** Diagnostics only: what the provider yielded and what went on to the wire. */
  startedAt: number;
  providerChunks: number;
  providerBytes: number;
  wireBytes: number;
  firstChunkAt: number | null;
  oddChunks: number;
}

const RETAINED_SEGMENTS = 200;

export class SpeechPipeline {
  private readonly splitter = new SpeakableSplitter();
  private queue: Segment[] = [];
  private readonly history: Segment[] = [];
  private jobs = new Map<number, Job>();
  private nextId = 1;
  private sentCount = 0;
  private replyKey: number | undefined;
  private seq = 0;
  private generation = 0;
  private abort = new AbortController();
  private held = false;
  private running = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  /** The sentences the last cut left unheard, in order: what a resume with those texts speaks again. */
  private cutUnheard: Segment[] = [];
  /** The same for the other replies the last cut caught mid-speech, by reply. */
  private cutUnheardOthers: Array<{ key: number; segments: Segment[] }> = [];

  private readonly trace: Tracer;

  constructor(private readonly options: PipelineOptions) {
    this.trace = options.trace ?? silentTracer;
  }

  /** A reply delta; sentences it completes are queued to be spoken. */
  feed(delta: string): void {
    for (const sentence of this.splitter.push(delta)) this.enqueue(sentence);
  }

  /** The reply ended: its last, unfinished sentence is spoken too. */
  endReply(): void {
    for (const sentence of this.splitter.flush()) this.enqueue(sentence);
  }

  /** Speak a whole text (a missed reply), not a stream; `messageId` names its stored message when known. */
  speakText(text: string, messageId?: string): void {
    const splitter = new SpeakableSplitter();
    for (const sentence of [...splitter.push(`${text}\n`), ...splitter.flush()]) this.enqueue(sentence, false, messageId);
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

  /** What was spoken of a reply (or of one stored message of it): its sentences that went out to the client. */
  spokenFor(key: number, messageId?: string): string {
    return this.history
      .filter((s) => s.replyKey === key && s.sentMs > 0 && !this.replayed(s) && (messageId === undefined || s.messageId === messageId))
      .sort(byOrder)
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

  /** As `hasUnplayed`, for the reply's own sentences: a holding line is not the reply being spoken. */
  hasUnplayedReply(): boolean {
    return this.queue.some((s) => !s.holding)
      || this.history.some((s) => !s.holding && (s.state === "queued" || s.state === "synthesising" || s.state === "sent"));
  }

  /** Whether the reply's own sentences are queued, being made, or sent and not yet reported played. */
  hasUnplayedFor(key: number): boolean {
    return this.queue.some((s) => s.replyKey === key)
      || this.history.some((s) => s.replyKey === key && (s.state === "queued" || s.state === "synthesising" || s.state === "sent"));
  }

  /** Whether speaking is held, as after a cut, awaiting what follows it. */
  isHeld(): boolean {
    return this.held;
  }

  /** The client reported a segment played in full. */
  markPlayed(segmentId: number): void {
    const segment = this.history.find((s) => s.id === segmentId);
    const before = segment?.state;
    if (segment && segment.state === "sent") segment.state = "played";
    this.trace.info("segment_played_report", {
      segment: segmentId, state_before: before ?? "unknown", state_after: segment?.state ?? "unknown",
      since_end_ms: segment?.endedAt === undefined ? undefined : Date.now() - segment.endedAt,
      sent_ms: segment ? Math.round(segment.sentMs) : undefined,
    });
    this.notifyIdle();
  }

  /**
   * Stop speaking now. `segmentId` is the segment the client was playing and
   * `playedMs` how much of it, or null when the gateway cut on its own hearing
   * and knows only what was reported played.
   */
  cut(segmentId: number | null, playedMs: number): CutResult {
    const inFlight = this.history.filter((s) => s.state === "queued" || s.state === "synthesising" || s.state === "sent");
    this.generation += 1;
    this.abort.abort();
    this.abort = new AbortController();
    this.wakeAll();
    this.jobs = new Map();
    const { result, wholeIds, unheard, othersUnheard } = this.heardAndUnheard(segmentId, playedMs);
    for (const segment of this.history) {
      // What was heard to its end stays heard, so a later cut of the replay still counts it.
      if (wholeIds.has(segment.id)) segment.state = "played";
      else if (segment.state === "queued" || segment.state === "synthesising" || segment.state === "sent") segment.state = "cut";
    }
    this.cutUnheard = unheard;
    this.cutUnheardOthers = othersUnheard;
    this.trace.info("pipeline_cut", {
      generation: this.generation, segment: segmentId, played_ms: Math.round(playedMs),
      in_flight: inFlight.length, queued: this.queue.length, sent: inFlight.filter((s) => s.state === "cut" && (s.sentMs > 0)).length,
      heard_chars: result.heard.length, unheard_sentences: result.unheard.length,
      sent_ms_of_playing: segmentId === null ? undefined : this.history.find((s) => s.id === segmentId)?.sentMs,
      other_replies: result.others?.length ?? 0,
    });
    this.queue = [];
    this.splitter.reset();
    this.notifyIdle();
    return result;
  }

  /** Sentences held since a cut are dropped: the new turn will bring its own reply. */
  discardQueued(): void {
    if (this.queue.length > 0) this.trace.info("pipeline_discard_queued", { queued: this.queue.length });
    this.queue = [];
    this.cutUnheard = [];
    this.cutUnheardOthers = [];
    this.splitter.reset();
    this.notifyIdle();
  }

  /**
   * Speak these again ahead of anything queued since the cut, then the sentences the cut left unheard of any other
   * reply it caught mid-speech, each as the reply and stored message it came from.
   */
  resumeWith(texts: readonly string[], messageIds: ReadonlyArray<string | undefined> = []): void {
    const unheard = this.cutUnheard;
    const others = this.cutUnheardOthers;
    this.cutUnheard = [];
    this.cutUnheardOthers = [];
    const segments = texts.map((text, i) => {
      const segment = this.newSegment(text);
      const messageId = messageIds[i];
      if (messageId) segment.messageId = messageId;
      if (unheard[i]?.text === text) segment.replaces = unheard[i].id;
      return segment;
    });
    const rest = others.flatMap(({ key, segments: old }) => old.map((was) => {
      const segment = this.newSegment(was.text, false, key);
      if (was.messageId) segment.messageId = was.messageId;
      segment.replaces = was.id;
      return segment;
    }));
    this.queue = [...segments, ...rest, ...this.queue];
    this.trace.info("pipeline_resume", { replay_sentences: segments.length, other_reply_sentences: rest.length, queued_after: this.queue.length });
    this.kick();
  }

  /** Resolves once nothing is queued or being made. */
  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  close(): void {
    this.trace.info("pipeline_close", { queued: this.queue.length, unplayed: this.hasUnplayed() });
    this.closed = true;
    this.generation += 1;
    this.abort.abort();
    this.wakeAll();
    this.queue = [];
    this.splitter.reset();
    this.notifyIdle();
  }

  /** The reply a cut belongs to: the one the playing sentence is of, else the newest that was started. */
  private replyOfCut(segmentId: number | null): number | undefined {
    const spoken = this.history.filter((s) => !s.holding);
    const playing = segmentId === null ? undefined : spoken.find((s) => s.id === segmentId);
    if (playing) return playing.replyKey;
    return [...spoken].reverse().find((s) => s.state !== "queued")?.replyKey ?? spoken[spoken.length - 1]?.replyKey;
  }

  /** A cut sentence whose replay, or the replay of that replay, has gone out: only the replay counts. */
  private replayed(segment: Segment): boolean {
    return this.history.some((s) => s.replaces === segment.id && (s.sentMs > 0 || this.replayed(s)));
  }

  /** What a cut left to say, in the order it will be said: what was sent and not heard, then the queue. */
  private pendingInOrder(scope: readonly Segment[], key: number | undefined, wholeIds: ReadonlySet<number>): Segment[] {
    const candidates = [...scope, ...this.queue.filter((s) => !s.holding && s.replyKey === key)]
      .filter((s, i, all) => all.indexOf(s) === i && !wholeIds.has(s.id) && s.state !== "cut" && s.state !== "played");
    const queued = (s: Segment) => { const at = this.queue.indexOf(s); return at < 0 ? Infinity : at; };
    return [
      ...candidates.filter((s) => s.sentOrder !== undefined).sort(byOrder),
      ...candidates.filter((s) => s.sentOrder === undefined).sort((a, b) => queued(a) - queued(b)),
    ];
  }

  private heardAndUnheard(segmentId: number | null, playedMs: number): { result: CutResult; wholeIds: Set<number>; unheard: Segment[]; othersUnheard: Array<{ key: number; segments: Segment[] }> } {
    const key = this.replyOfCut(segmentId);
    const main = this.heardOfReply(key, segmentId, playedMs);
    const wholeIds = new Set(main.wholeIds);
    // Replies that were mid-speech beside it (not the one the client was playing): what the client played before the
    // playing sentence was heard whole, the rest of what went out or waited was not heard.
    const anchor = segmentId === null ? undefined : this.history.find((s) => s.id === segmentId && (s.state === "sent" || s.state === "played"));
    const others: CutResult[] = [];
    const othersUnheard: Array<{ key: number; segments: Segment[] }> = [];
    const keys = new Set(this.history.filter((s) => !s.holding && s.replyKey !== undefined && s.replyKey !== key).map((s) => s.replyKey as number));
    for (const other of keys) {
      const found = this.heardOfReply(other, segmentId, playedMs, anchor);
      if (found.unheard.length === 0) continue;
      for (const id of found.wholeIds) wholeIds.add(id);
      others.push(found.result);
      othersUnheard.push({ key: other, segments: found.unheard });
    }
    const result = others.length > 0 ? { ...main.result, others } : main.result;
    return { result, wholeIds, unheard: main.unheard, othersUnheard };
  }

  /** What a cut left of one reply: `anchor` is the playing sentence when it belongs to another reply. */
  private heardOfReply(key: number | undefined, segmentId: number | null, playedMs: number, anchor?: Segment): { result: CutResult; wholeIds: Set<number>; unheard: Segment[] } {
    // Only the interrupted reply: sentences of earlier replies, and holding lines, are neither heard of it nor resumed.
    // A sentence already spoken again is not of it twice.
    const scope = this.history.filter((s) => !s.holding && s.replyKey === key && !this.replayed(s));
    const sent = scope.filter((s) => s.state === "sent" || s.state === "played");
    const playing = segmentId === null ? undefined : sent.find((s) => s.id === segmentId);
    // Heard whole: played before the playing one, in the order the client plays them.
    const reference = playing ?? anchor;
    const before = (s: Segment) => (segmentId === null ? s.state === "played" : reference ? (s.sentOrder ?? 0) < (reference.sentOrder ?? 0) : s.id < segmentId);
    const whole = sent.filter(before).sort(byOrder);
    const ratio = playing && playing.sentMs > 0 ? Math.min(1, Math.max(0, playedMs / playing.sentMs)) : 0;
    const heard = [...whole.map((s) => s.text), ...(playing ? [partOf(playing.text, ratio)] : [])].filter(Boolean).join(" ");
    const wholeIds = new Set(whole.map((s) => s.id));
    const pending = this.pendingInOrder(scope, key, wholeIds);
    const unheardSegments = pending.filter((s) => s.id !== playing?.id || ratio < 1);
    const heardBy = heardParts(scope, wholeIds, playing, ratio);
    const result: CutResult = { heard, unheard: unheardSegments.map((s) => s.text), replyKey: key, heardBy, unheardIds: unheardSegments.map((s) => s.messageId) };
    return { result, wholeIds, unheard: unheardSegments };
  }

  private enqueue(text: string, holding = false, messageId?: string): void {
    if (this.closed) return;
    const segment = this.newSegment(text, holding);
    if (messageId) segment.messageId = messageId;
    this.queue.push(segment);
    this.trace.info("segment_queued", {
      segment: segment.id, chars: text.length, holding, reply: segment.replyKey, message: segment.messageId, queued: this.queue.length, held: this.held,
    });
    this.kick();
    this.prefetch();
  }

  /** While a segment is being sent, the one after it is already being made. */
  private prefetch(): void {
    if (!this.running || this.held || this.closed) return;
    for (const segment of this.queue.slice(0, 2)) this.ensureJob(segment);
  }

  private newSegment(text: string, holding = false, key: number | undefined = this.replyKey): Segment {
    const segment: Segment = { id: this.nextId++, text, state: "queued", sentMs: 0, enqueuedAt: Date.now() };
    if (holding) segment.holding = true;
    else if (key !== undefined) segment.replyKey = key;
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
    const job: Job = { chunks: [], done: false, wake: null, startedAt: Date.now(), providerChunks: 0, providerBytes: 0, wireBytes: 0, firstChunkAt: null, oddChunks: 0 };
    this.jobs.set(segment.id, job);
    if (segment.state === "queued") segment.state = "synthesising";
    void this.synthesise(segment, job, this.abort.signal);
    return job;
  }

  private async synthesise(segment: Segment, job: Job, signal: AbortSignal): Promise<void> {
    const { tts, voice, language } = this.options;
    const resampler = new Pcm16Resampler(tts.sampleRate, VOICE_OUTPUT_SAMPLE_RATE);
    const { speed, stretcher } = this.pace();
    this.traceSynthStart(segment, job, { rate: tts.sampleRate, speed, stretched: stretcher !== null, voice });
    try {
      const request = { ...(voice ? { voice } : {}), speed, language, signal };
      for await (const chunk of tts.synthesize(segment.text, request)) {
        if (signal.aborted) return;
        this.noteProviderChunk(segment, job, chunk);
        const resampled = resampler.push(chunk);
        this.addAudio(job, stretcher ? stretcher.push(resampled) : resampled);
      }
      if (stretcher && !signal.aborted) this.addAudio(job, stretcher.flush());
    } catch (error) {
      if (!signal.aborted) job.error = error;
    } finally {
      job.done = true;
      this.traceSynthesis(segment, job, signal.aborted);
      this.wake(job);
    }
  }

  /**
   * The speed to ask the provider for, and the stretch that makes it up when the provider cannot. The provider is
   * asked whenever it applies the speed; otherwise it is asked for the natural pace and the audio is stretched here.
   */
  private pace(): { speed: number; stretcher: Pcm16TimeStretcher | null } {
    const { speed, tts } = this.options;
    const wanted = typeof speed === "function" ? speed() : speed;
    if (tts.honoursSpeed !== false || wanted === 1) return { speed: wanted, stretcher: null };
    return { speed: 1, stretcher: new Pcm16TimeStretcher(wanted) };
  }

  private traceSynthStart(segment: Segment, job: Job, how: { rate: number; speed: number; stretched: boolean; voice: string | null }): void {
    this.trace.info("synth_start", {
      segment: segment.id, chars: segment.text.length, provider_rate: how.rate, wire_rate: VOICE_OUTPUT_SAMPLE_RATE,
      speed: how.speed, stretched: how.stretched, voice: how.voice ?? "default", queue_wait_ms: Date.now() - (segment.enqueuedAt ?? job.startedAt),
    });
  }

  /** What the provider gave, before resampling: counted for the segment's summary, one line per chunk at debug. */
  private noteProviderChunk(segment: Segment, job: Job, chunk: Buffer): void {
    job.providerChunks += 1;
    job.providerBytes += chunk.length;
    if (chunk.length % 2 !== 0) job.oddChunks += 1;
    job.firstChunkAt ??= Date.now();
    this.trace.debug("synth_chunk", { segment: segment.id, n: job.providerChunks, bytes: chunk.length, since_start_ms: Date.now() - job.startedAt });
  }

  /** How synthesis of a segment ended: the figures that tell silence, truncation and a slow provider apart. */
  private traceSynthesis(segment: Segment, job: Job, aborted: boolean): void {
    const now = Date.now();
    const audioMs = Math.round(pcmDurationMs(job.wireBytes, VOICE_OUTPUT_SAMPLE_RATE));
    const fields = {
      segment: segment.id, chars: segment.text.length, chunks: job.providerChunks, provider_bytes: job.providerBytes, wire_bytes: job.wireBytes,
      audio_ms: audioMs, odd_chunks: job.oddChunks, ttfb_ms: job.firstChunkAt === null ? undefined : job.firstChunkAt - job.startedAt, total_ms: now - job.startedAt,
      // Speech runs at roughly 12 characters a second: far less audio than the text needs is a truncated synthesis.
      ms_per_char: segment.text.length > 0 ? Math.round(audioMs / segment.text.length) : undefined,
    };
    if (aborted) return this.trace.info("synth_aborted", fields);
    if (job.error !== undefined) return this.trace.warn("synth_failed", { ...fields, error: errorField(job.error) });
    if (job.wireBytes === 0) return this.trace.warn("synth_empty", fields);
    this.trace.info("synth_end", fields);
  }

  private addAudio(job: Job, pcm: Buffer): void {
    if (pcm.length > 0) {
      job.chunks.push(pcm);
      job.wireBytes += pcm.length;
    }
    this.wake(job);
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
    if (generation !== this.generation) {
      this.trace.info("segment_send_abandoned", { segment: segment.id, sent_frames: segment.sentFrames ?? 0, sent_ms: Math.round(segment.sentMs), chunks_sent: index, chunks_made: job.chunks.length, synth_done: job.done });
      return;
    }
    this.finishSegment(segment, job, started);
  }

  private sendChunk(segment: Segment, pcm: Buffer, started: boolean): boolean {
    const { sink } = this.options;
    if (!started) {
      segment.state = "sent";
      segment.sentOrder = ++this.sentCount;
      segment.startedAt = Date.now();
      this.trace.info("segment_start", {
        segment: segment.id, order: segment.sentOrder, chars: segment.text.length, seq_first: this.seq & 0xffff,
        since_queued_ms: segment.startedAt - (segment.enqueuedAt ?? segment.startedAt), holding: segment.holding === true, replaces: segment.replaces,
      });
      sink.json({ type: "segment_start", segmentId: segment.id, messageId: segment.messageId ?? null, text: segment.text });
    }
    for (const piece of pcmPieces(pcm)) {
      const seq = this.seq++;
      sink.audio(Buffer.concat([audioFrameHeader(seq, segment.id), piece]));
      segment.sentFrames = (segment.sentFrames ?? 0) + 1;
      segment.sentBytes = (segment.sentBytes ?? 0) + piece.length;
      this.trace.debug("audio_frame", { segment: segment.id, seq: seq & 0xffff, bytes: piece.length, sent_ms: Math.round(segment.sentMs), since_start_ms: Date.now() - (segment.startedAt ?? Date.now()) });
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
    segment.endedAt = Date.now();
    if (started) {
      this.trace.info("segment_end", {
        segment: segment.id, frames: segment.sentFrames ?? 0, bytes: segment.sentBytes ?? 0, audio_ms: Math.round(segment.sentMs),
        send_ms: segment.endedAt - (segment.startedAt ?? segment.endedAt), synth_ms: segment.endedAt - job.startedAt,
        seq_last: (this.seq - 1) & 0xffff, error: job.error === undefined ? undefined : errorField(job.error),
      });
      this.options.sink.json({ type: "segment_end", segmentId: segment.id });
    } else if (segment.state !== "cut") {
      this.trace.warn("segment_skipped_silent", { segment: segment.id, chars: segment.text.length, error: job.error === undefined ? undefined : errorField(job.error) });
      segment.state = "played";
      segment.sentOrder = ++this.sentCount;
    }
    this.jobs.delete(segment.id);
  }
}

const byOrder = (a: Segment, b: Segment): number => (a.sentOrder ?? 0) - (b.sentOrder ?? 0);

/** What was heard of each stored message of a cut reply, in order; a streamed reply is one part with no message id. */
function heardParts(scope: readonly Segment[], wholeIds: ReadonlySet<number>, playing: Segment | undefined, ratio: number): HeardPart[] {
  const parts: HeardPart[] = [];
  for (const segment of scope) {
    let part = parts.find((p) => p.messageId === segment.messageId);
    if (!part) parts.push(part = { messageId: segment.messageId, text: "", complete: true });
    const heard = wholeIds.has(segment.id) ? segment.text : segment === playing && ratio > 0 ? partOf(segment.text, ratio) : "";
    part.text = [part.text, heard].filter(Boolean).join(" ");
    if (!wholeIds.has(segment.id) && !(segment === playing && ratio >= 1)) part.complete = false;
  }
  return parts;
}

/** The leading part of a sentence heard when `ratio` of its audio played, cut at a word. */
export function partOf(text: string, ratio: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, Math.floor(words.length * ratio)).join(" ");
}
