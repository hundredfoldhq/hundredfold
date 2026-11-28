/**
 * One voice attachment: a client socket in spoken conversation with one
 * session (data-model.md `VoiceAttachment`). It turns client frames and audio
 * into utterances and messages, and session events into speech. Lifecycle and
 * limits are the hub's; this class is the conversation.
 */
import type { VoiceBackgrounding, VoiceClientFrame, VoiceDetachReason, VoiceMode, VoiceServerFrame } from "../shared/gateway-events.js";
import {
  VOICE_CLOSE, VOICE_INPUT_SAMPLE_RATE, VOICE_KEEPALIVE_MS, VOICE_MAX_INPUT_FRAME_BYTES, VOICE_OUTPUT_SAMPLE_RATE, VOICE_PROTOCOL_VERSION,
} from "../shared/gateway-events.js";
import { isSteerableEngine, isSoftInterruptibleEngine, type Engine } from "../shared/types.js";
import { isBackgroundTasksSource } from "../shared/session-waits.js";
import { BargeIn, type BargeInState } from "./barge-in.js";
import { Dispatcher } from "./dispatcher.js";
import type { CancelTimer, VoiceHubDeps, VoicePrincipal, VoiceProviderSet, VoiceSocket } from "./hub-types.js";
import { phantomReason } from "./phantom-filter.js";
import { ReplyVoice } from "./reply-voice.js";
import type { ResolvedVoiceConfig } from "../shared/voice-config.js";
import { createTracer, errorField, type Tracer } from "./trace.js";
import { UtteranceCapture, vadLagFor, type FinishedUtterance } from "./utterance-capture.js";

const OPEN = 1;
/**
 * Close codes after which the attachment ends rather than waiting for the client to come back. 1009 (a frame over
 * the size limit) and 1005 (a close with no status) are not a device suspension: the client is not coming back to
 * this attachment, and waiting would hold its slot against the concurrency limit for the whole resume window.
 */
const ENDING_CODES = new Set<number>([1000, 1001, 1005, 1009, VOICE_CLOSE.protocolError, VOICE_CLOSE.accessLost, VOICE_CLOSE.sessionGone, VOICE_CLOSE.inUse, VOICE_CLOSE.limit]);
/** A reason the provider gave for being unavailable, kept short and free of addresses before it reaches a client. */
const REASON_MAX = 200;
/**
 * How long a requested hang-up waits for the client to report the goodbye played. A client that never reports
 * (an older build, a lost frame) must not leave the call open for good.
 */
export const END_GRACE_MS = 20_000;
/** A hang-up asked for in a turn that never ends (or was not in a turn at all) must not fire at the end of some later one. */
export const END_REQUEST_TTL_MS = 5 * 60_000;

export interface AttachmentInit {
  id: string;
  sessionId: string;
  principal: VoicePrincipal;
  socket: VoiceSocket;
  config: ResolvedVoiceConfig;
  providers: VoiceProviderSet;
  deps: VoiceHubDeps;
  /** The attachment is over: remove it. */
  onEnd(attachment: VoiceAttachment): void;
}

export class VoiceAttachment {
  readonly id: string;
  readonly sessionId: string;
  /** Who holds it now: the sign-in that opened it, or the one that last picked it up after a suspension. */
  principal: VoicePrincipal;
  private socket: VoiceSocket | null;
  private readonly config: ResolvedVoiceConfig;
  private readonly providers: VoiceProviderSet;
  private readonly deps: VoiceHubDeps;
  private readonly onEnd: (attachment: VoiceAttachment) => void;
  private mode: VoiceMode;
  private capture: UtteranceCapture | null = null;
  private readonly voice: ReplyVoice;
  private readonly bargeIn: BargeIn;
  private readonly dispatcher: Dispatcher;
  private chain: Promise<void> = Promise.resolve();
  private hello = false;
  private byeReceived = false;
  private ended = false;
  private suspendedAt: number | null = null;
  private cancelKeepalive: CancelTimer | null = null;
  /** The assistant asked to hang up: the call ends once the turn that asked has ended and its goodbye has played. */
  private endRequested = false;
  /** The turn that asked has ended. */
  private endTurnDone = false;
  /** Someone is speaking, so a pending hang-up waits to hear whether they are done. */
  private endHeld = false;
  private cancelEndGrace: CancelTimer | null = null;
  private cancelEndExpiry: CancelTimer | null = null;
  /** The turn ended while the client was away: the call ends as soon as the client comes back, before it is told it is ready. */
  private endOnReturn = false;
  private readonly announced = new Set<string>();
  private readonly trace: Tracer;
  /** Diagnostics only: what crossed the socket in each direction, so a cut-off reply can be told from a dropped one. */
  private readonly startedAt: number;
  private clientKind: string | undefined;
  private framesIn = 0;
  private audioInFrames = 0;
  private audioInBytes = 0;
  private audioOutFrames = 0;
  private audioOutBytes = 0;
  private droppedOut = 0;
  private dropStreak = false;

