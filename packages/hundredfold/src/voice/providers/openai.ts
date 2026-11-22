/**
 * OpenAI speech providers (specs/009-voice-mode/contracts/providers.md, `openai` row).
 *
 * STT streams over a Realtime transcription session; TTS streams `POST /v1/audio/speech`
 * as raw PCM. The API shapes follow the OpenAI developer docs as read on 2026-11-22:
 *  - Realtime transcription guide: https://developers.openai.com/api/docs/guides/realtime-transcription
 *    (`wss://api.openai.com/v1/realtime?intent=transcription`, a `session.update` with
 *    `session.type: "transcription"`, `audio.input.format {type: "audio/pcm", rate: 24000}`,
 *    `input_audio_buffer.append` / `.commit`, `conversation.item.input_audio_transcription.delta`
 *    and `.completed`)
 *  - Text to speech: https://developers.openai.com/api/docs/guides/text-to-speech
 *    (`response_format: "pcm"` is 24 kHz, 16-bit signed little-endian, headerless)
 * The key comes from the environment at construction and lives only in this closure.
 */
import WebSocket from "ws";
import { resolveEnvVar } from "../../shared/env-ref.js";
import type { ResolvedVoiceSide } from "../../shared/voice-config.js";
import type { SttEvent, SttProvider, SttStream, SttStreamOptions, TtsProvider, TtsSynthesisOptions, VoiceProviderStatus } from "../provider.js";
import { envNameOf, redact, resamplePcm16 } from "./audio.js";
import { streamSpeech } from "./speech-http.js";

export interface OpenAiEndpoints { http: string; ws: string }
export const OPENAI_ENDPOINTS: OpenAiEndpoints = { http: "https://api.openai.com", ws: "wss://api.openai.com" };

export interface OpenAiDeps {
  env?: NodeJS.ProcessEnv;
  endpoints?: OpenAiEndpoints;
}

/** Realtime transcription takes 24 kHz PCM16 only. */
const REALTIME_RATE = 24_000;
const FINAL_TIMEOUT_MS = 20_000;

interface RealtimeEvent { type?: string; item_id?: string; delta?: string; transcript?: string; error?: { message?: string } }

function keyStatus(side: ResolvedVoiceSide, key: string | undefined): VoiceProviderStatus {
  if (key) return { available: true };
  const name = envNameOf(side.apiKeyRef);
  return { available: false, reason: name ? `OpenAI key not set: ${name}` : "OpenAI key not configured: set apiKey to a ${VAR} reference" };
}

export class OpenAiSttProvider implements SttProvider {
  readonly id = "openai";
  readonly partials = true;
  readonly #key: string | undefined;
  private readonly endpoints: OpenAiEndpoints;

  constructor(private readonly side: ResolvedVoiceSide, deps: OpenAiDeps = {}) {
    this.#key = resolveEnvVar(side.apiKeyRef ?? undefined, deps.env);
    this.endpoints = deps.endpoints ?? OPENAI_ENDPOINTS;
  }

