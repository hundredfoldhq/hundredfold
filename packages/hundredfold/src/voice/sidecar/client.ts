/**
 * The gateway's end of the speech sidecar (specs/009-voice-mode/contracts/speech-sidecar.md):
 * spawns it on first need, multiplexes requests over its stdio, pings it while it is in use,
 * respawns it at most once per 30 s after a failure, and reaps it 10 minutes after the last
 * use. Every in-flight request fails, rather than hangs, when the process goes.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { logger } from "../../shared/logger.js";
import { traceDebug, traceLine } from "../trace.js";
import type { VadEventHandler } from "../provider.js";
import { FrameDecoder, FramingError, encodeFrame, type SidecarFrame } from "./framing.js";

export interface SidecarTiming {
  pingEveryMs: number;
  /** Consecutive unanswered pings that mark the sidecar dead. */
  missedPongs: number;
  respawnMinMs: number;
  idleReapMs: number;
  helloTimeoutMs: number;
  /** After EOF on stdin, how long before the process is killed. */
  killGraceMs: number;
}

export const DEFAULT_SIDECAR_TIMING: SidecarTiming = {
  pingEveryMs: 15_000, missedPongs: 2, respawnMinMs: 30_000, idleReapMs: 10 * 60_000, helloTimeoutMs: 180_000, killGraceMs: 3_000,
};

export interface SidecarReady {
  device: "gpu" | "cpu";
  voices: string[];
  sttPartials: boolean;
}

export interface SidecarClientOptions {
  /** Start the sidecar process (the bootstrap has already built its venv and models). */
  spawnProcess: () => ChildProcessWithoutNullStreams;
  /** The `hello` header: the device and where each model lives. */
  hello: () => Record<string, unknown>;
  timing?: Partial<SidecarTiming>;
}

export interface VadParams { threshold: number; minSpeechMs: number; silenceMs: number; prerollMs: number }
export type { VadEvent, VadEventHandler } from "../provider.js";

/** One continuous audio stream through the sidecar's VAD. Holds the sidecar awake while open. */
export interface SidecarVad {
  write(pcm: Buffer): void;
  on(handler: VadEventHandler): void;
  close(): void;
}

export interface TtsChunk { pcm: Buffer; sampleRate: number }

interface Waiter {
  fail(error: Error): void;
}

interface SttWaiter extends Waiter {
  resolve(text: string): void;
}

interface TtsWaiter extends Waiter {
  push(chunk: TtsChunk): void;
  finish(): void;
}

export class SidecarUnavailableError extends Error {}

/** How long a VAD stream's audio is held while the sidecar is not ready, in ms of audio. */
export const VAD_HOLD_MS = 30_000;
/** Bytes of PCM16 mono audio per ms at the sidecar's input rate (16 kHz). */
const VAD_BYTES_PER_MS = 32;
/** One audio frame, as the gateway sends it. */
const VAD_FRAME_MS = 20;
/**
 * Audio held for a VAD stream while the sidecar is not ready: `VAD_HOLD_MS` of 20 ms frames. The VAD's offsets count every
 * byte written, so audio dropped from a full queue is replaced by silence of the same length and later cuts stay put.
 * The held audio is only for the VAD: the transcript is cut from the capture's own ring, which keeps the same window
 * (`UtteranceCapture`), because the VAD's events for what was said during the hold arrive after it, in a burst.
 */
export const MAX_VAD_QUEUE = VAD_HOLD_MS / VAD_FRAME_MS;
/** The longest silent stand-in for dropped audio sent in one frame. */
const MAX_FILLER_BYTES = 64 * 1024;

interface VadStreamState {
  params: VadParams;
  handlers: VadEventHandler[];
  /** The `generation` this stream was last opened under; -1 when never. */
  openedGeneration: number;
  queue: Buffer[];
  /** Bytes of audio dropped from a full queue; sent as silence so offsets keep counting every byte written. */
  dropped: number;
  /** Every byte the caller has passed to `write`, including those dropped. */
  written: number;
  /** Where the current generation's first byte sits in the caller's stream; its event offsets are relative to it. */
  baseBytes: number;
  closed: boolean;
  warned: boolean;
}

