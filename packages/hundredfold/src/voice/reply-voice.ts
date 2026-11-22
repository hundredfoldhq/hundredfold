/**
 * An attachment's replies, spoken: session events in, speech frames and turn
 * state out. Owns the speech pipeline, the time-to-first-audio of an exchange
 * (FR-007), what each reply's stored message learns about being heard
 * (`meta.voice`), and what to say about replies that finished while the client
 * was suspended (FR-033).
 */
import type { JsonObject } from "../shared/types.js";
import type { VoiceServerFrame, VoiceTurnState } from "../shared/gateway-events.js";
import type { VoiceClock, VoiceHubDeps } from "./hub-types.js";
import { SpeechPipeline, type CutResult, type PipelineOptions, type Segment } from "./speech-pipeline.js";

/** One assistant reply as the hub follows it. */
interface Reply {
  id: number;
  startedAt: number;
  /** Raw text fed so far, for snapshot reconciliation and for a reply the client missed. */
  text: string;
  messageId: string | undefined;
  ttfaMs: number | undefined;
  /** What the user heard before cutting this reply off, once known. */
  heard: string | undefined;
}

/** The exchange whose time to first audio is being measured. */
interface Exchange {
  utteranceId: string;
  sttMs: number;
  finalAt: number;
  /** The turn that will answer it has begun (a steered one is the running turn). */
  turnStarted: boolean;
  metricsSent: boolean;
}

export interface ReplyVoiceOptions {
  sessionId: string;
  pipeline: Pick<PipelineOptions, "tts" | "voice" | "speed" | "language">;
  /** Sends a frame to the client; frames while suspended are dropped by the caller. */
  send(frame: VoiceServerFrame): void;
  sendAudio(frame: Buffer): void;
  deps: Pick<VoiceHubDeps, "mergeMessageMeta" | "findReplyMessageId" | "log"> & { clock: VoiceClock };
}

/** A reply that finished while the client was away. */
export interface MissedReply {
  messageId: string | undefined;
  text: string;
}

export class ReplyVoice {
  readonly pipeline: SpeechPipeline;
  private reply: Reply | null = null;
  private last: Reply | null = null;
  private exchange: Exchange | null = null;
  private engineTurn: "idle" | "thinking" | "working" = "idle";
  private tool: string | undefined;
  private lastTurnSent = "";
  private suppress = false;
  private suspended = false;
  private readonly missed: MissedReply[] = [];
  private ttsFailedFor: Exchange | null = null;
  private nextReplyId = 1;
  /** A reply the user cut off, whose stored message is told what was heard once it exists. */
  private pendingMeta: Reply | null = null;

  constructor(private readonly options: ReplyVoiceOptions) {
    this.pipeline = new SpeechPipeline({
      ...options.pipeline,
      sink: { json: (frame) => options.send(frame), audio: (frame) => options.sendAudio(frame) },
      onAudio: (segment) => this.onAudio(segment),
      onSynthesisError: (error) => this.onSynthesisError(error),
    });
  }

  // ── what the dispatcher tells it ───────────────────────────────────────────

  /** A final went to the session; measure the first audio of what answers it. */
  expect(exchange: { utteranceId: string; sttMs: number; joinsRunningTurn: boolean }): void {
    this.exchange = {
      utteranceId: exchange.utteranceId, sttMs: exchange.sttMs, finalAt: this.options.deps.clock.now(),
      turnStarted: exchange.joinsRunningTurn, metricsSent: false,
    };
  }

  /** The running turn's remaining text is the old thread: do not speak it. */
  suppressUntilBoundary(): void {
    this.suppress = true;
    this.reply = null;
  }

  speakHolding(line: string): void {
    this.pipeline.speakLine(line);
  }

  // ── barge-in ───────────────────────────────────────────────────────────────

  /** Whether the assistant's voice is being made or heard. */
  speaking(): boolean {
    return this.pipeline.hasUnplayed();
  }

  /** Stop speaking and keep what was not heard; returns what was. */
  cutPlayback(segmentId: number | null, playedMs: number): CutResult {
    const result = this.pipeline.cut(segmentId, playedMs);
    this.pipeline.hold();
    this.emitTurn();
    return result;
  }

  /** Nothing was said: carry on from the first sentence not heard. */
  resumePlayback(unheard: readonly string[]): void {
    this.pipeline.resumeWith(unheard);
    this.pipeline.release();
  }

  /** Words were said: the new turn brings its own reply. */
  abandonHeld(heard: string): void {
    this.pipeline.discardQueued();
    this.pipeline.release();
    const reply = this.reply ?? this.last;
    if (!reply) return;
    reply.heard = heard;
    // A reply still being written has no stored message of its own yet: it is told when its turn ends.
    if (reply === this.reply) this.pendingMeta = reply;
    else this.applyMeta(reply);
  }

  markPlayed(segmentId: number): void {
    this.pipeline.markPlayed(segmentId);
    this.emitTurn();
  }

  // ── session events ─────────────────────────────────────────────────────────

  onStarted(): void {
    this.suppress = false;
    this.reply = this.newReply();
    if (this.exchange) this.exchange.turnStarted = true;
    this.engineTurn = "thinking";
    this.tool = undefined;
    this.emitTurn();
  }

