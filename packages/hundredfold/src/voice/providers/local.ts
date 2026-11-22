/**
 * The built-in speech providers: Parakeet (STT), Kokoro (TTS) and Silero (VAD), all through
 * the one speech sidecar (specs/009-voice-mode/contracts/providers.md, `local` row).
 */
import { randomUUID } from "node:crypto";
import type { ResolvedVoiceConfig } from "../../shared/voice-config.js";
import type { SttEvent, SttProvider, SttStream, SttStreamOptions, TtsProvider, TtsSynthesisOptions, VadStream, VoiceProviderStatus } from "../provider.js";
import { MAX_BODY_BYTES } from "../sidecar/framing.js";
import type { SpeechInstaller } from "../sidecar/bootstrap.js";
import type { SpeechSidecarClient } from "../sidecar/client.js";

/** What the local providers share: the sidecar process and its install. */
export interface LocalSpeech {
  client: SpeechSidecarClient;
  installer: SpeechInstaller;
}

/** Partials are re-decodes of the growing utterance, at most this often (research R3). */
export const PARTIAL_EVERY_MS = 400;
const SAMPLE_RATE = 16_000;
/** The sidecar takes a body of at most 4 MB; the whole utterance goes in each decode. */
export const MAX_LOCAL_UTTERANCE_BYTES = MAX_BODY_BYTES;
export const MAX_LOCAL_UTTERANCE_SECONDS = Math.floor(MAX_LOCAL_UTTERANCE_BYTES / (SAMPLE_RATE * 2));

/** Why local speech cannot be used right now, or `available: true`. */
export function localStatus(local: LocalSpeech): VoiceProviderStatus {
  const install = local.installer.status();
  if (install.state === "installing") return { available: false, reason: "Local speech is installing" };
  if (install.state === "failed") return { available: false, reason: `Local speech install failed: ${install.reason ?? "unknown error"}` };
  if (install.state !== "ready") return { available: false, reason: "Local speech is not installed yet; install it from the voice settings or POST /api/voice/install" };
  return local.client.status();
}

export class LocalSttProvider implements SttProvider {
  readonly id = "local";
  readonly partials = true;

  constructor(private readonly local: LocalSpeech) {}

  status(): VoiceProviderStatus {
    return localStatus(this.local);
  }

  open(options: SttStreamOptions): SttStream {
    return new LocalSttStream(this.local, options, this.status());
  }

  close(): void {
    this.local.client.close();
  }
}

class LocalSttStream implements SttStream {
  private readonly handlers: Array<(event: SttEvent) => void> = [];
  private readonly utterance = randomUUID();
  private chunks: Buffer[] = [];
  private bytes = 0;
  private decodedBytes = 0;
  private busy = false;
  private done = false;
  private settled = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly local: LocalSpeech, options: SttStreamOptions, status: VoiceProviderStatus) {
    if (!status.available) {
      queueMicrotask(() => this.finish({ type: "error", message: status.reason ?? "local speech is not available" }));
      return;
    }
    options.signal.addEventListener("abort", () => this.abort(), { once: true });
    if (options.signal.aborted) this.abort();
  }

  on(handler: (event: SttEvent) => void): void {
    this.handlers.push(handler);
  }

  write(pcm: Buffer): void {
    if (this.done) return;
    if (this.bytes + pcm.length > MAX_LOCAL_UTTERANCE_BYTES) {
      this.finish({ type: "error", message: `the utterance is too long for local speech (limit about ${MAX_LOCAL_UTTERANCE_SECONDS} s)` });
      return;
    }
    this.chunks.push(pcm);
    this.bytes += pcm.length;
    this.timer ??= setInterval(() => void this.partial(), PARTIAL_EVERY_MS);
    this.timer.unref();
  }

  end(): void {
    if (this.done) return;
    this.stopTimer();
    this.done = true; // no partial may follow the final
    void this.local.client
      .transcribe("final", this.ids(), Buffer.concat(this.chunks))
      .then((text) => this.settle({ type: "final", text }), (error: unknown) => this.settle({ type: "error", message: errorText(error) }));
  }

  abort(): void {
    if (this.settled) return;
    this.settled = true;
    this.done = true;
    this.stopTimer();
    this.handlers.length = 0;
    this.local.client.cancelUtterance(this.utterance);
  }

  /** A partial: skipped while the last decode is still running or nothing new has arrived. */
  private async partial(): Promise<void> {
    if (this.busy || this.done || this.bytes === this.decodedBytes) return;
    this.busy = true;
    this.decodedBytes = this.bytes;
    try {
      const text = await this.local.client.transcribe("partial", this.ids(), Buffer.concat(this.chunks));
      if (!this.done) this.emit({ type: "partial", text });
    } catch {
      // a failed partial costs nothing: the final decides
    } finally {
      this.busy = false;
    }
  }

  private ids(): { stream: string; utterance: string } {
    return { stream: this.utterance, utterance: this.utterance };
  }

  private finish(event: SttEvent): void {
    this.done = true;
    this.stopTimer();
    this.settle(event);
  }

  /** The one `final` or `error` of the utterance. */
  private settle(event: SttEvent): void {
    if (this.settled) return;
    this.settled = true;
    this.emit(event);
  }

  private emit(event: SttEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export class LocalTtsProvider implements TtsProvider {
  readonly id = "local";
  readonly sampleRate = 24_000;

  constructor(private readonly local: LocalSpeech, private readonly resolved: Pick<ResolvedVoiceConfig["tts"], "voice" | "speed">) {}

  get defaultVoice(): string {
    return this.resolved.voice;
  }

  status(): VoiceProviderStatus {
    return localStatus(this.local);
  }

  async *synthesize(text: string, options: TtsSynthesisOptions): AsyncGenerator<Buffer> {
    const status = this.status();
    if (!status.available) throw new Error(status.reason ?? "local speech is not available");
    const request = { text, voice: options.voice ?? this.defaultVoice, speed: options.speed ?? this.resolved.speed, lang: options.language };
    for await (const chunk of this.local.client.synthesize(randomUUID(), request, options.signal)) yield chunk.pcm;
  }

  close(): void {
    this.local.client.close();
  }
}

/** The sidecar's Silero VAD as a `VadStream`. */
export function openLocalVad(local: LocalSpeech, vad: ResolvedVoiceConfig["vad"]): VadStream {
  return local.client.vad(randomUUID(), vad);
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