/** The caller's byte position of the first byte not yet sent to a sidecar: what a new process's offsets count from. */
function vadStreamPosition(state: VadStreamState): number {
  return state.written - state.queue.reduce((sum, pcm) => sum + pcm.length, 0) - state.dropped;
}

/** `promise`, or a rejection as soon as `signal` aborts (the promise is still handled, so its later failure is not unhandled). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    promise.then(resolve, reject);
  });
}

type Phase =
  | { kind: "stopped" }
  | { kind: "starting"; ready: Promise<SidecarReady> }
  | { kind: "ready"; info: SidecarReady }
  | { kind: "unavailable"; reason: string };

export class SpeechSidecarClient {
  private readonly timing: SidecarTiming;
  private phase: Phase = { kind: "stopped" };
  private child: ChildProcessWithoutNullStreams | null = null;
  private lastSpawnAt = Number.NEGATIVE_INFINITY;
  /** After a failure, the earliest moment the next spawn may happen; a clean reap sets no hold. */
  private holdUntil = Number.NEGATIVE_INFINITY;
  private leases = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pingSeq = 0;
  private pingsOutstanding = 0;
  private closed = false;
  private readonly vadStreams = new Map<string, VadStreamState>();
  /** Counts spawns that reached `ready`; a VAD stream opened under an older one must be opened again. */
  private generation = 0;
  private readonly stt = new Map<string, SttWaiter>();
  /** Utterances cancelled before their decode went out (the sidecar was still starting): never sent. */
  private readonly cancelledUtterances = new Set<string>();
  private readonly tts = new Map<string, TtsWaiter>();
  private helloWaiter: { resolve(info: SidecarReady): void; reject(error: Error): void } | null = null;

  constructor(private readonly options: SidecarClientOptions) {
    this.timing = { ...DEFAULT_SIDECAR_TIMING, ...options.timing };
  }

  /** Readiness for `GET /api/voice/config`: no secret, a reason a person can act on. */
  status(): { available: boolean; reason?: string } {
    if (this.closed) return { available: false, reason: "the speech sidecar is shut down" };
    // Once the respawn hold has passed, the next use starts it again, so it is not unavailable any more.
    if (this.phase.kind === "unavailable" && this.respawnHoldMs() > 0) return { available: false, reason: this.phase.reason };
    return { available: true };
  }

  private respawnHoldMs(): number {
    return this.holdUntil - Date.now();
  }

  get voices(): string[] {
    return this.phase.kind === "ready" ? this.phase.info.voices : [];
  }

  get device(): "gpu" | "cpu" | null {
    return this.phase.kind === "ready" ? this.phase.info.device : null;
  }

  /** The sidecar, started if it is not running. Rejects while a recent failure holds the respawn off. */
  ensureReady(): Promise<SidecarReady> {
    if (this.closed) return Promise.reject(new SidecarUnavailableError("the speech sidecar is shut down"));
    if (this.phase.kind === "ready") return Promise.resolve(this.phase.info);
    if (this.phase.kind === "starting") return this.phase.ready;
    const wait = this.respawnHoldMs();
    if (wait > 0) {
      const reason = this.phase.kind === "unavailable" ? this.phase.reason : "the speech sidecar is restarting";
      return Promise.reject(new SidecarUnavailableError(`${reason} (retrying in ${Math.ceil(wait / 1000)} s)`));
    }
    this.phase = { kind: "stopped" };
    const ready = this.start();
    if (this.phase.kind === "stopped") this.phase = { kind: "starting", ready }; // start() may already have failed
    return ready;
  }

  private start(): Promise<SidecarReady> {
    this.lastSpawnAt = Date.now();
    return new Promise<SidecarReady>((resolve, reject) => {
      const timeout = setTimeout(() => this.crash("the speech sidecar did not answer hello in time"), this.timing.helloTimeoutMs);
      this.helloWaiter = {
        resolve: (info) => { clearTimeout(timeout); resolve(info); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      };
      try {
        this.attachChild(this.options.spawnProcess());
        this.write({ op: "hello", ...this.options.hello() });
      } catch (error) {
        this.crash(`the speech sidecar could not start: ${errorText(error)}`);
      }
    });
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    const decoder = new FrameDecoder();
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      // A process that has been replaced or told to stop may still have frames in flight; they belong to no one now.
      if (child !== this.child) return;
      try {
        for (const frame of decoder.push(chunk)) this.onFrame(frame);
      } catch (error) {
        if (error instanceof FramingError) this.crash(`the speech sidecar sent a bad frame: ${error.message}`);
        else throw error;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => logger.debug(`[voice-sidecar] ${chunk.toString("utf8").trimEnd()}`));
    child.stdin.on("error", () => undefined); // the exit handler reports it
    child.on("error", (error) => this.crash(`the speech sidecar could not run: ${error.message}`, child));
    child.on("exit", (code, signal) => this.crash(`the speech sidecar exited (${signal ?? `code ${code}`})`, child));
  }

  // ── leases: what keeps the sidecar warm and pinged ─────────────────────────

  /** Hold the sidecar for a use (an open VAD stream, an in-flight request). Returns the release. */
  lease(): () => void {
    this.leases += 1;
    this.stopIdleTimer();
    this.startPinging();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases -= 1;
      if (this.leases === 0) this.becomeIdle();
    };
  }

  private becomeIdle(): void {
    this.stopPinging();
    if (this.child === null || this.closed) return;
    this.idleTimer = setTimeout(() => this.reap(), this.timing.idleReapMs);
    this.idleTimer.unref();
  }

  private reap(): void {
    this.idleTimer = null;
    if (this.leases > 0) return;
    logger.debug("[voice-sidecar] idle, shutting it down");
    this.stopChild();
    this.phase = { kind: "stopped" };
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private startPinging(): void {
    if (this.pingTimer || this.child === null) return;
    this.pingTimer = setInterval(() => this.ping(), this.timing.pingEveryMs);
    this.pingTimer.unref();
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pingsOutstanding = 0;
  }

  private ping(): void {
    if (this.phase.kind !== "ready") return;
    if (this.pingsOutstanding >= this.timing.missedPongs) {
      this.crash(`the speech sidecar stopped answering (${this.pingsOutstanding} pings unanswered)`);
      return;
    }
    this.pingsOutstanding += 1;
    this.pingSeq += 1;
    this.write({ op: "ping", n: this.pingSeq });
  }

  // ── requests ───────────────────────────────────────────────────────────────

  /**
   * A VAD stream. Audio written while the sidecar is not ready is held (bounded), and a stream that
   * outlives a crash is opened again on the respawn, with its handlers, so it does not go quiet.
   * Event offsets are positions in everything written to this stream since it was opened, across respawns: the
   * sidecar's own offsets restart at 0 on each reopen, and are shifted by where that reopen began. Audio dropped from a
   * full queue still counts, as silence; audio the sidecar had taken before it died is not sent again.
   */
  vad(stream: string, params: VadParams): SidecarVad {
    const release = this.lease();
    const state: VadStreamState = { params, handlers: [], openedGeneration: -1, queue: [], dropped: 0, written: 0, baseBytes: 0, closed: false, warned: false };
    this.vadStreams.set(stream, state);
    const start = (): void => {
      void this.ensureReady().then(
        () => this.sendVad(stream, state),
        (error: unknown) => {
          if (state.warned) return;
          state.warned = true;
          logger.warn(`[voice-sidecar] VAD stream ${stream} is waiting for the sidecar: ${errorText(error)}`);
        },
      );
    };
    start();
    return {
      write: (pcm) => {
        if (state.closed) return;
        state.queue.push(pcm);
        state.written += pcm.length;
        if (state.queue.length > MAX_VAD_QUEUE) state.dropped += state.queue.shift()!.length;
        if (this.phase.kind === "ready") this.sendVad(stream, state);
        else if (this.phase.kind !== "starting") start();
      },
      on: (handler) => { state.handlers.push(handler); },
      close: () => {
        if (state.closed) return;
        state.closed = true;
        this.vadStreams.delete(stream);
        if (this.phase.kind === "ready" && state.openedGeneration === this.generation) this.write({ op: "vad.close", stream });
        release();
      },
    };
  }

  private sendVad(stream: string, state: VadStreamState): void {
    if (state.closed || this.phase.kind !== "ready") return;
    if (state.openedGeneration !== this.generation) {
      // This generation's VAD counts from its first byte: the dropped silence, then what is queued.
      state.baseBytes = vadStreamPosition(state);
      this.write({ op: "vad.open", stream, ...state.params });
      state.openedGeneration = this.generation;
      state.warned = false;
    }
    // Dropped audio goes as silence of the same length: the VAD's offsets are positions in everything written, and the
    // caller cuts utterances by them, so a gap would shift every later cut.
    for (; state.dropped > 0; state.dropped -= Math.min(state.dropped, MAX_FILLER_BYTES)) {
      this.write({ op: "vad.audio", stream }, Buffer.alloc(Math.min(state.dropped, MAX_FILLER_BYTES)));
    }
    for (const pcm of state.queue.splice(0)) this.write({ op: "vad.audio", stream }, pcm);
  }

  /** A transcript of the utterance so far (or the whole of it), or a rejection. */
  async transcribe(kind: "partial" | "final", ids: { stream: string; utterance: string }, pcm: Buffer): Promise<string> {
    const release = this.lease();
    try {
      await this.ensureReady();
      if (this.cancelledUtterances.has(ids.utterance)) throw new Error("cancelled");
      const key = `${ids.utterance}:${kind === "final"}`;
      const text = new Promise<string>((resolve, reject) => this.stt.set(key, { resolve, fail: reject }));
      this.write({ op: `stt.${kind}`, ...ids }, pcm);
      return await text.finally(() => this.stt.delete(key));
    } finally {
      release();
    }
  }

  /** Cancel an utterance's decodes: the sidecar sends nothing more for it, and waiting callers are failed. */
  cancelUtterance(utterance: string): void {
    this.cancelledUtterances.add(utterance);
    if (this.cancelledUtterances.size > 1024) this.cancelledUtterances.delete(this.cancelledUtterances.values().next().value as string);
    this.cancel(utterance);
    for (const kind of [false, true]) this.stt.get(`${utterance}:${kind}`)?.fail(new Error("cancelled"));
  }

  /** One sentence of speech as 24 kHz PCM chunks. Aborting cancels it in the sidecar and ends the iterator. */
  async *synthesize(id: string, request: { text: string; voice: string; speed: number; lang: string }, signal: AbortSignal): AsyncGenerator<TtsChunk> {
    const release = this.lease();
    const inbox = new TtsInbox();
    const requestedAt = Date.now();
    const short = id.slice(0, 8);
    let aborted = false;
    const onAbort = (): void => { aborted = true; this.cancel(id); inbox.finish(); };
    try {
      try {
        await raceAbort(this.ensureReady(), signal); // an abort while the sidecar is still starting ends it now
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      this.tts.set(id, inbox);
      signal.addEventListener("abort", onAbort, { once: true });
      this.write({ op: "tts", id, ...request });
      traceDebug("sidecar_tts_request", () => ({ id: short, chars: request.text.length, voice: request.voice, speed: request.speed, lang: request.lang, ready_ms: Date.now() - requestedAt }));
      yield* inbox.drain();
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.tts.delete(id) && !inbox.ended) this.cancel(id);
      release();
      this.traceTtsEnd(inbox, { id: short, chars: request.text.length, requestedAt, aborted });
    }
  }

  /** One summary line per synthesis request, written after the request's cleanup so it can never get in its way. */
  private traceTtsEnd(inbox: TtsInbox, request: { id: string; chars: number; requestedAt: number; aborted: boolean }): void {
    const stats = inbox.stats();
    const fields = {
      id: request.id, chars: request.chars, chunks: stats.chunks, bytes: stats.bytes, rates: stats.rates.join(","), odd_chunks: stats.oddChunks,
      ttfb_ms: stats.firstAt === null ? undefined : stats.firstAt - request.requestedAt, total_ms: Date.now() - request.requestedAt, completed: inbox.ended && !request.aborted,
    };
    if (stats.rates.some((rate) => rate !== 24_000)) logger.warn(traceLine("sidecar_tts_rate_unexpected", { ...fields, expected: 24_000 }));
    if (request.aborted) logger.info(traceLine("sidecar_tts_aborted", fields));
    else if (stats.chunks === 0) logger.warn(traceLine("sidecar_tts_no_audio", fields));
    else traceDebug("sidecar_tts_done", () => fields);
  }

  /** Tell the sidecar to drop a `tts` id or an utterance. */
  cancel(id: string): void {
    if (this.phase.kind === "ready") this.write({ op: "cancel", id });
  }

  // ── replies ────────────────────────────────────────────────────────────────

  private onFrame({ header, body }: SidecarFrame): void {
    switch (header.op) {
      case "ready": return this.onReady(header);
      case "pong": this.pingsOutstanding = 0; return;
      case "vad.event": return this.onVadEvent(header);
      case "stt.text": return this.onSttText(header);
      case "tts.audio": return this.onTtsAudio(header, body);
      case "tts.done": this.tts.get(String(header.id))?.finish(); return;
      case "error": return this.onError(header);
      default: logger.debug(`[voice-sidecar] ignoring frame ${String(header.op)}`);
    }
  }

  private onTtsAudio(header: SidecarFrame["header"], body: Buffer): void {
    const waiter = this.tts.get(String(header.id));
    if (!waiter) traceDebug("sidecar_tts_audio_unclaimed", () => ({ id: String(header.id).slice(0, 8), bytes: body.length }));
    waiter?.push({ pcm: body, sampleRate: Number(header.sampleRate) });
  }

  private onReady(header: SidecarFrame["header"]): void {
    const info: SidecarReady = {
      device: header.device === "gpu" ? "gpu" : "cpu",
      voices: Array.isArray(header.voices) ? header.voices.map(String) : [],
      sttPartials: header.sttPartials !== false,
    };
    this.generation += 1;
    this.phase = { kind: "ready", info };
    this.helloWaiter?.resolve(info);
    this.helloWaiter = null;
    if (this.leases > 0) this.startPinging();
  }

  private onVadEvent(header: SidecarFrame["header"]): void {
    const state = this.vadStreams.get(String(header.stream));
    if (!state) return;
    // The sidecar counts from the first byte of the generation that sent this; the caller counts from the stream's first.
    const atMs = state.baseBytes / VAD_BYTES_PER_MS + Number(header.atMs);
    const speechMs = header.kind === "end" && typeof header.speechMs === "number" ? header.speechMs : undefined;
    const event = { kind: header.kind === "end" ? ("end" as const) : ("start" as const), atMs, ...(speechMs === undefined ? {} : { speechMs }) };
    for (const handler of state.handlers) handler(event);
  }

  private onSttText(header: SidecarFrame["header"]): void {
    this.stt.get(`${String(header.utterance)}:${header.final === true}`)?.resolve(String(header.text ?? ""));
  }

  private onError(header: SidecarFrame["header"]): void {
    const message = String(header.message ?? "error");
    const ref = String(header.ref);
    if (ref === "hello") return this.crash(message);
    const error = new Error(message);
    this.tts.get(ref)?.fail(error);
    // An STT error names the kind of decode that failed when the sidecar says so: a failed partial leaves the final alone.
    const kinds = typeof header.final === "boolean" ? [header.final] : [false, true];
    for (const kind of kinds) this.stt.get(`${ref}:${kind}`)?.fail(error);
    logger.warn(`[voice-sidecar] ${ref}: ${message}`);
  }

  // ── failure and shutdown ───────────────────────────────────────────────────

  /** The sidecar is gone or broken: fail what is in flight and stay down until the next need. */
  private crash(reason: string, source?: ChildProcessWithoutNullStreams): void {
    if (source && source !== this.child) return; // an old process's late exit
    logger.warn(`[voice-sidecar] ${reason}`);
    this.stopChild();
    this.stopPinging();
    this.stopIdleTimer();
    this.phase = { kind: "unavailable", reason };
    this.holdUntil = this.lastSpawnAt + this.timing.respawnMinMs;
    const error = new SidecarUnavailableError(reason);
    this.helloWaiter?.reject(error);
    this.helloWaiter = null;
    for (const waiter of [...this.stt.values(), ...this.tts.values()]) waiter.fail(error);
    this.stt.clear();
    this.tts.clear();
    if (!this.closed) this.resetVadStreams();
  }

  /**
   * Tell each VAD stream that was open under the process that just died that its detector is gone, at the byte the next
   * process will count from (the first one not yet sent: what the dead one took is lost with it).
   */
  private resetVadStreams(): void {
    for (const state of this.vadStreams.values()) {
      if (state.openedGeneration !== this.generation) continue;
      state.openedGeneration = -1; // a second crash before the next open has nothing more to report
      const event = { kind: "reset" as const, atMs: vadStreamPosition(state) / VAD_BYTES_PER_MS };
      for (const handler of state.handlers) handler(event);
    }
  }

  private write(header: Record<string, unknown>, body?: Buffer): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(encodeFrame(header, body));
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    const kill = setTimeout(() => child.kill("SIGKILL"), this.timing.killGraceMs);
    kill.unref();
    child.once("exit", () => clearTimeout(kill));
  }

  /** Gateway shutdown: the process is killed at once. */
  close(): void {
    this.closed = true;
    const child = this.child;
    this.crash("the speech sidecar is shut down");
    child?.kill("SIGKILL");
  }
}

