/**
 * Dictation: a finished recording turned into text by the speech-to-text provider voice mode is set up with.
 * The Notes mic, the Todo quick-capture mic and Telegram voice notes all come through here, so there is one speech
 * engine to configure. The recording is PCM16LE mono at 16 kHz; a long one is cut into segments, because a provider
 * (the local sidecar most of all) decodes a bounded stretch of audio at a time.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { resolveVoiceConfig, type ResolvedVoiceConfig } from "../shared/voice-config.js";
import type { HundredfoldConfig } from "../shared/types.js";
import type { SttProvider } from "./provider.js";
import { rms } from "./providers/energy-vad.js";
import { createSttProvider, type ProviderDeps } from "./providers/registry.js";

export const DICTATION_SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = DICTATION_SAMPLE_RATE * 2;
/** A recording of at most this long is accepted (about 20 minutes). */
export const MAX_DICTATION_BYTES = 20 * 60 * BYTES_PER_SECOND;
/** A segment is about this long; the cut moves to the quietest moment in the last `CUT_WINDOW_SECONDS` of it. */
const SEGMENT_SECONDS = 60;
const CUT_WINDOW_SECONDS = 10;
const FRAME_BYTES = 320 * 2; // 20 ms

/** An error whose message is fit to show the person who dictated (not a provider's own text, which may name internals). */
export class DictationError extends Error {}

/** Why dictation cannot run now, or null when it can. It runs on voice mode's speech-to-text provider, so voice must be set up. */
export function dictationUnavailableReason(config: { voice?: unknown }, deps: ProviderDeps = {}): string | null {
  const resolved = resolveVoiceConfig(config);
  if (!resolved) return "Dictation uses voice mode's speech engine; turn voice mode on in Settings first";
  const status = createSttProvider(resolved, deps).status();
  return status.available ? null : `Dictation uses voice mode's speech engine, which is not ready: ${status.reason ?? "unavailable"}`;
}

/** Cut a recording into segments of about a minute, each cut where the audio is quietest so a word is rarely split. */
export function splitAtSilence(pcm: Buffer): Buffer[] {
  const segmentBytes = SEGMENT_SECONDS * BYTES_PER_SECOND;
  const windowBytes = CUT_WINDOW_SECONDS * BYTES_PER_SECOND;
  const segments: Buffer[] = [];
  let start = 0;
  while (pcm.length - start > segmentBytes) {
    const from = start + segmentBytes - windowBytes;
    let cut = start + segmentBytes;
    let quietest = Infinity;
    for (let offset = from; offset + FRAME_BYTES <= start + segmentBytes; offset += FRAME_BYTES) {
      const level = rms(pcm.subarray(offset, offset + FRAME_BYTES));
      if (level < quietest) {
        quietest = level;
        cut = offset + FRAME_BYTES;
      }
    }
    segments.push(pcm.subarray(start, cut));
    start = cut;
  }
  if (pcm.length > start) segments.push(pcm.subarray(start));
  return segments;
}

/** One segment through the provider: its `final`, or its error as a thrown message. */
function transcribeSegment(stt: SttProvider, pcm: Buffer, language: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = stt.open({ language, sampleRate: DICTATION_SAMPLE_RATE, signal });
    const onAbort = () => { stream.abort(); reject(new Error("Transcription was cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
    stream.on((event) => {
      if (event.type === "partial") return;
      signal.removeEventListener("abort", onAbort);
      if (event.type === "final") resolve(event.text);
      else reject(new Error(event.message));
    });
    if (signal.aborted) return onAbort();
    stream.write(pcm);
    stream.end();
  });
}

/** The text of a recording. Segments go one after another: the local sidecar decodes one at a time. */
export async function transcribePcm(stt: SttProvider, pcm: Buffer, options: { language: string; signal?: AbortSignal }): Promise<string> {
  const signal = options.signal ?? new AbortController().signal;
  const parts: string[] = [];
  for (const segment of splitAtSilence(pcm)) {
    const text = (await transcribeSegment(stt, segment, options.language, signal)).trim();
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

const execFileAsync = promisify(execFile);

/**
 * An audio file of any common format as 16 kHz mono PCM16LE, through `ffmpeg`. Only Telegram voice notes (Ogg/Opus)
 * come as a file; the browser sends PCM already. `ffmpeg` is an optional dependency for that one use.
 */
export async function decodeAudioFile(filePath: string): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-v", "error", "-i", filePath, "-f", "s16le", "-ar", String(DICTATION_SAMPLE_RATE), "-ac", "1", "-"], {
      encoding: "buffer",
      maxBuffer: MAX_DICTATION_BYTES + BYTES_PER_SECOND,
      timeout: 2 * 60 * 1000,
      env: buildEngineChildEnv(process.env),
    });
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DictationError("ffmpeg is not installed, so this audio cannot be decoded");
    throw new DictationError(`The audio could not be decoded: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

let configGetter: (() => HundredfoldConfig) | null = null;

/** The gateway tells dictation where the live config is, for the callers (Telegram) that have no request to read it from. */
export function setDictationConfig(getter: (() => HundredfoldConfig) | null): void {
  configGetter = getter;
}

/** Why dictation cannot run on the live config, or null; for callers that look before they fetch the audio. */
export function liveDictationUnavailableReason(deps: ProviderDeps = {}): string | null {
  const config = configGetter?.();
  return config ? dictationUnavailableReason(config, deps) : "Dictation is not available yet";
}

/** Transcribe an audio file with the live voice config. Throws a message fit to show a person. */
export async function transcribeAudioFile(filePath: string, deps: ProviderDeps = {}): Promise<string> {
  const config = configGetter?.();
  if (!config) throw new DictationError("Dictation is not available yet");
  const resolved: ResolvedVoiceConfig | null = resolveVoiceConfig(config);
  const reason = dictationUnavailableReason(config, deps);
  if (!resolved || reason) throw new DictationError(reason ?? "voice mode is not turned on");
  const pcm = await decodeAudioFile(filePath);
  if (pcm.length > MAX_DICTATION_BYTES) throw new DictationError("The recording is too long to transcribe");
  return transcribePcm(createSttProvider(resolved, deps), pcm, { language: resolved.language });
}