  /** A text delta, or a snapshot that reconciles the reply so far. */
  onText(content: string, snapshot: boolean): void {
    if (this.suppress || !content) return;
    const reply = this.reply ?? (this.reply = this.newReply());
    const fresh = snapshot ? snapshotRemainder(reply.text, content) : content;
    if (!fresh) return;
    reply.text += fresh;
    if (!this.suspended) this.pipeline.feed(fresh);
  }

  onToolUse(name: string | undefined): void {
    if (this.suppress) return;
    this.engineTurn = "working";
    this.tool = name;
    this.emitTurn();
  }

  onToolResult(): void {
    if (this.suppress) return;
    this.engineTurn = "thinking";
    this.tool = undefined;
    this.emitTurn();
  }

  /** The turn ended, completed or cut off. */
  onTurnEnded(flush: boolean): void {
    const cutOff = this.pendingMeta;
    this.pendingMeta = null;
    if (cutOff && cutOff !== this.reply) this.applyMeta(cutOff);
    if (this.suppress) {
      this.suppress = false;
      this.reply = null;
      return;
    }
    const reply = this.reply;
    this.reply = null;
    this.engineTurn = "idle";
    this.tool = undefined;
    if (reply) this.finishReply(reply, flush);
    this.emitTurn();
    this.closeExchange();
  }

  // ── suspension ─────────────────────────────────────────────────────────────

  /** The client is gone: collect replies instead of speaking them. */
  suspend(): void {
    this.suspended = true;
    this.pipeline.cut(null, 0);
    this.pipeline.hold();
  }

  /** The client reconnected: replies are spoken live again. */
  unsuspend(): void {
    this.suspended = false;
    this.lastTurnSent = "";
    this.pipeline.release();
  }

  /** What finished while the client was away, to announce and speak. */
  takeMissed(): MissedReply[] {
    return this.missed.splice(0);
  }

  close(): void {
    this.pipeline.close();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private newReply(): Reply {
    const reply: Reply = { id: this.nextReplyId++, startedAt: this.options.deps.clock.now(), text: "", messageId: undefined, ttfaMs: undefined, heard: undefined };
    this.pipeline.markReply(reply.id);
    return reply;
  }

  private finishReply(reply: Reply, flush: boolean): void {
    if (this.suspended) {
      this.missed.push({ messageId: this.resolveMessage(reply), text: reply.text });
      return;
    }
    if (flush) this.pipeline.endReply();
    this.last = reply;
    void this.pipeline.whenIdle().then(() => this.applyMeta(reply));
  }

  private resolveMessage(reply: Reply): string | undefined {
    reply.messageId ??= this.options.deps.findReplyMessageId(this.options.sessionId, reply.startedAt);
    return reply.messageId;
  }

  /** What the stored message learns: all of it spoken, or what was heard when cut off. */
  private applyMeta(reply: Reply): void {
    const id = this.resolveMessage(reply);
    if (!id) return;
    const voice: JsonObject = {};
    const spoken = reply.heard ?? this.spokenOf(reply);
    if (spoken) voice.spokenText = spoken;
    if (reply.heard !== undefined) voice.interrupted = true;
    if (reply.ttfaMs !== undefined) voice.ttfaMs = reply.ttfaMs;
    if (Object.keys(voice).length > 0) this.options.deps.mergeMessageMeta(id, { voice });
  }

  private spokenOf(reply: Reply): string {
    return this.pipeline.spokenFor(reply.id);
  }

  private onAudio(segment: Segment): void {
    const exchange = this.exchange;
    if (!exchange || exchange.metricsSent || segment.holding || !exchange.turnStarted) {
      this.emitTurn();
      return;
    }
    exchange.metricsSent = true;
    const ttfaMs = Math.max(0, this.options.deps.clock.now() - exchange.finalAt);
    const reply = this.reply ?? this.last;
    if (reply) reply.ttfaMs = ttfaMs;
    this.options.send({ type: "metrics", utteranceId: exchange.utteranceId, sttMs: exchange.sttMs, ttfaMs });
    this.emitTurn();
  }

  /** An exchange whose turn ended with nothing spoken still reports its stt time. */
  private closeExchange(): void {
    const exchange = this.exchange;
    if (!exchange || !exchange.turnStarted || exchange.metricsSent) return;
    exchange.metricsSent = true;
    this.options.send({ type: "metrics", utteranceId: exchange.utteranceId, sttMs: exchange.sttMs, ttfaMs: null });
  }

  private onSynthesisError(error: unknown): void {
    this.options.deps.log.warn(`voice: synthesis failed for ${this.options.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    if (this.ttsFailedFor === this.exchange && this.exchange) return;
    this.ttsFailedFor = this.exchange;
    this.options.send({ type: "error", code: "tts_failed", message: "Speech failed for this reply; it is still shown as text." });
  }

  private emitTurn(): void {
    const state: VoiceTurnState = this.pipeline.hasUnplayed() ? "speaking" : this.engineTurn;
    const key = `${state}:${state === "working" ? (this.tool ?? "") : ""}`;
    if (key === this.lastTurnSent || this.suspended) return;
    this.lastTurnSent = key;
    this.options.send({ type: "turn", state, ...(state === "working" && this.tool ? { tool: this.tool } : {}) });
  }
}

/** The part of a snapshot not already fed, or "" when the snapshot only repeats what was. */
export function snapshotRemainder(fed: string, snapshot: string): string {
  return snapshot.length > fed.length && snapshot.startsWith(fed) ? snapshot.slice(fed.length) : "";
}