/** The chunks of one `tts` request, handed from the reply handler to the consuming generator. */
class TtsInbox implements TtsWaiter {
  private chunks: TtsChunk[] = [];
  private error: Error | null = null;
  private done = false;
  private wake: (() => void) | null = null;

  get ended(): boolean {
    return this.done;
  }

  /** Diagnostics only: what arrived, whether or not the consumer has taken it yet. */
  private received = { chunks: 0, bytes: 0, oddChunks: 0, firstAt: null as number | null, rates: new Set<number>() };

  stats(): { chunks: number; bytes: number; oddChunks: number; firstAt: number | null; rates: number[] } {
    return { ...this.received, rates: [...this.received.rates] };
  }

  push(chunk: TtsChunk): void {
    if (this.done) return;
    this.received.chunks += 1;
    this.received.bytes += chunk.pcm.length;
    if (chunk.pcm.length % 2 !== 0) this.received.oddChunks += 1;
    this.received.firstAt ??= Date.now();
    this.received.rates.add(chunk.sampleRate);
    this.chunks.push(chunk);
    this.notify();
  }

  finish(): void {
    this.done = true;
    this.notify();
  }

  fail(error: Error): void {
    this.error = error;
    this.done = true;
    this.notify();
  }

  async *drain(): AsyncGenerator<TtsChunk> {
    for (;;) {
      const chunk = this.chunks.shift();
      if (chunk) {
        yield chunk;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
