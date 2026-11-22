/**
 * Providers for a self-hosted server that speaks the OpenAI audio API shape
 * (specs/009-voice-mode/contracts/providers.md, `openai-compatible` row):
 * `POST {baseUrl}/v1/audio/transcriptions` with the whole utterance as a WAV (batch, so no
 * partials), and `POST {baseUrl}/v1/audio/speech` asking for `pcm`, then `wav`; a server
 * that can only return MP3 is refused with a message that says so. The key is optional.
 */
import { resolveEnvVar } from "../../shared/env-ref.js";
import type { ResolvedVoiceSide } from "../../shared/voice-config.js";
import type { SttEvent, SttProvider, SttStream, SttStreamOptions, TtsProvider, TtsSynthesisOptions, VoiceProviderStatus } from "../provider.js";
import { looksLikeMp3, parseWav, redact, resamplePcm16, toWav } from "./audio.js";
import { pcmChunks, postSpeech, SpeechHttpError, type SpeechRequest } from "./speech-http.js";

const TTS_RATE = 24_000;
const MP3_ONLY = "the server only returns MP3, which voice mode cannot play; configure it to return PCM or WAV";

function endpoint(side: ResolvedVoiceSide, tail: string): string {
  return `${side.baseUrl ?? ""}/v1/audio/${tail}`;
}

/** A configured key that resolves to nothing is a mistake worth saying; no key at all is fine. */
function keyProblem(side: ResolvedVoiceSide, key: string | undefined): VoiceProviderStatus {
  if (side.apiKeyRef && !key) return { available: false, reason: `API key not set: ${side.apiKeyRef.replace(/^\$\{|\}$/g, "")}` };
  return { available: true };
}

export class OpenAiCompatibleSttProvider implements SttProvider {
  readonly id = "openai-compatible";
  readonly partials = false;
  readonly #key: string | undefined;

  constructor(private readonly side: ResolvedVoiceSide, env: NodeJS.ProcessEnv = process.env) {
    this.#key = resolveEnvVar(side.apiKeyRef ?? undefined, env);
  }

  status(): VoiceProviderStatus {
    return keyProblem(this.side, this.#key);
  }

  open(options: SttStreamOptions): SttStream {
    return new BatchSttStream(this.side, this.#key, options, this.status());
  }
}

class BatchSttStream implements SttStream {
  private readonly handlers: Array<(event: SttEvent) => void> = [];
  private readonly controller = new AbortController();
  private chunks: Buffer[] = [];
  private settled = false;

  readonly #key: string | undefined;

  constructor(private readonly side: ResolvedVoiceSide, key: string | undefined, private readonly options: SttStreamOptions, status: VoiceProviderStatus) {
    this.#key = key;
    options.signal.addEventListener("abort", () => this.abort(), { once: true });
    if (!status.available) queueMicrotask(() => this.settle({ type: "error", message: status.reason ?? "not available" }));
  }

  on(handler: (event: SttEvent) => void): void {
    this.handlers.push(handler);
  }

  write(pcm: Buffer): void {
    if (!this.settled) this.chunks.push(pcm);
  }

  abort(): void {
    this.settled = true;
    this.handlers.length = 0;
    this.controller.abort();
  }

  end(): void {
    if (this.settled) return;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    if (pcm.length === 0) return this.settle({ type: "final", text: "" });
    void this.transcribe(pcm).then(
      (text) => this.settle({ type: "final", text }),
      (error: unknown) => this.settle({ type: "error", message: redact(error instanceof Error ? error.message : String(error), [this.#key]) }),
    );
  }

  private async transcribe(pcm: Buffer): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(toWav(pcm, this.options.sampleRate))], { type: "audio/wav" }), "audio.wav");
    form.append("model", this.side.model);
    form.append("response_format", "json");
    if (this.options.language) form.append("language", this.options.language.slice(0, 2).toLowerCase());
    const headers: Record<string, string> = this.#key ? { Authorization: `Bearer ${this.#key}` } : {};
    const response = await fetch(endpoint(this.side, "transcriptions"), { method: "POST", headers, body: form, signal: this.controller.signal });
    if (!response.ok) throw new Error(`transcription failed (HTTP ${response.status})`);
    const parsed = (await response.json()) as { text?: unknown };
    if (typeof parsed.text !== "string") throw new Error("transcription reply had no text");
    return parsed.text.trim();
  }

  private settle(event: SttEvent): void {
    if (this.settled) return;
    this.settled = true;
    for (const handler of this.handlers) handler(event);
  }
}

/** A 4xx that is not about credentials or rate: the server did not like `response_format`. */
function formatNotSupported(error: unknown): boolean {
  if (!(error instanceof SpeechHttpError)) return false;
  return error.status >= 400 && error.status < 500 && ![401, 403, 429].includes(error.status);
}

export class OpenAiCompatibleTtsProvider implements TtsProvider {
  readonly id = "openai-compatible";
  readonly sampleRate = TTS_RATE;
  readonly #key: string | undefined;

  constructor(private readonly side: ResolvedVoiceSide & { voice: string; speed: number }, env: NodeJS.ProcessEnv = process.env) {
    this.#key = resolveEnvVar(side.apiKeyRef ?? undefined, env);
  }

  get defaultVoice(): string {
    return this.side.voice;
  }

  status(): VoiceProviderStatus {
    return keyProblem(this.side, this.#key);
  }

  async *synthesize(text: string, options: TtsSynthesisOptions): AsyncGenerator<Buffer> {
    const status = this.status();
    if (!status.available) throw new Error(status.reason);
    yield* this.audioFrom(await this.openSpeech(text, options));
  }

  /** Ask for raw `pcm`; a server that does not know it says so with a client error, so ask for `wav` instead. */
  private async openSpeech(text: string, options: TtsSynthesisOptions): Promise<Response> {
    const base = { model: this.side.model, input: text, voice: options.voice ?? this.side.voice, speed: options.speed ?? this.side.speed };
    const request = (format: string): SpeechRequest => ({
      url: endpoint(this.side, "speech"), key: this.#key, body: { ...base, response_format: format }, signal: options.signal, who: "the speech server",
    });
    try {
      return await postSpeech(request("pcm"));
    } catch (error) {
      if (!formatNotSupported(error)) throw error;
      return postSpeech(request("wav"));
    }
  }

  /** Raw PCM streams through; a WAV (asked for, or sent anyway) is read whole and unwrapped; MP3 is refused. */
  private async *audioFrom(response: Response): AsyncGenerator<Buffer> {
    if (/mpeg|mp3/i.test(response.headers.get("content-type") ?? "")) throw new Error(MP3_ONLY);
    const chunks = pcmChunks(response);
    const first = await chunks.next();
    if (first.done) return;
    if (looksLikeMp3(first.value)) throw new Error(MP3_ONLY);
    if (first.value.toString("ascii", 0, 4) !== "RIFF") {
      yield first.value;
      yield* chunks;
      return;
    }
    const parts = [first.value];
    for await (const part of chunks) parts.push(part);
    const wav = parseWav(Buffer.concat(parts));
    if ("error" in wav) throw new Error(`the speech server's audio is unusable: ${wav.error}`);
    yield resamplePcm16(wav.pcm, wav.sampleRate, TTS_RATE);
  }
}
