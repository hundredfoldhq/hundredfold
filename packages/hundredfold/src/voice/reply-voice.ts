/**
 * An attachment's replies, spoken: session events in, speech frames and turn
 * state out. Owns the speech pipeline, the time-to-first-audio of an exchange
 * (FR-007), what each reply's stored message learns about being heard
 * (`meta.voice`), and what to say about replies that finished while the client
 * was suspended (FR-033).
 */
import type { JsonObject } from "../shared/types.js";
import type { VoiceServerFrame, VoiceTurnState } from "../shared/gateway-events.js";
import type { StoredReply, VoiceClock, VoiceHubDeps } from "./hub-types.js";
import { SpeechPipeline, type CutResult, type PipelineOptions, type Segment } from "./speech-pipeline.js";
import { silentTracer, type Tracer } from "./trace.js";

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
  /** For replies the engine wrote on its own: the stored messages this one speaks, in order. */
  rows?: StoredReply[];
  /** A cut of this pass was answered with words: what was heard is recorded, and nothing more is. */
  closed?: boolean;
}

/** How many recent spoken passes of such replies are remembered, for the barge-in that cuts one. */
const RETAINED_PASSES = 8;

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
  deps: Pick<VoiceHubDeps, "mergeMessageMeta" | "findReplyMessageId" | "externalRepliesSince" | "log"> & { clock: VoiceClock };
  /** Diagnostic lines for this conversation; absent: nothing is logged. */
  trace?: Tracer;
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
  /** Replies the engine wrote on its own count from when the attachment began; those it has dealt with are remembered. */
  private readonly attachedAt: number;
  private readonly dealtWith = new Set<string>();
  private readonly passes: Reply[] = [];
  /** The last barge-in cut, for the words or silence that follow it. */
  private lastCut: CutResult | null = null;

  private readonly trace: Tracer;

  constructor(private readonly options: ReplyVoiceOptions) {
    this.trace = options.trace ?? silentTracer;
    this.attachedAt = options.deps.clock.now();
    this.pipeline = new SpeechPipeline({
      ...options.pipeline,
      trace: this.trace,
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
    this.lastCut = result;
    this.pipeline.hold();
    this.emitTurn();
    return result;
  }

  /** Nothing was said: carry on from the first sentence not heard. */
  resumePlayback(unheard: readonly string[]): void {
    const cut = this.lastCut;
    this.lastCut = null;
    const pass = cut?.replyKey === undefined ? undefined : this.passes.find((p) => p.id === cut.replyKey);
    if (cut && pass) {
      // The sentences go on as the stored messages they came from, whatever reply is streaming now.
      this.pipeline.markReply(pass.id);
      this.pipeline.resumeWith(unheard, cut.unheardIds);
      if (this.reply) this.pipeline.markReply(this.reply.id);
      void this.pipeline.whenIdle().then(() => this.applyPassMeta(pass)).catch((error: unknown) => this.logMetaFailure(error));
    } else {
      this.resumeStreamed(cut, unheard);
    }
    this.pipeline.release();
  }

  /** A streamed reply's sentences go on as its own; one that had already finished is told once they are spoken. */
  private resumeStreamed(cut: CutResult | null, unheard: readonly string[]): void {
    if (cut?.replyKey !== undefined) this.pipeline.markReply(cut.replyKey);
    this.pipeline.resumeWith(unheard);
    if (this.reply) this.pipeline.markReply(this.reply.id);
    const finished = cut?.replyKey !== undefined && this.last?.id === cut.replyKey ? this.last : undefined;
    if (finished) void this.pipeline.whenIdle().then(() => this.safeApplyMeta(finished));
  }

  /** Words were said: the new turn brings its own reply. */
  abandonHeld(heard: string): void {
    const cut = this.lastCut;
    this.lastCut = null;
    this.dropOtherReplies(cut);
    const pass = cut && cut.heard === heard && cut.replyKey !== undefined ? this.passes.find((p) => p.id === cut.replyKey) : undefined;
    if (cut && pass) return this.recordPassHeard(cut, pass);
    const reply = this.reply ?? this.last;
    if (!reply) return;
    reply.heard = heard;
    // A reply still being written has no stored message of its own yet: it is told when its turn ends.
    if (reply === this.reply) this.pendingMeta = reply;
    else this.safeApplyMeta(reply);
  }

  /**
   * Words were said, so the sentences of every reply but the cut one are dropped. A report that became a pass of its
   * own while the cut was held has only queued sentences, so it was not heard at all; replies the cut caught
   * mid-speech were not said either: each records only what of it was heard.
   */
  private dropOtherReplies(cut: CutResult | null): void {
    const dropped = this.passes.filter((p) => !p.closed && p.id !== cut?.replyKey && this.pipeline.hasUnplayedFor(p.id));
    this.pipeline.discardQueued();
    this.pipeline.release();
    for (const pass of dropped) this.recordNothingHeard(pass);
    for (const other of cut?.others ?? []) this.recordCut(other);
  }

  markPlayed(segmentId: number): void {
    this.pipeline.markPlayed(segmentId);
    this.emitTurn();
  }

  // ── session events ─────────────────────────────────────────────────────────

  onStarted(): void {
    this.trace.info("turn_started", { suppressed_before: this.suppress, unplayed: this.pipeline.hasUnplayedReply(), held: this.pipeline.isHeld(), suspended: this.suspended });
    this.jumpToNewText();
    this.suppress = false;
    this.reply = this.newReply();
    if (this.exchange) this.exchange.turnStarted = true;
    this.engineTurn = "thinking";
    this.tool = undefined;
    this.emitTurn();
  }

  /**
   * A new reply is about to be spoken: whatever is still queued, being made or playing belongs to an older reply, so
   * it stops now and speech starts on the new text. A cut waiting for the words that follow it (a barge-in) and a
   * holding line on its own are left alone.
   */
  private jumpToNewText(): void {
    if (this.suspended || this.pipeline.isHeld() || !this.pipeline.hasUnplayedReply()) return;
    const cut = this.pipeline.cut(null, 0);
    this.trace.info("reply_superseded", { heard_chars: cut.heard.length, unheard_sentences: cut.unheard.length, old_reply: cut.replyKey });
    this.options.send({ type: "stop_playback", reason: "new_reply" });
    this.recordCut(cut);
    for (const other of cut.others ?? []) this.recordCut(other);
  }

  /** The streamed reply a cut belongs to, when it is the one still streaming or the last that finished. */
  private replyOf(cut: CutResult): Reply | undefined {
    return [this.reply, this.last].find((r) => r !== null && r.id === cut.replyKey) ?? undefined;
  }

  /** A cut reply's stored message(s) learn what was heard of it. */
  private recordCut(cut: CutResult): void {
    const pass = cut.replyKey === undefined ? undefined : this.passes.find((p) => p.id === cut.replyKey);
    if (pass) return this.recordPassHeard(cut, pass);
    const reply = this.replyOf(cut);
    if (!reply) return;
    reply.heard = cut.heard;
    if (reply === this.reply) this.pendingMeta = reply;
    else this.safeApplyMeta(reply);
  }

  /** A text delta, or a snapshot that reconciles the reply so far. */
  onText(content: string, snapshot: boolean): void {
    if (this.suppress) {
      if (content) this.trace.debug("reply_text_suppressed", () => ({ chars: content.length, snapshot }));
      return;
    }
    if (!content) return;
    const reply = this.reply ?? (this.reply = this.newReply());
    const fresh = snapshot ? snapshotRemainder(reply.text, content) : content;
    if (snapshot && !fresh) this.traceIgnoredSnapshot(reply, content);
    if (!fresh) return;
    reply.text += fresh;
    this.trace.debug("reply_text", () => ({ reply: reply.id, chars: fresh.length, total_chars: reply.text.length, snapshot, spoken_live: !this.suspended }));
    if (!this.suspended) this.pipeline.feed(fresh);
  }

  /**
   * A snapshot that does not extend what was streamed adds nothing, so a reply the engine settled differently is spoken
   * as it streamed: the mismatch is the thing to look for when speech and text disagree. A snapshot that is the tail of
   * what streamed is not a mismatch: an engine that settles a turn on its last text block (text, tool, text) or trims
   * the trailing whitespace off it says so on every ordinary turn.
   */
  private traceIgnoredSnapshot(reply: Reply, snapshot: string): void {
    if (isTailOf(reply.text, snapshot)) return;
    this.trace.warn("reply_snapshot_ignored", { reply: reply.id, fed_chars: reply.text.length, snapshot_chars: snapshot.length, common_prefix: commonPrefix(reply.text, snapshot) });
  }

  onToolUse(name: string | undefined): void {
    if (this.suppress) return;
    // A tool call ends the text block before it: its last sentence is spoken now, not held until the text after
    // the call (or the turn's end) shows where it stops, and the text after is a sentence of its own.
    if (!this.suspended) this.pipeline.endReply();
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

  /**
   * The turn ended, completed or cut off. `result` is the reply as the engine settled it: a turn that streamed
   * nothing (an engine that answers all at once) is spoken from it, and one that streamed it already adds nothing,
   * as for a snapshot.
   */
  onTurnEnded(flush: boolean, result: string): void {
    this.trace.info("turn_ended", {
      flush, result_chars: result.length, reply: this.reply?.id, fed_chars: this.reply?.text.length, suppressed: this.suppress, suspended: this.suspended,
      unplayed: this.pipeline.hasUnplayed(),
    });
    this.onText(result, true);
    const cutOff = this.pendingMeta;
    this.pendingMeta = null;
    if (cutOff && cutOff !== this.reply) this.safeApplyMeta(cutOff);
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
    // The exchange is over once what it will say has gone out, not when the model finishes: an engine that answers
    // all at once ends its turn before the first sentence has been made.
    const exchange = this.exchange;
    if (this.suspended) return;
    void this.pipeline.whenIdle().then(() => this.closeExchange(exchange));
  }

  /**
   * The transcript sync stored something. Replies the engine wrote on its own (the CLI reporting finished
   * background work is not a gateway turn, so no delta ever streamed it) are spoken here, from the store. Only the
   * sync's own rows count, so a gateway turn's replies are never spoken twice, and a sync that only upgrades rows
   * (or stored nothing new) says nothing.
   */
  onExternalTurn(): void {
    const { deps, sessionId } = this.options;
    try {
      this.speakExternal(deps.externalRepliesSince(sessionId, this.attachedAt));
    } catch (error) {
      deps.log.warn(`voice: could not read the engine's own reply for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    this.trace.info("reply_start", { reply: reply.id, exchange: this.exchange?.utteranceId });
    this.pipeline.markReply(reply.id);
    return reply;
  }

  private finishReply(reply: Reply, flush: boolean): void {
    if (this.suspended) {
      this.trace.info("reply_missed", { reply: reply.id, chars: reply.text.length });
      this.missed.push({ messageId: this.resolveMessage(reply), text: reply.text });
      return;
    }
    if (flush) this.pipeline.endReply();
    this.last = reply;
    this.trace.info("reply_finished", { reply: reply.id, chars: reply.text.length, flush, duration_ms: this.options.deps.clock.now() - reply.startedAt });
    // Pin the stored message now, while it is the newest: a later reply must not be taken for it.
    this.resolveMessage(reply);
    void this.pipeline.whenIdle().then(() => this.applyMeta(reply)).catch((error: unknown) => this.logMetaFailure(error));
  }

  private resolveMessage(reply: Reply): string | undefined {
    if (reply.messageId === undefined) reply.messageId = this.options.deps.findReplyMessageId(this.options.sessionId, reply.startedAt);
    return reply.messageId;
  }

  /**
   * Speak replies the engine wrote on its own, as one reply of their own: cut, resumed and recorded like the rest,
   * whatever gateway reply is streaming meanwhile. While the client is away they are collected as missed.
   */
  private speakExternal(rows: StoredReply[]): void {
    const fresh = rows.filter((row) => !this.dealtWith.has(row.id));
    for (const row of fresh) this.dealtWith.add(row.id);
    const speakable = fresh.filter((row) => row.content.trim());
    this.trace.info("external_reply", { rows: rows.length, fresh: fresh.length, speakable: speakable.length, chars: speakable.reduce((n, row) => n + row.content.length, 0), suspended: this.suspended });
    if (speakable.length === 0) return;
    if (this.suspended) {
      for (const row of speakable) this.missed.push({ messageId: row.id, text: row.content });
      return;
    }
    // The engine's own report is a new reply too, unless a pass is still being spoken (a burst of reports is one reply)
    // or a gateway reply is mid-stream (the two interleave by design).
    if (!this.reply && !this.livePass()) this.jumpToNewText();
    const pass = this.passToSpeakIn();
    pass.rows = [...(pass.rows ?? []), ...speakable];
    for (const row of speakable) this.pipeline.speakText(row.content, row.id);
    // A gateway reply still streaming keeps its own sentences.
    if (this.reply) this.pipeline.markReply(this.reply.id);
    void this.pipeline.whenIdle().then(() => this.applyPassMeta(pass)).catch((error: unknown) => this.logMetaFailure(error));
  }

  /** The pass a report is spoken in, marked as the reply the pipeline's next sentences belong to: the live one, else a new one. */
  private passToSpeakIn(): Reply {
    const live = this.livePass();
    if (live) {
      this.pipeline.markReply(live.id);
      return live;
    }
    const pass = this.newReply();
    this.passes.push(pass);
    if (this.passes.length > RETAINED_PASSES) this.passes.shift();
    return pass;
  }

  /**
   * The pass being spoken, or stopped by a barge-in that has not yet been answered: a report arriving then is part of
   * it, one reply for the person talking over it, rather than a reply of its own that the same cut would drop unspoken.
   */
  private livePass(): Reply | undefined {
    const pass = this.passes[this.passes.length - 1];
    if (!pass || pass.closed) return undefined;
    const stopped = this.lastCut?.replyKey === pass.id && this.pipeline.isHeld();
    return stopped || this.pipeline.hasUnplayedFor(pass.id) ? pass : undefined;
  }

  /** Each stored message of a spoken pass learns what of it went out. */
  private applyPassMeta(pass: Reply): void {
    if (pass.closed) return;
    for (const row of pass.rows ?? []) {
      const spoken = this.pipeline.spokenFor(pass.id, row.id);
      if (spoken) this.options.deps.mergeMessageMeta(row.id, { voice: { spokenText: spoken } });
    }
  }

  /**
   * A cut pass: the message the cut fell in keeps what was heard, the ones before it were heard whole, the ones after
   * not at all, nor any that joined the pass after the cut.
   */
  private recordPassHeard(cut: CutResult, pass: Reply): void {
    pass.closed = true;
    try {
      const recorded = new Set<string>();
      for (const part of cut.heardBy) {
        if (!part.messageId) continue;
        recorded.add(part.messageId);
        this.options.deps.mergeMessageMeta(part.messageId, { voice: { spokenText: part.text || null, interrupted: part.complete ? null : true } });
      }
      for (const row of pass.rows ?? []) {
        if (!recorded.has(row.id)) this.options.deps.mergeMessageMeta(row.id, { voice: { spokenText: null, interrupted: true } });
      }
    } catch (error) {
      this.logMetaFailure(error);
    }
  }

  /** A pass whose sentences were dropped before any was said: each of its stored messages records that nothing was heard. */
  private recordNothingHeard(pass: Reply): void {
    pass.closed = true;
    try {
      for (const row of pass.rows ?? []) this.options.deps.mergeMessageMeta(row.id, { voice: { spokenText: null, interrupted: true } });
    } catch (error) {
      this.logMetaFailure(error);
    }
  }

  private safeApplyMeta(reply: Reply): void {
    try {
      this.applyMeta(reply);
    } catch (error) {
      this.logMetaFailure(error);
    }
  }

  private logMetaFailure(error: unknown): void {
    this.options.deps.log.warn(`voice: could not record what was heard for ${this.options.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** What the stored message learns: all of it spoken, or what was heard when cut off. */
  private applyMeta(reply: Reply): void {
    const id = this.resolveMessage(reply);
    this.trace.info("reply_spoken", {
      reply: reply.id, message: id, fed_chars: reply.text.length, spoken_chars: this.spokenOf(reply).length, interrupted: reply.heard !== undefined,
      heard_chars: reply.heard?.length, ttfa_ms: reply.ttfaMs,
    });
    if (!id) return;
    const voice: JsonObject = {};
    // A cut-off reply keeps exactly what was heard, including nothing: the turn-end merge may already have stored every sentence sent.
    if (reply.heard !== undefined) {
      voice.spokenText = reply.heard;
      voice.interrupted = true;
    } else {
      const spoken = this.spokenOf(reply);
      if (spoken) voice.spokenText = spoken;
    }
    if (reply.ttfaMs !== undefined) voice.ttfaMs = reply.ttfaMs;
    if (Object.keys(voice).length > 0) this.options.deps.mergeMessageMeta(id, { voice });
  }

  private spokenOf(reply: Reply): string {
    return this.pipeline.spokenFor(reply.id);
  }

  private onAudio(segment: Segment): void {
    const exchange = this.exchange;
    // A stored message read aloud (the engine's own report, a missed reply) is not what the exchange was waiting for.
    if (!exchange || exchange.metricsSent || segment.holding || segment.messageId !== undefined || !exchange.turnStarted) {
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
  private closeExchange(exchange: Exchange | null): void {
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
    // A holding line spoken while long work runs leaves the turn `working`: it is not the reply.
    const state: VoiceTurnState = this.pipeline.hasUnplayedReply() ? "speaking" : this.engineTurn;
    const key = `${state}:${state === "working" ? (this.tool ?? "") : ""}`;
    if (key === this.lastTurnSent || this.suspended) return;
    this.lastTurnSent = key;
    this.options.send({ type: "turn", state, ...(state === "working" && this.tool ? { tool: this.tool } : {}) });
  }
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let at = 0;
  while (at < limit && a.charCodeAt(at) === b.charCodeAt(at)) at += 1;
  return at;
}

/** Whether `snapshot`, whitespace trimmed, is how `fed` ends: the whole of it, or its last block. */
export function isTailOf(fed: string, snapshot: string): boolean {
  return fed.trimEnd().endsWith(snapshot.trim());
}

/** The part of a snapshot not already fed, or "" when the snapshot only repeats what was. */
export function snapshotRemainder(fed: string, snapshot: string): string {
  return snapshot.length > fed.length && snapshot.startsWith(fed) ? snapshot.slice(fed.length) : "";
}