  constructor(init: AttachmentInit) {
    this.trace = createTracer(init.deps.log, { att: init.id, session: init.sessionId });
    this.startedAt = init.deps.clock.now();
    this.id = init.id;
    this.sessionId = init.sessionId;
    this.principal = init.principal;
    this.socket = init.socket;
    this.config = init.config;
    this.providers = init.providers;
    this.deps = init.deps;
    this.onEnd = init.onEnd;
    this.mode = init.config.mode;
    this.voice = new ReplyVoice({
      sessionId: init.sessionId,
      pipeline: { tts: init.providers.tts, voice: init.config.tts.voice, speed: () => this.liveSpeed(), language: init.config.language },
      send: (frame) => this.send(frame),
      sendAudio: (frame) => this.sendBinary(frame),
      deps: init.deps,
      trace: this.trace,
    });
    this.bargeIn = new BargeIn({ voice: this.voice, clock: init.deps.clock, enabled: init.config.bargeIn.enabled, trace: this.trace });
    this.dispatcher = new Dispatcher({
      trace: this.trace,
      sessionId: init.sessionId, config: init.config, deps: init.deps, voice: this.voice,
      sttProvider: init.providers.stt.id, operator: init.principal.kind === "operator", live: () => !this.ended, send: (frame) => this.send(frame),
      onBackgrounded: (tasks) => this.announce(tasks.map((task) => ({ id: task.taskId, description: task.description }))),
    });
  }

  /** The speaking rate as the config stands now, so a change in settings applies to the next sentence without ending voice mode. */
  private liveSpeed(): number {
    return (this.deps.config() ?? this.config).tts.speed;
  }

  get suspended(): boolean {
    return this.suspendedAt !== null;
  }

  /** When the client went away and nothing has come back for it yet, or null while a socket is attached (a reconnect in progress counts as attached). */
  get suspendedSince(): number | null {
    return this.socket === null ? this.suspendedAt : null;
  }

  // ── socket in ──────────────────────────────────────────────────────────────

  /** A JSON text frame from the client. */
  onText(raw: string): void {
    const frame = parseClientFrame(raw);
    if (!frame) {
      this.trace.warn("frame_unreadable", { bytes: raw.length });
      return this.badFrame("Unreadable frame.");
    }
    this.framesIn += 1;
    this.trace.debug("frame_in", () => ({ type: frame.type }));
    if (frame.type === "hello") return this.onHello(frame);
    if (!this.hello) {
      this.trace.warn("frame_before_hello", { type: frame.type });
      return this.badFrame("The first frame must be hello.");
    }
    this.onFrame(frame);
  }

  /** A binary frame: client microphone audio. */
  onBinary(pcm: Buffer): void {
    if (!this.hello) {
      this.trace.warn("audio_in_rejected", { reason: "before_hello", bytes: pcm.length });
      return this.badFrame("Audio before hello.");
    }
    if (pcm.length > VOICE_MAX_INPUT_FRAME_BYTES || pcm.length % 2 !== 0 || pcm.length === 0) {
      this.trace.warn("audio_in_rejected", { reason: "frame_size", bytes: pcm.length, max: VOICE_MAX_INPUT_FRAME_BYTES });
      return this.badFrame("Audio frame size.");
    }
    this.audioInFrames += 1;
    this.audioInBytes += pcm.length;
    this.capture?.write(pcm);
  }

