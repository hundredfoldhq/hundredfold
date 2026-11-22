/**
 * Fakes for the voice hub: provider, VAD, engine, socket and an injected clock.
 * Nothing here touches a network, a model or a process.
 */
import type { Engine, EngineResult, EngineRunOpts, ForegroundWork, SoftInterruptOutcome } from "../../shared/types.js";
import type { SttEvent, SttProvider, SttStream, SttStreamOptions, TtsProvider, TtsSynthesisOptions, VadStream } from "../provider.js";
import type { CancelTimer, VoiceClock, VoiceSocket } from "../hub-types.js";

export class FakeClock implements VoiceClock {
  private time = 1_000_000;
  private timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  now(): number {
    return this.time;
  }
  setTimeout(run: () => void, ms: number): CancelTimer {
    const timer = { at: this.time + ms, run, live: true };
    this.timers.push(timer);
    return () => { timer.live = false; };
  }
  /** Move time on, running every timer that falls due in order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.time = Math.max(this.time, due.at);
      due.live = false;
      due.run();
    }
    this.time = end;
  }
  pending(): number {
    return this.timers.filter((t) => t.live).length;
  }
}

/** Let promise chains settle. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export class FakeVad implements VadStream {
  written = 0;
  closed = false;
  private handler: ((event: { kind: "start" | "end"; atMs: number }) => void) | null = null;
  write(pcm: Buffer): void {
    this.written += pcm.length;
  }
  on(handler: (event: { kind: "start" | "end"; atMs: number }) => void): void {
    this.handler = handler;
  }
  close(): void {
    this.closed = true;
  }
  /** Stream position now, in ms of 16 kHz PCM16 mono. */
  positionMs(): number {
    return this.written / 32;
  }
  start(atMs = this.positionMs()): void {
    this.handler?.({ kind: "start", atMs });
  }
  end(atMs = this.positionMs()): void {
    this.handler?.({ kind: "end", atMs });
  }
}

export class FakeSttStream implements SttStream {
  writes: Buffer[] = [];
  ended = false;
  aborted = false;
  private handler: ((event: SttEvent) => void) | null = null;
  constructor(readonly options: SttStreamOptions) {}
  write(pcm: Buffer): void {
    this.writes.push(pcm);
  }
  end(): void {
    this.ended = true;
  }
  abort(): void {
    this.aborted = true;
  }
  on(handler: (event: SttEvent) => void): void {
    this.handler = handler;
  }
  bytes(): number {
    return this.writes.reduce((n, b) => n + b.length, 0);
  }
  emit(event: SttEvent): void {
    this.handler?.(event);
  }
  partial(text: string): void {
    this.emit({ type: "partial", text });
  }
  final(text: string): void {
    this.emit({ type: "final", text });
  }
}

export class FakeStt implements SttProvider {
  readonly id = "fake-stt";
  partials = true;
  available = true;
  reason: string | undefined;
  streams: FakeSttStream[] = [];
  open(options: SttStreamOptions): SttStream {
    const stream = new FakeSttStream(options);
    this.streams.push(stream);
    return stream;
  }
  status(): { available: boolean; reason?: string } {
    return this.available ? { available: true } : { available: false, reason: this.reason };
  }
  last(): FakeSttStream {
    return this.streams[this.streams.length - 1];
  }
}

export class FakeTts implements TtsProvider {
  readonly id = "fake-tts";
  sampleRate = 24_000;
  defaultVoice: string | null = "fake-voice";
  available = true;
  calls: string[] = [];
  signals: AbortSignal[] = [];
  failOn: string | null = null;
  /** PCM bytes yielded per chunk, and chunks per sentence. */
  chunkBytes = 960;
  chunksPerSentence = 2;
  /** When set, synthesis of each sentence waits for it. */
  gate: Promise<void> | null = null;
  async *synthesize(text: string, options: TtsSynthesisOptions): AsyncIterable<Buffer> {
    this.calls.push(text);
    this.signals.push(options.signal);
    if (this.gate) await this.gate;
    if (this.failOn !== null && text.includes(this.failOn)) throw new Error("synthesis failed with secret-ish detail");
    for (let i = 0; i < this.chunksPerSentence; i += 1) {
      if (options.signal.aborted) return;
      await Promise.resolve();
      yield Buffer.alloc(this.chunkBytes, 1);
    }
  }
  status(): { available: boolean; reason?: string } {
    return this.available ? { available: true } : { available: false, reason: "tts down" };
  }
}

export class FakeSocket implements VoiceSocket {
  readyState = 1;
  sent: Array<string | Buffer> = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed = { code, reason };
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.frames().filter((f) => f.type === type);
  }
  audio(): Buffer[] {
    return this.sent.filter((d): d is Buffer => Buffer.isBuffer(d));
  }
  clear(): void {
    this.sent = [];
  }
}

export interface FakeEngineOptions {
  soft?: { preserves: boolean };
  steerable?: boolean;
  reportsWork?: boolean;
}

/**
 * An engine of any capability mix. `work` is what it reports as running in the
 * foreground; every spy records, and `kill` counts so a test can prove it was
 * never called.
 */
export class FakeEngine implements Engine {
  name = "fake";
  work: ForegroundWork | null = null;
  kills: string[] = [];
  softCalls: string[] = [];
  steered: string[] = [];
  softOutcome: SoftInterruptOutcome = { ended: true, backgrounded: [] };
  steerOutcome: "steered" | "withdrawn" = "steered";
  steerable: boolean;
  softInterruptPreservesForegroundWork: boolean;
  constructor(private readonly options: FakeEngineOptions = {}) {
    this.steerable = options.steerable ?? false;
    this.softInterruptPreservesForegroundWork = options.soft?.preserves ?? false;
    if (options.soft) {
      (this as unknown as { softInterrupt: unknown }).softInterrupt = async (id: string, reason: string) => {
        this.softCalls.push(`${id}:${reason}`);
        return this.softOutcome;
      };
    }
    if (options.reportsWork !== false && (options.soft || options.steerable || options.reportsWork)) {
      (this as unknown as { foregroundWork: unknown }).foregroundWork = () => this.work;
    }
    if (options.steerable) {
      (this as unknown as { canSteer: unknown }).canSteer = () => this.steerable;
      (this as unknown as { steer: unknown }).steer = async (_id: string, prompt: string) => {
        this.steered.push(prompt);
        return this.steerOutcome;
      };
    }
  }
  async run(_opts: EngineRunOpts): Promise<EngineResult> {
    throw new Error("the fake engine does not run turns");
  }
  kill(sessionId: string, reason?: string): void {
    this.kills.push(`${sessionId}:${reason ?? ""}`);
  }
  isAlive(): boolean {
    return true;
  }
  killAll(): void {}
  killIdle(): void {}
}
