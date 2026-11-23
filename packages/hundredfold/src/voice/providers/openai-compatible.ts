/**
 * Providers for a self-hosted server that speaks the OpenAI audio API shape
 * (specs/009-voice-mode/contracts/providers.md, `openai-compatible` row):
 * `POST {baseUrl}/v1/audio/transcriptions` with the whole utterance as a WAV (batch, so no
 * partials; it asks for `verbose_json`, whose segments say how sure the model was, and falls back to `json`
 * for a server that refuses that), and `POST {baseUrl}/v1/audio/speech` asking for `pcm`, then `wav`; a server
 * that can only return MP3 is refused with a message that says so. The key is optional.
 */
import { resolveEnvVar } from "../../shared/env-ref.js";
import { logger } from "../../shared/logger.js";
import type { ResolvedVoiceSide } from "../../shared/voice-config.js";
import type { SttEvent, SttProvider, SttQuality, SttStream, SttStreamOptions, TtsProvider, TtsSynthesisOptions, VoiceProviderStatus } from "../provider.js";
import { iso6391, looksLikeMp3, looksLikeOggOrFlac, mp3SniffBytes, parseWav, redact, resamplePcm16, toWav } from "./audio.js";
import { pcmChunks, postSpeech, SpeechHttpError, type SpeechRequest } from "./speech-http.js";

const TTS_RATE = 24_000;
/** Content types that name raw PCM (OpenAI and most compatible servers send `audio/pcm` for `response_format: "pcm"`). */
const RAW_PCM_TYPE = /^\s*audio\/(pcm|l16|x-pcm|raw)\b/i;
const MP3_ONLY = "the server only returns MP3, which voice mode cannot play; configure it to return PCM or WAV";
const COMPRESSED = "the server returns compressed audio (Ogg or FLAC), which voice mode cannot play; configure it to return PCM or WAV";

function endpoint(side: ResolvedVoiceSide, tail: string): string {
  return `${side.baseUrl ?? ""}/v1/audio/${tail}`;
}

/** A configured key that resolves to nothing is a mistake worth saying; no key at all is fine. */
function keyProblem(side: ResolvedVoiceSide, key: string | undefined): VoiceProviderStatus {
  if (side.apiKeyRef && !key) return { available: false, reason: `API key not set: ${side.apiKeyRef.replace(/^\$\{|\}$/g, "")}` };
  return { available: true };
}

/** Whether the server takes `verbose_json`; cleared for good once it refuses it, so only the first utterance pays for the retry. */
interface ReplyFormat { verbose: boolean }

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * What a `verbose_json` reply says about itself: the exponent of the length-weighted mean `avg_logprob` of its segments, and
 * the highest `no_speech_prob`. A server that sends neither (or plain `json`) gives `undefined` and nothing is filtered on it.
 */
export function qualityOf(reply: { segments?: unknown }): SttQuality | undefined {
  if (!Array.isArray(reply.segments)) return undefined;
  const segments = reply.segments.filter((raw): raw is Record<string, unknown> => typeof raw === "object" && raw !== null);
  const logprobs = segments.filter((segment) => finite(segment.avg_logprob));
  // A segment's share is its length in seconds; one with no usable length counts as one.
  const share = (segment: Record<string, unknown>): number => (finite(segment.start) && finite(segment.end) && segment.end > segment.start ? segment.end - segment.start : 1);
  const weight = logprobs.reduce((sum, segment) => sum + share(segment), 0);
  const noSpeech = segments.map((segment) => segment.no_speech_prob).filter(finite);
  const quality: SttQuality = {};
  if (weight > 0) quality.confidence = clamp01(Math.exp(logprobs.reduce((sum, segment) => sum + (segment.avg_logprob as number) * share(segment), 0) / weight));
  if (noSpeech.length > 0) quality.noSpeechProb = clamp01(Math.max(...noSpeech));
  return quality.confidence === undefined && quality.noSpeechProb === undefined ? undefined : quality;
}

export class OpenAiCompatibleSttProvider implements SttProvider {
  readonly id = "openai-compatible";
  readonly partials = false;
  readonly #key: string | undefined;
  private readonly format: ReplyFormat = { verbose: true };

  constructor(private readonly side: ResolvedVoiceSide, env: NodeJS.ProcessEnv = process.env) {
    this.#key = resolveEnvVar(side.apiKeyRef ?? undefined, env);
  }

