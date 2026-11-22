/**
 * What the voice hub needs from the rest of the gateway, as narrow ports, so
 * the hub is exercised with fakes (provider, VAD, engine, clock) and the
 * gateway supplies the real ones in one place (`runtime.ts`).
 */
import type { Engine, JsonObject } from "../shared/types.js";
import type { SttProvider, TtsProvider, VadStream } from "./provider.js";
import type { ResolvedVoiceConfig } from "./resolved-config.js";

/** A running timer's cancel. */
export type CancelTimer = () => void;

export interface VoiceClock {
  now(): number;
  setTimeout(run: () => void, ms: number): CancelTimer;
}

export const systemClock: VoiceClock = {
  now: () => Date.now(),
  setTimeout(run, ms) {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/** Who opened an attachment. Another principal never takes one over. */
export type VoicePrincipal =
  | { kind: "operator" }
  | { kind: "member"; userId: string; userSessionId: string };

export function samePrincipal(a: VoicePrincipal, b: VoicePrincipal): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "operator" || (b.kind === "member" && a.userId === b.userId);
}

/** The little of a WebSocket the hub uses. */
export interface VoiceSocket {
  readonly readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
}

export interface VoiceProviderSet {
  stt: SttProvider;
  tts: TtsProvider;
  createVad(): VadStream;
}

/** How one spoken message reaches a session's engine. */
export type VoiceDeliveryMode =
  /** Behind whatever is running; the turn is not cut. */
  | "queue"
  /** Into the running turn at its next step. */
  | "steer"
  /** Cut the running turn (the existing "send now"). Only ever when nothing long runs. */
  | "interrupt";

export interface VoiceDelivery {
  sessionId: string;
  /** What the person said: stored, shown, and queued as the message. */
  text: string;
  /** Engine-only instructions ahead of the text; never stored. May be empty. */
  envelope: string;
  /** Facts stored on the user message under `meta.voice`. */
  meta: JsonObject;
  mode: VoiceDeliveryMode;
  /** The operator sent it themselves (as opposed to a member). */
  operator: boolean;
}

export interface VoiceDeliveryResult {
  messageId: string;
}

export interface VoiceLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface VoiceHubDeps {
  /** The live resolved config, or null while voice is off. */
  config(): ResolvedVoiceConfig | null;
  /** The speech providers for a config. Called once per config the hub sees. */
  providers(config: ResolvedVoiceConfig): VoiceProviderSet;
  getSession(sessionId: string): { id: string; engine: string } | undefined;
  getEngine(name: string): Engine | undefined;
  /** Whether a turn is running in the session now. */
  turnRunning(sessionId: string, engine: Engine): boolean;
  /** Hand a final transcript to the session as an ordinary user message. */
  deliver(delivery: VoiceDelivery): Promise<VoiceDeliveryResult>;
  mergeMessageMeta(messageId: string, patch: JsonObject): void;
  /** The stored assistant message a reply written since `sinceMs` became. */
  findReplyMessageId(sessionId: string, sinceMs: number): string | undefined;
  clock: VoiceClock;
  log: VoiceLog;
  newId(): string;
  /** Strips any provider key from text that is about to be sent to a client. Absent: text is sent as is. */
  redact?(text: string): string;
}