  status(): VoiceProviderStatus {
    return keyStatus(this.side, this.#key);
  }

  open(options: SttStreamOptions): SttStream {
    const status = this.status();
    const stream = new OpenAiSttStream(this.#key ?? "", this.side.model, this.endpoints.ws, options);
    if (status.available) stream.connect();
    else queueMicrotask(() => stream.fail(status.reason ?? "OpenAI key not set")); // after the caller has subscribed
    return stream;
  }
}

class OpenAiSttStream implements SttStream {
  private readonly handlers: Array<(event: SttEvent) => void> = [];
  private socket: WebSocket | null = null;
  private ready = false;
  private ended = false;
  private settled = false;
  private sentAudio = false;
  private itemId: string | null = null;
  private text = "";
  private queued: string[] = [];
  private finalTimer: NodeJS.Timeout | null = null;

  readonly #key: string;

  constructor(key: string, private readonly model: string, private readonly wsBase: string, private readonly options: SttStreamOptions) {
    this.#key = key;
    options.signal.addEventListener("abort", () => this.abort(), { once: true });
  }

  on(handler: (event: SttEvent) => void): void {
    this.handlers.push(handler);
  }

  connect(): void {
    if (this.options.signal.aborted) return this.abort();
    const socket = new WebSocket(`${this.wsBase}/v1/realtime?intent=transcription`, { headers: { Authorization: `Bearer ${this.#key}` } });
    this.socket = socket;
    socket.on("open", () => this.send(this.sessionUpdate()));
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("error", (error) => this.fail(`OpenAI transcription connection failed: ${redact(error.message, [this.#key])}`));
    socket.on("close", () => this.fail("OpenAI transcription connection closed before the transcript arrived"));
  }

  private sessionUpdate(): Record<string, unknown> {
    const transcription: Record<string, unknown> = { model: this.model };
    if (this.options.language) transcription.languages = [this.options.language.slice(0, 2).toLowerCase()];
    return { type: "session.update", session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: REALTIME_RATE }, transcription, turn_detection: null } } } };
  }

  write(pcm: Buffer): void {
    if (this.settled || this.ended || pcm.length === 0) return;
    this.sentAudio = true;
    const event = JSON.stringify({ type: "input_audio_buffer.append", audio: resamplePcm16(pcm, this.options.sampleRate, REALTIME_RATE).toString("base64") });
    if (this.ready) this.socket?.send(event);
    else this.queued.push(event);
  }

  end(): void {
    if (this.settled || this.ended) return;
    this.ended = true;
    if (!this.sentAudio) return this.settle({ type: "final", text: "" }); // committing an empty buffer is an error
    if (this.ready) this.commit();
  }

  abort(): void {
    this.settled = true;
    this.handlers.length = 0;
    this.close();
  }

  fail(message: string): void {
    this.settle({ type: "error", message });
  }

  private commit(): void {
    this.send({ type: "input_audio_buffer.commit" });
    this.finalTimer = setTimeout(() => this.fail("OpenAI transcription timed out"), FINAL_TIMEOUT_MS);
    this.finalTimer.unref();
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  private readonly events: Record<string, (event: RealtimeEvent) => void> = {
    "session.updated": () => this.onReady(),
    "input_audio_buffer.committed": (event) => { this.itemId = event.item_id ?? null; },
    "conversation.item.input_audio_transcription.delta": (event) => this.onDelta(event.delta ?? ""),
    "conversation.item.input_audio_transcription.completed": (event) => this.onCompleted(event.item_id, event.transcript ?? this.text),
    "conversation.item.input_audio_transcription.failed": (event) => this.onFailure(event),
    error: (event) => this.onFailure(event),
  };

  private onMessage(raw: string): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      return;
    }
    this.events[event.type ?? ""]?.(event);
  }

  private onFailure(event: RealtimeEvent): void {
    this.fail(`OpenAI transcription failed: ${redact(event.error?.message ?? "unknown error", [this.#key]).slice(0, 300)}`);
  }

  private onReady(): void {
    if (this.ready) return;
    this.ready = true;
    for (const event of this.queued.splice(0)) this.socket?.send(event);
    if (this.ended) this.commit();
  }

  /** A delta is new text; a partial is everything heard so far. */
  private onDelta(delta: string): void {
    if (this.settled) return;
    this.text += delta;
    this.emit({ type: "partial", text: this.text });
  }

  private onCompleted(itemId: string | undefined, transcript: string): void {
    if (this.itemId && itemId && itemId !== this.itemId) return;
    this.settle({ type: "final", text: transcript.trim() });
  }

  private settle(event: SttEvent): void {
    if (this.settled) return;
    this.settled = true;
    this.emit(event);
    this.close();
  }

  private emit(event: SttEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private close(): void {
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.finalTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.removeAllListeners("close");
    socket?.on("error", () => undefined);
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  }
}

export class OpenAiTtsProvider implements TtsProvider {
  readonly id = "openai";
  readonly sampleRate = 24_000;
  readonly #key: string | undefined;
  private readonly endpoints: OpenAiEndpoints;

  constructor(private readonly side: ResolvedVoiceSide & { voice: string; speed: number }, deps: OpenAiDeps = {}) {
    this.#key = resolveEnvVar(side.apiKeyRef ?? undefined, deps.env);
    this.endpoints = deps.endpoints ?? OPENAI_ENDPOINTS;
  }

  get defaultVoice(): string {
    return this.side.voice;
  }

  status(): VoiceProviderStatus {
    return keyStatus(this.side, this.#key);
  }

  async *synthesize(text: string, options: TtsSynthesisOptions): AsyncGenerator<Buffer> {
    const status = this.status();
    if (!status.available) throw new Error(status.reason);
    const body = { model: this.side.model, input: text, voice: options.voice ?? this.side.voice, speed: options.speed ?? this.side.speed, response_format: "pcm" };
    yield* streamSpeech({
      url: `${this.endpoints.http}/v1/audio/speech`, key: this.#key, body, signal: options.signal, who: "OpenAI speech",
    });
  }
}