  status(): VoiceProviderStatus {
    return keyProblem(this.side, this.#key);
  }

  open(options: SttStreamOptions): SttStream {
    return new BatchSttStream(this.side, this.#key, options, this.status(), this.format);
  }
}

class BatchSttStream implements SttStream {
  private readonly handlers: Array<(event: SttEvent) => void> = [];
  private readonly controller = new AbortController();
  private chunks: Buffer[] = [];
  private settled = false;

  readonly #key: string | undefined;

  constructor(private readonly side: ResolvedVoiceSide, key: string | undefined, private readonly options: SttStreamOptions, status: VoiceProviderStatus, private readonly format: ReplyFormat) {
    this.#key = key;
    options.signal.addEventListener("abort", () => this.abort(), { once: true });
    if (options.signal.aborted) this.abort();
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
      ({ text, quality }) => this.settle({ type: "final", text, ...(quality ? { quality } : {}) }),
      (error: unknown) => this.settle({ type: "error", message: redact(error instanceof Error ? error.message : String(error), [this.#key]) }),
    );
  }

  private async transcribe(pcm: Buffer): Promise<{ text: string; quality?: SttQuality }> {
    const verbose = this.format.verbose;
    const first = await this.ask(pcm, verbose);
    // A reply to `verbose_json` that cannot be read (plain text sent back with a 200) is asked for again as `json`, for this utterance only.
    const reply = (await readReply(first.response)) ?? (first.verbose ? await readReply(await this.requestOk(pcm, false)) : null);
    if (!reply || typeof reply.text !== "string") throw new Error("transcription reply had no text");
    const quality = first.verbose ? qualityOf(reply) : undefined;
    return { text: reply.text.trim(), ...(quality ? { quality } : {}) };
  }

  /**
   * One request, asking for `verbose_json` while the server takes it. A server that does not know it answers 4xx (not about
   * credentials or rate): ask again for plain `json` for this utterance. Stop asking for the other kind for good only if that
   * works and the status is one an unknown format gets: any other 4xx (a model still warming up, a timeout, a conflict) is
   * transient and must not turn the quality filters off.
   */
  private async ask(pcm: Buffer, verbose: boolean): Promise<{ response: Response; verbose: boolean }> {
    const response = await this.request(pcm, verbose);
    if (!verbose || !formatRefused(response.status)) {
      if (!response.ok) throw new Error(`transcription failed (HTTP ${response.status})`);
      return { response, verbose };
    }
    const plain = await this.request(pcm, false);
    if (!plain.ok) throw new Error(`transcription failed (HTTP ${plain.status})`);
    if (formatUnknown(response.status)) {
      this.format.verbose = false;
      logger.info(`[voice] the speech-to-text server refused verbose_json (HTTP ${response.status}); using plain json, so the confidence and no-speech filters do not apply`);
    }
    return { response: plain, verbose: false };
  }

  private async requestOk(pcm: Buffer, verbose: boolean): Promise<Response> {
    const response = await this.request(pcm, verbose);
    if (!response.ok) throw new Error(`transcription failed (HTTP ${response.status})`);
    return response;
  }

  private request(pcm: Buffer, verbose: boolean): Promise<Response> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(toWav(pcm, this.options.sampleRate))], { type: "audio/wav" }), "audio.wav");
    form.append("model", this.side.model);
    form.append("response_format", verbose ? "verbose_json" : "json");
    const language = iso6391(this.options.language);
    if (language) form.append("language", language);
    const headers: Record<string, string> = this.#key ? { Authorization: `Bearer ${this.#key}` } : {};
    return fetch(endpoint(this.side, "transcriptions"), { method: "POST", headers, body: form, signal: this.controller.signal });
  }

  private settle(event: SttEvent): void {
    if (this.settled) return;
    this.settled = true;
    for (const handler of this.handlers) handler(event);
  }
}

async function readReply(response: Response): Promise<{ text?: unknown; segments?: unknown } | null> {
  try {
    return (await response.json()) as { text?: unknown; segments?: unknown };
  } catch {
    return null;
  }
}

/** A 4xx that is not about credentials or rate: the server did not like `response_format`. */
function formatRefused(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 429].includes(status);
}

/** The statuses a server gives for a `response_format` it does not know: bad request, unsupported media type, unprocessable. */
function formatUnknown(status: number): boolean {
  return status === 400 || status === 415 || status === 422;
}

function formatNotSupported(error: unknown): boolean {
  return error instanceof SpeechHttpError && formatRefused(error.status);
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

  /** Raw PCM streams through; a WAV (asked for, or sent anyway) is read whole and unwrapped; MP3, Ogg and FLAC are refused. */
  private async *audioFrom(response: Response): AsyncGenerator<Buffer> {
    const contentType = response.headers.get("content-type") ?? "";
    if (/mpeg|mp3/i.test(contentType)) throw new Error(MP3_ONLY);
    const chunks = pcmChunks(response);
    const head = await sniffHead(chunks, contentType);
    if (head.length === 0) return;
    if (head.toString("ascii", 0, 4) !== "RIFF") {
      yield head;
      yield* chunks;
      return;
    }
    const parts = [head];
    for await (const part of chunks) parts.push(part);
    const wav = parseWav(Buffer.concat(parts));
    if ("error" in wav) throw new Error(`the speech server's audio is unusable: ${wav.error}`);
    yield resamplePcm16(wav.pcm, wav.sampleRate, TTS_RATE);
  }
}

/**
 * The opening bytes of the reply, read far enough to tell what it is however the network split them, after refusing
 * MP3, Ogg and FLAC. A server that names raw PCM is believed: any byte pattern is a valid sample, so sniffing it can
 * only misfire.
 */
async function sniffHead(chunks: AsyncGenerator<Buffer>, contentType: string): Promise<Buffer> {
  let head = await readHead(chunks, 12);
  if (head.length === 0 || RAW_PCM_TYPE.test(contentType)) return head;
  if (mp3SniffBytes(head) > head.length) head = await readHead(chunks, mp3SniffBytes(head) - head.length, head);
  if (looksLikeMp3(head)) throw new Error(MP3_ONLY);
  if (looksLikeOggOrFlac(head)) throw new Error(COMPRESSED);
  return head;
}

/** At least `bytes` more bytes (or all there are) from a chunk stream, joined onto `start`, so the rest can still be read from it. */
async function readHead(chunks: AsyncGenerator<Buffer>, bytes: number, start: Buffer = Buffer.alloc(0)): Promise<Buffer> {
  const parts: Buffer[] = [start];
  let size = 0;
  while (size < bytes) {
    const next = await chunks.next();
    if (next.done) break;
    parts.push(next.value);
    size += next.value.length;
  }
  return Buffer.concat(parts);
}
