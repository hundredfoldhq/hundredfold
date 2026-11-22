/**
 * One voice attachment: a client socket in spoken conversation with one
 * session (data-model.md `VoiceAttachment`). It turns client frames and audio
 * into utterances and messages, and session events into speech. Lifecycle and
 * limits are the hub's; this class is the conversation.
 */
import type { VoiceBackgrounding, VoiceClientFrame, VoiceDetachReason, VoiceMode, VoiceServerFrame } from "../shared/gateway-events.js";
import {
  VOICE_CLOSE, VOICE_INPUT_SAMPLE_RATE, VOICE_MAX_INPUT_FRAME_BYTES, VOICE_OUTPUT_SAMPLE_RATE, VOICE_PROTOCOL_VERSION,
} from "../shared/gateway-events.js";
import { isSteerableEngine, isSoftInterruptibleEngine, type Engine } from "../shared/types.js";
import { isBackgroundTasksSource } from "../shared/session-waits.js";
import { BargeIn, type BargeInState } from "./barge-in.js";
import { Dispatcher } from "./dispatcher.js";
import type { VoiceHubDeps, VoicePrincipal, VoiceProviderSet, VoiceSocket } from "./hub-types.js";
import { ReplyVoice } from "./reply-voice.js";
import type { ResolvedVoiceConfig } from "../shared/voice-config.js";
import { UtteranceCapture, type FinishedUtterance } from "./utterance-capture.js";

const OPEN = 1;
/**
 * Close codes after which the attachment ends rather than waiting for the client to come back. 1009 (a frame over
 * the size limit) and 1005 (a close with no status) are not a device suspension: the client is not coming back to
 * this attachment, and waiting would hold its slot against the concurrency limit for the whole resume window.
 */
