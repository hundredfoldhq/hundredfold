import { VoiceHub } from "../hub.js";
import type { VoiceAttachment } from "../attachment.js";
import type { VoiceDelivery, VoiceHubDeps, VoicePrincipal } from "../hub-types.js";
import { DEFAULT_HOLDING_LINE, DEFAULT_VOICE_PROMPT, type ResolvedVoiceConfig } from "../../shared/voice-config.js";
import { FakeClock, FakeEngine, FakeSocket, FakeStt, FakeTts, FakeVad, settle, type FakeEngineOptions } from "./fakes.js";

export const SESSION = "s1";
export const OPERATOR: VoicePrincipal = { kind: "operator" };

/** 20 ms of 16 kHz PCM16 mono. */
export const FRAME = Buffer.alloc(640, 3);

export function baseConfig(over: Partial<ResolvedVoiceConfig> = {}): ResolvedVoiceConfig {
  return {
    mode: "hands-free", language: "en",
    stt: { provider: "local", model: "parakeet-tdt-0.6b-v2", baseUrl: null, apiKeyRef: null },
    tts: { provider: "local", model: "kokoro-v1.0", baseUrl: null, apiKeyRef: null, voice: "af_test", speed: 1 },
    vad: { threshold: 0.5, minSpeechMs: 250, silenceMs: 700, prerollMs: 300 },
    bargeIn: { enabled: true, minSpeechMs: 250, onsetThreshold: 0.02 },
    autoBackground: { enabled: true, afterSeconds: 5 },
    cues: { enabled: true, volume: 0.3 },
    prompt: DEFAULT_VOICE_PROMPT, promptFile: null, holdingLine: DEFAULT_HOLDING_LINE,
    limits: { maxUtteranceSeconds: 60, maxConcurrentAttachments: 4 },
    local: { device: "auto" },
    ...over,
  };
}

export interface HarnessOptions {
  engine?: FakeEngineOptions;
  config?: Partial<ResolvedVoiceConfig>;
  /** Extra engine members (a background-tasks source, say). */
  decorate?: (engine: FakeEngine) => void;
  /** Run the hub against this engine instead of a fake: a real engine class, for its real capability detection. */
  realEngine?: import("../../shared/types.js").Engine;
}

export function createHarness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const engine = new FakeEngine(options.engine);
  options.decorate?.(engine);
  const vads: FakeVad[] = [];
  const delivered: VoiceDelivery[] = [];
  const merges: Array<{ id: string; patch: unknown }> = [];
  const warnings: string[] = [];
  let ids = 0;
  /** The stored transcript as the hub reads it back; `external` rows are the ones the transcript sync stamped. */
  const stored: Array<{ id: string; role: string; content: string; toolCall: boolean; external: boolean; timestamp: number }> = [];
  const state = {
    config: baseConfig(options.config) as ResolvedVoiceConfig | null,
    turnRunning: false,
    sessionExists: true,
    engineName: "fake",
    replyMessage: "assistant-1" as string | undefined,
    deliverFails: false,
  };
  const deps: VoiceHubDeps = {
    config: () => state.config,
    providers: () => ({ stt, tts, createVad: () => { const vad = new FakeVad(); vads.push(vad); return vad; } }),
    getSession: (id) => (state.sessionExists ? { id, engine: state.engineName } : undefined),
    getEngine: () => options.realEngine ?? engine,
    turnRunning: () => state.turnRunning,
    deliver: async (delivery) => {
      if (state.deliverFails) throw new Error("boom with secret detail");
      delivered.push(delivery);
      return { messageId: `m${delivered.length}` };
    },
    mergeMessageMeta: (id, patch) => { merges.push({ id, patch }); },
    findReplyMessageId: () => state.replyMessage,
    externalRepliesSince: (_session, sinceMs) => stored.filter((row) => row.external && row.role === "assistant" && !row.toolCall && row.timestamp > sinceMs),
    clock,
    log: { info: () => undefined, warn: (message) => { warnings.push(message); } },
    newId: () => `id${++ids}`,
  };
  const hub = new VoiceHub(deps);

  /** Store a message as the gateway would (a turn's own row, not the sync's), returning its id. */
  function store(role: string, content: string, toolCall = false, external = false, at = clock.now()): string {
    const id = `stored-${stored.length + 1}`;
    stored.push({ id, role, content, toolCall, external, timestamp: at });
    return id;
  }

  /** Open a socket on the session and say hello. */
  function connect(opts: { principal?: VoicePrincipal; sessionId?: string; mode?: "hands-free" | "push-to-talk"; hello?: boolean } = {}) {
    const socket = new FakeSocket();
    const attachment = hub.attach(socket, { sessionId: opts.sessionId ?? SESSION, principal: opts.principal ?? OPERATOR });
    if (attachment && opts.hello !== false) {
      attachment.onText(JSON.stringify({ type: "hello", protocol: 1, mode: opts.mode ?? "hands-free", client: "web" }));
    }
    return { socket, attachment: attachment as VoiceAttachment };
  }

  const h = {
    clock, stt, tts, engine, vads, delivered, merges, warnings, state, hub, deps,
    connect, store,
    /** Frames of one type the client has been sent. */
    vad: () => vads[vads.length - 1],
    audio(attachment: VoiceAttachment, frames: number): void {
      for (let i = 0; i < frames; i += 1) attachment.onBinary(FRAME);
    },
    /** Speak a sentence: speech starts, runs, ends, and the STT returns `text`. */
    async say(attachment: VoiceAttachment, text: string, opts: { frames?: number; partial?: string } = {}): Promise<void> {
      const vad = h.vad();
      vad.start();
      h.audio(attachment, opts.frames ?? 10);
      if (opts.partial) stt.last().partial(opts.partial);
      vad.end();
      stt.last().final(text);
      await settle();
    },
    event(event: string, payload: Record<string, unknown> = {}): void {
      hub.onEvent(event, { sessionId: SESSION, ...payload });
    },
    /** A reply streaming in as the engine would stream it. */
    delta(type: string, content: string, extra: Record<string, unknown> = {}): void {
      h.event("session:delta", { type, content, ...extra });
    },
    async reply(text: string): Promise<void> {
      h.event("session:started");
      h.delta("text", text);
      h.event("session:completed", { result: text, error: null });
      await settle();
    },
    /** What the transcript sync does for a reply the CLI wrote on its own: the rows are stored, then the event is emitted. */
    externalTurn(...texts: string[]): string[] {
      const ids = texts.map((text) => store("assistant", text, false, true, clock.now() + 1));
      h.event("session:external-turn");
      return ids;
    },
    json: (frame: Record<string, unknown>) => JSON.stringify(frame),
  };
  return h;
}

export type Harness = ReturnType<typeof createHarness>;
