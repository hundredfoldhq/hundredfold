/**
 * A final transcript with words becomes one message to the session (FR-004),
 * delivered the way the barge-in policy says (FR-011 to FR-017) and carrying the
 * voice envelope (FR-019). This is where the hard rule lives: nothing here ends
 * a turn that is running long foreground work by killing it.
 */
import type { VoiceServerFrame } from "../shared/gateway-events.js";
import { isSoftInterruptibleEngine, isSteerableEngine, type BackgroundedWork, type Engine } from "../shared/types.js";
import type { BargeInState } from "./barge-in.js";
import { decideBargeIn, foregroundWorkOf, type BargeInDecision, type BargeInInput } from "./barge-in-policy.js";
import type { ForegroundWork } from "../shared/types.js";
import { backgroundedNote, buildVoiceEnvelope, interruptedNote } from "./envelope.js";
import type { VoiceDeliveryMode, VoiceHubDeps } from "./hub-types.js";
import type { ReplyVoice } from "./reply-voice.js";
import type { ResolvedVoiceConfig } from "../shared/voice-config.js";
import type { FinishedUtterance } from "./utterance-capture.js";

/** How many times a young tool call is waited out before it is treated as long work regardless. */
const MAX_WAIT_ROUNDS = 3;

export interface DispatchInput {
  utterance: FinishedUtterance;
  words: string;
  interrupted: BargeInState | null;
}

export interface DispatcherOptions {
  sessionId: string;
  config: ResolvedVoiceConfig;
  deps: VoiceHubDeps;
  voice: ReplyVoice;
  sttProvider: string;
  /** The person speaking is the operator. */
  operator: boolean;
  /** The attachment is still there: a message for one that has ended, or been stopped, is dropped, not delivered. */
  live(): boolean;
  send(frame: VoiceServerFrame): void;
  /** Work an engine moved to the background; the attachment announces it. */
  onBackgrounded(tasks: readonly BackgroundedWork[]): void;
}

/** What to do with one utterance, once the policy has spoken. */
interface Plan {
  decision: BargeInDecision;
  engine: Engine;
  engineName: string;
  /** The foreground call running when the decision was made, if any. */
  longWork: ForegroundWork | null;
}

/** How a plan reaches the session. */
interface Delivery {
  mode: VoiceDeliveryMode;
  notes: string[];
  holding: boolean;
  /** The running turn's remaining text is the old thread. */
  suppress: boolean;
}

/** How a decision that does not end the turn softly reaches the session. */
function deliveryFor(kind: BargeInDecision["kind"], notes: string[]): Delivery {
  switch (kind) {
    case "steer": return { mode: "steer", notes, holding: false, suppress: false };
    case "steer_with_holding": return { mode: "steer", notes, holding: true, suppress: false };
    case "queue_with_holding": return { mode: "queue", notes, holding: true, suppress: true };
    case "interrupt_now": return { mode: "interrupt", notes, holding: false, suppress: true };
    default: return { mode: "queue", notes, holding: false, suppress: false };
  }
}

export class Dispatcher {
  /** The full voice prompt has gone on a turn since attach, compaction or engine switch. */
  private promptSent = false;
  private promptEngine: string | null = null;
  /** The style the engine was last told (in the full block or a line); "" when none. */
  private styleSent = "";

  constructor(private readonly options: DispatcherOptions) {}

  /** A compaction forgot the instructions: the next spoken turn carries them again. */
  promptOwed(): void {
    this.promptSent = false;
  }