  /** Whether this is the socket the attachment currently speaks to. */
  owns(socket: VoiceSocket): boolean {
    return this.socket === socket;
  }

  /** A socket closed. Whether voice mode ends or waits for the client to come back; a stale socket's close changes nothing. */
  onSocketClosed(socket: VoiceSocket, code: number): void {
    if (this.ended || this.socket !== socket) {
      this.trace.debug("socket_closed_stale", () => ({ code, ended: this.ended }));
      return;
    }
    this.socket = null;
    this.stopKeepalive();
    const ends = this.byeReceived || ENDING_CODES.has(code);
    this.trace.info("socket_closed", {
      code, bye: this.byeReceived, outcome: ends ? "end" : "suspend", client: this.clientKind, unplayed: this.voice.speaking(),
      open_ms: this.deps.clock.now() - this.startedAt,
    });
    if (ends) return this.finish();
    this.suspend();
  }

  /** A later socket from the same principal picks up a suspended attachment. */
  adopt(socket: VoiceSocket, principal: VoicePrincipal): void {
    this.trace.info("socket_adopted", { suspended_ms: this.suspendedAt === null ? undefined : this.deps.clock.now() - this.suspendedAt });
    this.socket = socket;
    this.principal = principal;
    this.hello = false;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Tell the client why, close the socket, and end. */
  detach(reason: VoiceDetachReason): void {
    if (this.ended) return;
    this.trace.info("detach", { reason });
    this.send({ type: "detached", reason });
    this.socket?.close(reason === "shutdown" ? 1001 : reason === "session_gone" ? VOICE_CLOSE.sessionGone : reason === "access_lost" ? VOICE_CLOSE.accessLost : 1000, reason);
    this.finish();
  }

  /**
   * The assistant asked to end the call (the `end_voice_call` tool, called in the turn now running). The call is
   * not cut here: the goodbye that follows the tool call is still to be spoken, so it ends when that turn has
   * ended and everything it said has been played (or been cut by the user), with a bounded wait for the report.
   * Someone speaking meanwhile keeps the call until it is known whether they said anything. Asking twice changes nothing.
   */
  endWhenSpoken(turnAlreadyEnded = false): void {
    if (this.ended || this.endRequested) return;
    this.endRequested = true;
    this.endTurnDone = turnAlreadyEnded;
    // Someone already mid-utterance (they kept talking after saying it) is heard out first.
    this.endHeld = this.capture?.inUtterance === true;
    if (turnAlreadyEnded) return this.tryEnd();
    this.cancelEndExpiry = this.deps.clock.setTimeout(() => this.cancelHangup(), END_REQUEST_TTL_MS);
  }

  /** The hang-up goes through once the asking turn is over, nobody is mid-utterance and the goodbye has been heard (or the grace ran out). */
  private tryEnd(): void {
    if (!this.endRequested || !this.endTurnDone || this.endHeld || this.ended) return;
    // A client that is away hears nothing and may be back at any moment: the end waits for it, and is told then.
    if (this.suspended) {
      this.endOnReturn = true;
      return;
    }
    if (!this.voice.speaking()) return this.detach("ended");
    this.cancelEndGrace ??= this.deps.clock.setTimeout(() => this.detach("ended"), END_GRACE_MS);
  }

  /** The user began to speak with a hang-up pending: it waits until their words are known. */
  private holdHangup(): void {
    if (!this.endRequested) return;
    this.endHeld = true;
    this.cancelEndGrace?.();
    this.cancelEndGrace = null;
  }

  /** What was heard had no words (noise, a cough, a failed recognition): the hang-up carries on. */
  private releaseHangup(): void {
    if (!this.endHeld) return;
    this.endHeld = false;
    this.tryEnd();
  }

  /** The user said something after the hang-up was asked for (over the goodbye, say): they are not done, so the call stays. */
  private cancelHangup(): void {
    this.endRequested = false;
    this.endTurnDone = false;
    this.endHeld = false;
    this.endOnReturn = false;
    this.cancelEndGrace?.();
    this.cancelEndGrace = null;
    this.cancelEndExpiry?.();
    this.cancelEndExpiry = null;
  }

  /** Whether a hang-up has been asked for and not yet carried out or dropped. */
  get hangupPending(): boolean {
    return this.endRequested && !this.ended;
  }

  /** Whether the turn that asked for the hang-up has ended. */
  get hangupTurnEnded(): boolean {
    return this.endTurnDone;
  }

  /** The suspend window ran out. */
  expire(): void {
    if (this.suspended) this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.trace.info("attachment_end", {
      client: this.clientKind, lifetime_ms: this.deps.clock.now() - this.startedAt, frames_in: this.framesIn,
      audio_in_frames: this.audioInFrames, audio_in_bytes: this.audioInBytes,
      audio_out_frames: this.audioOutFrames, audio_out_bytes: this.audioOutBytes, audio_out_dropped: this.droppedOut,
    });
    this.stopKeepalive();
    this.cancelEndGrace?.();
    this.cancelEndGrace = null;
    this.cancelEndExpiry?.();
    this.cancelEndExpiry = null;
    this.capture?.close();
    this.voice.close();
    this.onEnd(this);
  }

  private suspend(): void {
    if (this.suspendedAt !== null) return;
    this.suspendedAt = this.deps.clock.now();
    this.trace.info("suspended", { unplayed: this.voice.speaking(), audio_out_frames: this.audioOutFrames, audio_out_dropped: this.droppedOut });
    this.capture?.close();
    this.capture = null;
    this.bargeIn.clear();
    this.voice.suspend();
    // The utterance that held a pending hang-up died with the capture, and a grace timer has no client to wait on.
    this.endHeld = false;
    this.cancelEndGrace?.();
    this.cancelEndGrace = null;
    this.tryEnd();
  }

  // ── session events in ──────────────────────────────────────────────────────

  /** A gateway event for this attachment's session. */
  onSessionEvent(event: string, payload: Record<string, unknown>): void {
    if (this.ended) return;
    switch (event) {
      case "session:delta": return this.onDelta(payload);
      case "session:external-turn": return this.voice.onExternalTurn();
      case "session:deleted": case "session:stopped": return this.detach("session_gone");
      default: return this.onTurnEvent(event, payload);
    }
  }

  /** The events that mark a turn: its start, its end, and what the session owes its engine afterwards. */
  private onTurnEvent(event: string, payload: Record<string, unknown>): void {
    switch (event) {
      case "session:started": return this.voice.onStarted();
      case "session:completed": return this.onTurnEnded(true, typeof payload.result === "string" ? payload.result : "");
      case "session:interrupted": return this.onTurnEnded(false, "");
      case "session:compacted": return this.dispatcher.promptOwed();
      case "session:background": return this.announceBackground();
      default:
    }
  }

  private onDelta(payload: Record<string, unknown>): void {
    if (payload.sidechain === true) return;
    const content = typeof payload.content === "string" ? payload.content : "";
    this.trace.debug("session_delta", () => ({ type: String(payload.type), chars: content.length }));
    switch (payload.type) {
      case "text": return this.voice.onText(content, false);
      case "text_snapshot": return this.voice.onText(content, true);
      case "tool_use": return this.voice.onToolUse(typeof payload.toolName === "string" ? payload.toolName : undefined);
      case "tool_result": return this.voice.onToolResult();
      default:
    }
  }

  private onTurnEnded(flush: boolean, result: string): void {
    this.voice.onTurnEnded(flush, result);
    this.announceBackground();
    if (this.endRequested) {
      this.endTurnDone = true;
      this.cancelEndExpiry?.();
      this.cancelEndExpiry = null;
      this.tryEnd();
    }
  }

  /** Tasks the session's engine is waiting on in the background, announced once each. */
  private announceBackground(): void {
    const engine = this.sessionEngine();
    if (!engine || !isBackgroundTasksSource(engine)) return;
    this.announce(engine.backgroundTasks(this.sessionId).tasks.map((task) => ({ id: task.id, description: task.description ?? task.command })));
  }

  private announce(tasks: readonly { id: string; description: string | null }[]): void {
    for (const task of tasks) {
      if (this.announced.has(task.id)) continue;
      this.announced.add(task.id);
      this.send({ type: "background", taskId: task.id, description: task.description });
    }
  }

  // ── frames ─────────────────────────────────────────────────────────────────

  private onHello(frame: Extract<VoiceClientFrame, { type: "hello" }>): void {
    if (this.hello) return this.badFrame("hello was already sent.");
    this.clientKind = typeof frame.client === "string" ? frame.client : undefined;
    this.trace.info("hello", { client: this.clientKind, mode: frame.mode, protocol: frame.protocol, resuming: this.suspended });
    if (frame.protocol !== VOICE_PROTOCOL_VERSION) return this.protocolError("Unsupported protocol version.");
    if (frame.mode !== "hands-free" && frame.mode !== "push-to-talk") return this.badFrame("Unknown mode.");
    const unavailable = this.unavailableReason();
    if (unavailable) {
      this.trace.warn("speech_unavailable", { reason: unavailable });
      this.send({ type: "error", code: "speech_unavailable", message: unavailable });
      return this.close(1000, "unavailable");
    }
    this.hello = true;
    this.mode = frame.mode;
    // The user asked to hang up and the turn ended while they were away: the call is over, and the client is told so.
    if (this.suspended && this.endOnReturn) return this.detach("ended");
    this.capture = this.openCapture();
    // A client that has said hello is back whether or not it sends `resume`: it is a live attachment again, so
    // a take-over, a second drop and the suspend window all treat it as one.
    if (this.suspended) {
      this.suspendedAt = null;
      this.voice.unsuspend();
    }
    const ready = this.readyFrame();
    this.traceReady(ready);
    this.send(ready);
    this.startKeepalive();
  }

  private traceReady(ready: VoiceServerFrame): void {
    if (ready.type === "ready") {
      this.trace.info("ready_sent", {
        input_rate: ready.input.sampleRate, output_rate: ready.output.sampleRate, stt: ready.stt.provider, partials: ready.stt.partials,
        tts: ready.tts.provider, voice: ready.tts.voice, onset_threshold: ready.onset.threshold, onset_min_ms: ready.onset.minSpeechMs,
        barge_in: this.config.bargeIn.enabled, backgrounding: ready.backgrounding, mode: this.mode,
        vad_threshold: this.config.vad.threshold, vad_min_speech_ms: this.config.vad.minSpeechMs, vad_silence_ms: this.config.vad.silenceMs, tts_speed: this.liveSpeed(),
      });
    }
  }

  /** A `keepalive` frame every interval while a socket is attached, so the client can tell a quiet connection from a dead one. */
  private startKeepalive(): void {
    this.stopKeepalive();
    const tick = (): void => {
      this.send({ type: "keepalive" });
      this.cancelKeepalive = this.deps.clock.setTimeout(tick, VOICE_KEEPALIVE_MS);
    };
    this.cancelKeepalive = this.deps.clock.setTimeout(tick, VOICE_KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    this.cancelKeepalive?.();
    this.cancelKeepalive = null;
  }

  private onFrame(frame: Exclude<VoiceClientFrame, { type: "hello" }>): void {
    switch (frame.type) {
      case "ptt_down": return this.capture?.pttDown();
      case "ptt_up": return this.capture?.pttUp();
      case "barge_in":
        this.trace.info("client_barge_in", {
          segment: frame.segmentId, played_ms: Math.round(frame.playedMs), speaking: this.voice.speaking(), enabled: this.config.bargeIn.enabled,
          already_active: this.bargeIn.active, client: this.clientKind,
        });
        return this.bargeIn.fromClient(frame.segmentId, frame.playedMs);
      case "played":
        this.voice.markPlayed(frame.segmentId);
        return this.tryEnd();
      case "resume": return this.onResume();
      case "bye":
        this.byeReceived = true;
        this.close(1000, "bye");
        return this.finish();
    }
  }

  private onResume(): void {
    const missed = this.voice.takeMissed();
    this.trace.info("client_resume", { missed_replies: missed.length });
    if (missed.length === 0) return;
    this.send({ type: "missed", messageIds: missed.flatMap((reply) => (reply.messageId ? [reply.messageId] : [])) });
    for (const reply of missed) this.voice.pipeline.speakText(reply.text, reply.messageId);
  }

  private readyFrame(): VoiceServerFrame {
    const { stt, tts } = this.providers;
    return {
      type: "ready",
      protocol: VOICE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      input: { encoding: "pcm16", sampleRate: VOICE_INPUT_SAMPLE_RATE },
      output: { encoding: "pcm16", sampleRate: VOICE_OUTPUT_SAMPLE_RATE },
      stt: { provider: stt.id, partials: stt.partials },
      tts: { provider: tts.id, voice: this.config.tts.voice ?? tts.defaultVoice },
      onset: { threshold: this.config.bargeIn.onsetThreshold, minSpeechMs: this.config.bargeIn.minSpeechMs },
      cues: { enabled: this.config.cues.enabled, volume: this.config.cues.volume },
      backgrounding: this.backgrounding(),
      limits: { maxUtteranceSeconds: this.config.limits.maxUtteranceSeconds },
      keepaliveMs: VOICE_KEEPALIVE_MS,
    };
  }

  /** How this session's engine treats long work when the user talks over it. */
  private backgrounding(): VoiceBackgrounding {
    const engine = this.sessionEngine();
    if (!engine) return "none";
    if (isSoftInterruptibleEngine(engine) && engine.softInterruptPreservesForegroundWork && this.config.autoBackground.enabled) return "native";
    return isSteerableEngine(engine) ? "steer" : "none";
  }

  private sessionEngine(): Engine | undefined {
    const session = this.deps.getSession(this.sessionId);
    return session ? this.deps.getEngine(session.engine) : undefined;
  }

  private unavailableReason(): string | null {
    for (const provider of [this.providers.stt, this.providers.tts]) {
      const status = provider.status();
      if (!status.available) return this.deps.redact ? this.deps.redact(cleanReason(status.reason)) : cleanReason(status.reason);
    }
    return null;
  }

  // ── listening ──────────────────────────────────────────────────────────────

  private openCapture(): UtteranceCapture {
    this.capture?.close();
    return new UtteranceCapture({
      stt: this.providers.stt,
      vad: this.providers.createVad(),
      language: this.config.language,
      prerollMs: this.config.vad.prerollMs,
      unfinishedHoldMs: this.config.vad.unfinishedHoldMs,
      maxUtteranceMs: this.config.limits.maxUtteranceSeconds * 1000,
      tailMs: this.config.vad.silenceMs,
      vadLagMs: vadLagFor(this.config.vad.minSpeechMs),
      pushToTalk: this.mode === "push-to-talk",
      clock: this.deps.clock,
      newId: () => this.deps.newId(),
      trace: this.trace,
      events: {
        onVad: (speaking) => this.send({ type: "vad", speaking }),
        onStart: (id) => this.onUtteranceStart(id),
        onPartial: (utteranceId, text) => this.send({ type: "transcript", utteranceId, text, final: false }),
        onFinal: (utterance) => this.enqueueFinal(utterance),
        onFailed: (id) => this.onUtteranceFailed(id),
        onTooLong: (id) => this.send({ type: "error", code: "utterance_too_long", message: "That went on too long and was cut.", utteranceId: id }),
      },
    });
  }

  private onUtteranceStart(id: string): void {
    this.holdHangup();
    const spoke = this.voice.speaking();
    this.trace.info("utterance_start", { utterance: id, over_playback: spoke, barge_in_enabled: this.config.bargeIn.enabled, barge_in_active: this.bargeIn.active });
    if (spoke && this.config.bargeIn.enabled && !this.bargeIn.active) this.send({ type: "stop_playback", reason: "speech" });
    this.bargeIn.utteranceStarted(id, spoke);
  }

  private onUtteranceFailed(id: string): void {
    this.trace.warn("utterance_failed", { utterance: id });
    this.send({ type: "error", code: "stt_failed", message: "Speech recognition failed for that.", utteranceId: id });
    this.bargeIn.utteranceFailed(id);
    this.releaseHangup();
  }

  /** Finals are handled one at a time, in the order they arrive. */
  private enqueueFinal(utterance: FinishedUtterance): void {
    this.chain = this.chain.then(() => this.handleFinal(utterance)).catch((error: unknown) => {
      this.deps.log.warn(`voice: final handling failed for ${this.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      this.trace.warn("final_handling_failed", { error: errorField(error) });
    });
  }

  private async handleFinal(utterance: FinishedUtterance): Promise<void> {
    if (this.ended) return;
    const phantom = utterance.text.trim() ? phantomReason(utterance, this.config.filter) : null;
    // Noise that got past the VAD is told to the client as an utterance with no words, the way silence is, and goes no further.
    const words = phantom === null ? utterance.text.trim() : "";
    this.trace.info("final_transcript", { utterance: utterance.id, chars: words.length, stt_ms: utterance.sttMs, audio_ms: utterance.audioMs, dropped: phantom !== null, empty: words === "" });
    if (phantom !== null) this.deps.log.info(`voice: dropped an utterance for ${this.sessionId}: ${phantom}`);
    this.send({ type: "transcript", utteranceId: utterance.id, text: words, final: true });
    if (!words) {
      this.bargeIn.emptyFinal(utterance.id);
      return this.releaseHangup();
    }
    this.cancelHangup();
    const interrupted: BargeInState | null = this.bargeIn.takeForWords();
    await this.dispatcher.dispatch({ utterance, words, interrupted });
  }

  // ── output ─────────────────────────────────────────────────────────────────

  private send(frame: VoiceServerFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      if (frame.type !== "keepalive") this.trace.debug("frame_dropped", () => ({ type: frame.type, socket: socket ? "not_open" : "none", suspended: this.suspended }));
      return;
    }
    this.traceOut(frame);
    socket.send(JSON.stringify(frame));
  }

  private traceOut(frame: VoiceServerFrame): void {
    switch (frame.type) {
      case "keepalive": return;
      case "stop_playback": return this.trace.info("stop_playback_sent", { reason: frame.reason, unplayed: this.voice.speaking() });
      case "error": return this.trace.warn("error_sent", { code: frame.code, utterance: "utteranceId" in frame ? frame.utteranceId : undefined });
      case "detached": return this.trace.info("detached_sent", { reason: frame.reason });
      case "turn": return this.trace.info("turn_sent", { state: frame.state, tool: frame.tool });
      case "metrics": return this.trace.info("metrics_sent", { utterance: frame.utteranceId, stt_ms: frame.sttMs, ttfa_ms: frame.ttfaMs });
      default: return this.trace.debug("frame_out", () => ({ type: frame.type }));
    }
  }

  private sendBinary(frame: Buffer): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      this.droppedOut += 1;
      if (!this.dropStreak) {
        this.dropStreak = true;
        this.trace.warn("audio_out_dropped", { socket: socket ? "not_open" : "none", suspended: this.suspended, bytes: frame.length, audio_out_frames: this.audioOutFrames });
      }
      return;
    }
    this.dropStreak = false;
    this.audioOutFrames += 1;
    this.audioOutBytes += frame.length;
    socket.send(frame);
  }

  private badFrame(message: string): void {
    this.send({ type: "error", code: "bad_frame", message });
  }

  private protocolError(message: string): void {
    this.badFrame(message);
    this.close(VOICE_CLOSE.protocolError, "protocol");
  }

  private close(code: number, reason: string): void {
    this.socket?.close(code, reason);
  }
}

function parseClientFrame(raw: string): VoiceClientFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") return null;
    return parsed as VoiceClientFrame;
  } catch {
    return null;
  }
}

/** A provider's reason, safe to show: no address or credential, short. */
export function cleanReason(reason: string | undefined): string {
  const plain = (reason ?? "Speech is unavailable.").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "an address").replace(/\s+/g, " ").trim();
  return plain.length > REASON_MAX ? `${plain.slice(0, REASON_MAX - 1)}…` : plain;
}