const ENDING_CODES = new Set<number>([1000, 1001, 1005, 1009, VOICE_CLOSE.protocolError, VOICE_CLOSE.accessLost, VOICE_CLOSE.sessionGone, VOICE_CLOSE.inUse, VOICE_CLOSE.limit]);
/** A reason the provider gave for being unavailable, kept short and free of addresses before it reaches a client. */
const REASON_MAX = 200;

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
  private readonly announced = new Set<string>();

  constructor(init: AttachmentInit) {
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
      pipeline: { tts: init.providers.tts, voice: init.config.tts.voice, speed: init.config.tts.speed, language: init.config.language },
      send: (frame) => this.send(frame),
      sendAudio: (frame) => this.sendBinary(frame),
      deps: init.deps,
    });
    this.bargeIn = new BargeIn({ voice: this.voice, clock: init.deps.clock, enabled: init.config.bargeIn.enabled });
    this.dispatcher = new Dispatcher({
      sessionId: init.sessionId, config: init.config, deps: init.deps, voice: this.voice,
      sttProvider: init.providers.stt.id, operator: init.principal.kind === "operator", live: () => !this.ended, send: (frame) => this.send(frame),
      onBackgrounded: (tasks) => this.announce(tasks.map((task) => ({ id: task.taskId, description: task.description }))),
    });
  }

  get suspended(): boolean {
    return this.suspendedAt !== null;
  }

  // ── socket in ──────────────────────────────────────────────────────────────

  /** A JSON text frame from the client. */
  onText(raw: string): void {
    const frame = parseClientFrame(raw);
    if (!frame) return this.badFrame("Unreadable frame.");
    if (frame.type === "hello") return this.onHello(frame);
    if (!this.hello) return this.badFrame("The first frame must be hello.");
    this.onFrame(frame);
  }

  /** A binary frame: client microphone audio. */
  onBinary(pcm: Buffer): void {
    if (!this.hello) return this.badFrame("Audio before hello.");
    if (pcm.length > VOICE_MAX_INPUT_FRAME_BYTES || pcm.length % 2 !== 0 || pcm.length === 0) return this.badFrame("Audio frame size.");
    this.capture?.write(pcm);
  }

  /** Whether this is the socket the attachment currently speaks to. */
  owns(socket: VoiceSocket): boolean {
    return this.socket === socket;
  }

  /** A socket closed. Whether voice mode ends or waits for the client to come back; a stale socket's close changes nothing. */
  onSocketClosed(socket: VoiceSocket, code: number): void {
    if (this.ended || this.socket !== socket) return;
    this.socket = null;
    if (this.byeReceived || ENDING_CODES.has(code)) return this.finish();
    this.suspend();
  }

  /** A later socket from the same principal picks up a suspended attachment. */
  adopt(socket: VoiceSocket, principal: VoicePrincipal): void {
    this.socket = socket;
    this.principal = principal;
    this.hello = false;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Tell the client why, close the socket, and end. */
  detach(reason: VoiceDetachReason): void {
    if (this.ended) return;
    this.send({ type: "detached", reason });
    this.socket?.close(reason === "shutdown" ? 1001 : reason === "session_gone" ? VOICE_CLOSE.sessionGone : reason === "access_lost" ? VOICE_CLOSE.accessLost : 1000, reason);
    this.finish();
  }

  /** The suspend window ran out. */
  expire(): void {
    if (this.suspended) this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.capture?.close();
    this.voice.close();
    this.onEnd(this);
  }

  private suspend(): void {
    if (this.suspendedAt !== null) return;
    this.suspendedAt = this.deps.clock.now();
    this.capture?.close();
    this.capture = null;
    this.bargeIn.clear();
    this.voice.suspend();
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
    if (frame.protocol !== VOICE_PROTOCOL_VERSION) return this.protocolError("Unsupported protocol version.");
    if (frame.mode !== "hands-free" && frame.mode !== "push-to-talk") return this.badFrame("Unknown mode.");
    const unavailable = this.unavailableReason();
    if (unavailable) {
      this.send({ type: "error", code: "speech_unavailable", message: unavailable });
      return this.close(1000, "unavailable");
    }
    this.hello = true;
    this.mode = frame.mode;
    this.capture = this.openCapture();
    // A client that has said hello is back whether or not it sends `resume`: it is a live attachment again, so
    // a take-over, a second drop and the suspend window all treat it as one.
    if (this.suspended) {
      this.suspendedAt = null;
      this.voice.unsuspend();
    }
    this.send(this.readyFrame());
  }

  private onFrame(frame: Exclude<VoiceClientFrame, { type: "hello" }>): void {
    switch (frame.type) {
      case "ptt_down": return this.capture?.pttDown();
      case "ptt_up": return this.capture?.pttUp();
      case "barge_in": return this.bargeIn.fromClient(frame.segmentId, frame.playedMs);
      case "played": return this.voice.markPlayed(frame.segmentId);
      case "resume": return this.onResume();
      case "bye":
        this.byeReceived = true;
        this.close(1000, "bye");
        return this.finish();
    }
  }

  private onResume(): void {
    const missed = this.voice.takeMissed();
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
      backgrounding: this.backgrounding(),
      limits: { maxUtteranceSeconds: this.config.limits.maxUtteranceSeconds },
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
      pushToTalk: this.mode === "push-to-talk",
      clock: this.deps.clock,
      newId: () => this.deps.newId(),
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
    const spoke = this.voice.speaking();
    if (spoke && this.config.bargeIn.enabled && !this.bargeIn.active) this.send({ type: "stop_playback", reason: "speech" });
    this.bargeIn.utteranceStarted(id, spoke);
  }

  private onUtteranceFailed(id: string): void {
    this.send({ type: "error", code: "stt_failed", message: "Speech recognition failed for that.", utteranceId: id });
    this.bargeIn.utteranceFailed(id);
  }

  /** Finals are handled one at a time, in the order they arrive. */
  private enqueueFinal(utterance: FinishedUtterance): void {
    this.chain = this.chain.then(() => this.handleFinal(utterance)).catch((error: unknown) => {
      this.deps.log.warn(`voice: final handling failed for ${this.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async handleFinal(utterance: FinishedUtterance): Promise<void> {
    if (this.ended) return;
    const words = utterance.text.trim();
    this.send({ type: "transcript", utteranceId: utterance.id, text: words, final: true });
    if (!words) return this.bargeIn.emptyFinal(utterance.id);
    const interrupted: BargeInState | null = this.bargeIn.takeForWords();
    await this.dispatcher.dispatch({ utterance, words, interrupted });
  }

  // ── output ─────────────────────────────────────────────────────────────────

  private send(frame: VoiceServerFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  private sendBinary(frame: Buffer): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
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