  async dispatch(input: DispatchInput): Promise<void> {
    const { voice, send, deps } = this.options;
    if (input.interrupted) voice.abandonHeld(input.interrupted.heard);
    try {
      const plan = await this.plan();
      if (this.options.live()) await this.carryOut(plan, input);
    } catch (error) {
      deps.log.warn(`voice: could not deliver a message to ${this.options.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      send({ type: "error", code: "dispatch_failed", message: "That could not be sent to the session.", utteranceId: input.utterance.id });
    }
  }

  // ── deciding ───────────────────────────────────────────────────────────────

  private async plan(): Promise<Plan> {
    const { deps, sessionId } = this.options;
    for (let round = 0; ; round += 1) {
      const session = deps.getSession(sessionId);
      const engine = session ? deps.getEngine(session.engine) : undefined;
      if (!session || !engine) throw new Error("the session or its engine is gone");
      const input = this.policyInput(engine, round >= MAX_WAIT_ROUNDS);
      const decision = decideBargeIn(input);
      if (decision.kind !== "wait_then_decide") return { decision, engine, engineName: session.engine, longWork: input.longWork };
      await new Promise<void>((resolve) => deps.clock.setTimeout(resolve, decision.waitMs));
      if (!this.options.live()) return { decision: { kind: "new_turn" }, engine, engineName: session.engine, longWork: null };
    }
  }

  private policyInput(engine: Engine, treatAsLong: boolean): BargeInInput {
    const { deps, sessionId, config } = this.options;
    const turnRunning = deps.turnRunning(sessionId, engine);
    return {
      turnRunning,
      longWork: turnRunning ? foregroundWorkOf(engine, sessionId) : null,
      nowMs: deps.clock.now(),
      thresholdMs: treatAsLong ? 0 : config.autoBackground.afterSeconds * 1000,
      soft: isSoftInterruptibleEngine(engine),
      // A soft interrupt backgrounds work only where it is on and the engine's soft interrupt preserves it (an
      // engine whose does not would abort the call).
      backgrounding: config.autoBackground.enabled && isSoftInterruptibleEngine(engine) && engine.softInterruptPreservesForegroundWork,
      steerable: isSteerableEngine(engine) && engine.canSteer(sessionId),
    };
  }

  // ── delivering ─────────────────────────────────────────────────────────────

  private async carryOut(plan: Plan, input: DispatchInput): Promise<void> {
    const { voice, deps, config, sessionId } = this.options;
    const delivery = await this.prepare(plan, input);
    // The soft interrupt can take seconds; the person may have left, or the session been stopped, in that time.
    if (!this.options.live()) return;
    voice.expect({ utteranceId: input.utterance.id, sttMs: input.utterance.sttMs, joinsRunningTurn: delivery.mode === "steer" });
    if (delivery.holding) voice.speakHolding(config.holdingLine);
    if (delivery.suppress) voice.suppressUntilBoundary();
    const before = { sent: this.promptSent, engine: this.promptEngine, style: this.styleSent };
    const envelope = this.envelope(input.words, plan.engineName, delivery.notes);
    try {
      await deps.deliver({
        sessionId, text: input.words, envelope, mode: delivery.mode, operator: this.options.operator,
        meta: { voice: { utteranceId: input.utterance.id, sttProvider: this.options.sttProvider, audioMs: input.utterance.audioMs } },
      });
    } catch (error) {
      this.promptSent = before.sent;
      this.promptEngine = before.engine;
      this.styleSent = before.style;
      throw error;
    }
  }

  /** The mode, notes and spoken extras for the decision; a soft interrupt happens here. */
  private async prepare(plan: Plan, input: DispatchInput): Promise<Delivery> {
    const notes = input.interrupted ? [interruptedNote(input.interrupted.heard)] : [];
    if (plan.decision.kind === "soft_then_turn") return this.soft(plan, notes);
    return deliveryFor(plan.decision.kind, notes);
  }

  /**
   * End the running turn softly, never aborting what it is running: a Bash moves to the background, and the
   * turn ends. It can take several seconds, so with long work running the holding line is spoken before it.
   * When the engine cannot (`unsupported`: no acknowledgement came, so the call is still running) the decision is
   * run again as if the engine had no soft interrupt: steer or queue, never a kill.
   */
  private async soft(plan: Plan, notes: string[]): Promise<Delivery> {
    const { engine } = plan;
    if (!isSoftInterruptibleEngine(engine)) return deliveryFor("queue_with_holding", notes);
    const waiting = plan.longWork !== null;
    if (waiting) this.options.voice.speakHolding(this.options.config.holdingLine);
    const outcome = await engine.softInterrupt(this.options.sessionId, "voice barge-in");
    if (outcome.ended) {
      if (outcome.backgrounded.length > 0) {
        this.options.onBackgrounded(outcome.backgrounded);
        notes.push(backgroundedNote(outcome.backgrounded));
      }
      return { mode: "queue", notes, holding: false, suppress: true };
    }
    // Nothing was running to end: the message waits its turn.
    if (outcome.reason === "no_turn") return { mode: "queue", notes, holding: false, suppress: false };
    const again = decideBargeIn({ ...this.policyInput(engine, true), soft: false });
    const delivery = deliveryFor(again.kind, notes);
    return waiting ? { ...delivery, holding: false } : delivery;
  }

  /** The envelope for this message: the full prompt first (or after a compaction or engine switch), a reminder after. */
  private envelope(text: string, engineName: string, notes: readonly string[]): string {
    const full = !this.promptSent || this.promptEngine !== engineName;
    // The style is read from the live config each turn, so an edit reaches a conversation already open. The
    // snapshot is only a fallback for a moment with no live voice config; the attachment detaches on that reload.
    const style = (this.options.deps.config() ?? this.options.config).stylePrompt;
    // Set before and empty now: the earlier directions sit in the engine's history and must be told to go.
    const styleCleared = !full && style === "" && this.styleSent !== "";
    const envelope = buildVoiceEnvelope({ text, prompt: this.options.config.prompt, style, styleCleared, full, notes });
    if (envelope) {
      this.promptSent = true;
      this.promptEngine = engineName;
      this.styleSent = style;
    }
    return envelope;
  }
}
