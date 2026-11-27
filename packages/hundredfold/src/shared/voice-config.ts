/**
 * `voice`: voice mode, a spoken conversation with a chat session (speech to
 * text, then the session's own engine, then text to speech), all through the
 * gateway. Off unless `enabled` is true. Contract with every default and range:
 * specs/009-voice-mode/contracts/voice-config.md.
 *
 * This module holds the type; the validator (`voiceConfigProblems`) and the
 * defaults resolver (`resolveVoiceConfig`) live beside it.
 */
import path from "node:path";
import { VOICE_SPEED_DEFAULT, VOICE_SPEED_MAX, VOICE_SPEED_MIN } from "./gateway-events.js";
import { HUNDREDFOLD_HOME } from "./paths.js";
import { logger } from "./logger.js";
import { isInsidePath } from "./protected-home-entries.js";

export interface VoiceSttConfig {
  /** `local` | `openai` | `openai-compatible`. Defaults to `local`. */
  provider?: string;
  /** Provider default when absent. */
  model?: string;
  /** `openai-compatible` only: the endpoint root, without `/v1`. */
  baseUrl?: string;
  /** The provider key, as a `${ENV_VAR}` reference only; resolved on the gateway. */
  apiKey?: string;
}

export interface VoiceTtsConfig extends VoiceSttConfig {
  /** Provider default when absent; for `local`, the operator's chosen Kokoro voice. */
  voice?: string;
  /** Speaking rate multiplier for spoken replies, 0.5 to 2 (1 is natural). Defaults to 1; a change applies to the next sentence spoken, with no restart. */
  speed?: number;
}

export interface VoiceConfig {
  /** Off unless true. */
  enabled?: boolean;
  /** Defaults to `hands-free`. */
  mode?: "hands-free" | "push-to-talk";
  /** Language hint, e.g. `en`. Defaults to `en`; the local providers are English only. */
  language?: string;
  stt?: VoiceSttConfig;
  tts?: VoiceTtsConfig;
  /** The gateway's voice activity detection. */
  vad?: {
    /** Speech probability threshold, 0..1. Defaults to 0.5. */
    threshold?: number;
    /** Defaults to 250. */
    minSpeechMs?: number;
    /** Silence that ends an utterance. Defaults to 1000. */
    silenceMs?: number;
    /** Extra silence waited when the words so far look unfinished (0 turns it off). Defaults to 800. */
    unfinishedHoldMs?: number;
    /** Audio kept from before speech started. Defaults to 300. */
    prerollMs?: number;
  };
  /** What is dropped after speech to text, so noise that passed the VAD is not sent as if you had said it. */
  filter?: {
    /** Drop a transcript the provider is less sure of than this (mean token probability, 0..1; 0 turns it off). Only providers that report one. Defaults to 0.3. */
    minConfidence?: number;
    /** Drop a transcript the provider says is probably not speech, above this probability, when it reported no confidence for it (0..1; 1 turns it off). Only providers that report one. Defaults to 0.8. */
    noSpeechThreshold?: number;
    /** A clip whose speech lasted less than this (ms; 0 turns the phrase list off) whose whole transcript is one of `phantomPhrases` is dropped. Defaults to 500. */
    phantomMaxMs?: number;
    /** Words speech to text invents out of noise. Defaults to a short built-in list; `[]` turns the list off. */
    phantomPhrases?: string[];
  };
  bargeIn?: {
    /** Defaults to true. */
    enabled?: boolean;
    /** How long the client's onset level must hold before playback stops. Defaults to 250. */
    minSpeechMs?: number;
    /** RMS threshold of the client's onset detector, 0..1. Defaults to 0.02. */
    onsetThreshold?: number;
  };
  autoBackground?: {
    /** Defaults to true. */
    enabled?: boolean;
    /** A foreground tool call older than this when the user talks is long work. Defaults to 5. */
    afterSeconds?: number;
  };
  /** Soft repeating sound cues while the assistant is thinking and while a tool runs. */
  cues?: {
    /** Defaults to true. */
    enabled?: boolean;
    /** 0 (silent) to 1 (still gentle); defaults to 0.3. */
    volume?: number;
  };
  /** Inline voice prompt; replaces the built-in one. */
  prompt?: string;
  /** Instance-relative file holding the voice prompt. `prompt` wins when both are set. */
  promptFile?: string;
  /** The operator's own directions for how replies sound, added to the voice instructions on every voice turn. Empty or absent changes nothing. */
  stylePrompt?: string;
  /** Spoken, with no model turn, when an utterance must wait behind long work. */
  holdingLine?: string;
  limits?: {
    /** Defaults to 60. */
    maxUtteranceSeconds?: number;
    /** Defaults to 4. */
    maxConcurrentAttachments?: number;
  };
  /** The built-in local speech sidecar. */
  local?: {
    /** `auto` uses the GPU when one is found. Defaults to `auto`. */
    device?: "auto" | "gpu" | "cpu";
  };
}

// ── validation and defaults ─────────────────────────────────────────────────

export const VOICE_STT_PROVIDERS = ["local", "openai", "openai-compatible"] as const;
export type VoiceProviderId = (typeof VOICE_STT_PROVIDERS)[number];

/** The speech-to-text models the built-in local provider can run, as `voice.stt.model` names them. The first is the default. */
export const LOCAL_STT_MODELS = ["parakeet-tdt-0.6b-v2", "parakeet-unified-en-0.6b", "parakeet-unified-en-0.6b-streaming"] as const;
export type LocalSttModelId = (typeof LOCAL_STT_MODELS)[number];
export const DEFAULT_LOCAL_STT_MODEL: LocalSttModelId = LOCAL_STT_MODELS[0];

/** The local model a resolved config runs: `stt.model` when the local provider does the speech-to-text, else the default (the sidecar loads one regardless, for the other local halves). */
export function localSttModel(stt: { provider: string; model: string }): LocalSttModelId {
  return stt.provider === "local" && (LOCAL_STT_MODELS as readonly string[]).includes(stt.model) ? (stt.model as LocalSttModelId) : DEFAULT_LOCAL_STT_MODEL;
}

/** Spoken-conversation instructions sent with the first voice turn (contracts/voice-config.md). */
export const DEFAULT_VOICE_PROMPT =
  "You are in a spoken conversation. Your replies are converted to speech. Answer in short, natural sentences and lead with the answer. " +
  "Never read out code, logs, tables, paths or URLs: put them in the chat and say you have. Summarise rather than recite. " +
  "Before work that takes more than a moment, say in one sentence what you are about to do. " +
  "If the user interrupts you, drop the old thread and answer what they just said. " +
  "If the user clearly asks to end the call or hang up, call end_voice_call, then say a short goodbye.";

/** The one-line reminder that rides on every later voice turn. */
export const VOICE_TURN_REMINDER = "[Voice: spoken reply. Short, plain sentences; no markdown or code read aloud.]";

/** Low by default: a cue is a hint that work is going on, never something to listen to. */
export const DEFAULT_CUE_VOLUME = 0.3;

export const DEFAULT_HOLDING_LINE = "Still working on the last thing. I'll come to that as soon as it's done.";

/** Per provider: the model and voice used when the config names none. */
export const VOICE_PROVIDER_DEFAULTS: Record<VoiceProviderId, { sttModel: string; ttsModel: string; ttsVoice: string }> = {
  local: { sttModel: DEFAULT_LOCAL_STT_MODEL, ttsModel: "kokoro-v1.0", ttsVoice: "af_heart" },
  openai: { sttModel: "gpt-live-transcribe", ttsModel: "gpt-4o-mini-tts", ttsVoice: "marin" },
  "openai-compatible": { sttModel: "whisper-1", ttsModel: "tts-1", ttsVoice: "alloy" },
};

export interface ResolvedVoiceSide {
  provider: VoiceProviderId;
  model: string;
  /** `openai-compatible` endpoint root, else null. */
  baseUrl: string | null;
  /** The `${VAR}` reference as written; the key itself is read at provider construction, never held here. */
  apiKeyRef: string | null;
}

/** `voice:` with every default filled; null from `resolveVoiceConfig` means voice is off. */
export interface ResolvedVoiceConfig {
  mode: "hands-free" | "push-to-talk";
  language: string;
  stt: ResolvedVoiceSide;
  tts: ResolvedVoiceSide & { voice: string; speed: number };
  vad: { threshold: number; minSpeechMs: number; silenceMs: number; unfinishedHoldMs: number; prerollMs: number };
  filter: { minConfidence: number; noSpeechThreshold: number; phantomMaxMs: number; phantomPhrases: string[] };
  bargeIn: { enabled: boolean; minSpeechMs: number; onsetThreshold: number };
  autoBackground: { enabled: boolean; afterSeconds: number };
  cues: { enabled: boolean; volume: number };
  /** The inline prompt, or the built-in one. */
  prompt: string;
  /** Absolute path of the prompt file, only when no inline `prompt` is set. */
  promptFile: string | null;
  /** The operator's style directions, trimmed; "" when there are none. */
  stylePrompt: string;
  holdingLine: string;
  limits: { maxUtteranceSeconds: number; maxConcurrentAttachments: number };
  local: { device: "auto" | "gpu" | "cpu" };
}

/** What speech to text tends to write for a bump, a breath or a hum, none of which a person says on purpose to an assistant in under half a second. */
export const DEFAULT_PHANTOM_PHRASES: readonly string[] = ["you", "thank you", "thanks for watching", "amen", "uh", "um", "hmm", "mm", "mhm", "huh", "oh", "ah"];
const MAX_PHANTOM_PHRASES = 100;
const MAX_PHANTOM_PHRASE_CHARS = 80;
const MODES = ["hands-free", "push-to-talk"];
const DEVICES = ["auto", "gpu", "cpu"];
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/;
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const MAX_PROMPT_CHARS = 8000;
const MAX_HOLDING_LINE_CHARS = 300;
export const MAX_STYLE_PROMPT_CHARS = 2000;

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const typeName = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "an array" : typeof value);

function inRange(key: string, value: unknown, [min, max]: readonly [number, number], integer: boolean): string[] {
  if (value === undefined) return [];
  const ok = typeof value === "number" && Number.isFinite(value) && (!integer || Number.isInteger(value)) && value >= min && value <= max;
  return ok ? [] : [`${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max} (got ${JSON.stringify(value)})`];
}

function oneOf(key: string, value: unknown, allowed: readonly string[]): string[] {
  if (value === undefined) return [];
  return typeof value === "string" && allowed.includes(value) ? [] : [`${key} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`];
}

function boolean(key: string, value: unknown): string[] {
  return value === undefined || typeof value === "boolean" ? [] : [`${key} must be true or false (got ${typeName(value)})`];
}

function nonEmptyString(key: string, value: unknown): string[] {
  return value === undefined || (typeof value === "string" && value.trim() !== "") ? [] : [`${key} must be a non-empty string (got ${typeName(value)})`];
}

/** A block that must be a mapping when present; returns it, or the problem. */
function block(key: string, value: unknown): { value: Obj | undefined; problems: string[] } {
  if (value === undefined || value === null) return { value: undefined, problems: [] };
  if (!isObject(value)) return { value: undefined, problems: [`${key} must be a mapping (got ${typeName(value)})`] };
  return { value, problems: [] };
}

function baseUrlProblems(key: string, value: unknown, required: boolean): string[] {
  if (value === undefined) return required ? [`${key} is required for the openai-compatible provider`] : [];
  if (typeof value !== "string") return [`${key} must be a URL string (got ${typeName(value)})`];
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [`${key} must be an http or https URL (got ${url.protocol.replace(":", "")})`];
    return url.username || url.password ? [`${key} must not carry a user name or password; put the key in apiKey as a \${VAR} reference`] : [];
  } catch {
    return [`${key} must be a valid http or https URL`];
  }
}

function apiKeyProblems(key: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string" && ENV_REFERENCE.test(value)) return [];
  return [`${key} must be a \${VAR} reference to an environment variable, never the key itself. Put the key in the gateway's environment and write ${key}: "\${NAME}"`];
}

function providerSideProblems(prefix: string, side: Obj): string[] {
  const provider = side.provider ?? "local";
  const problems = oneOf(`${prefix}.provider`, side.provider, VOICE_STT_PROVIDERS);
  problems.push(...nonEmptyString(`${prefix}.model`, side.model), ...apiKeyProblems(`${prefix}.apiKey`, side.apiKey));
  // The local speech-to-text provider runs a fixed set of models; any other name would silently run the default.
  if (prefix === "voice.stt" && provider === "local" && typeof side.model === "string" && side.model.trim() !== "") problems.push(...oneOf(`${prefix}.model`, side.model, LOCAL_STT_MODELS));
  if (provider === "local" && side.baseUrl !== undefined) problems.push(`${prefix}.baseUrl is not used by the local provider; remove it`);
  else problems.push(...baseUrlProblems(`${prefix}.baseUrl`, side.baseUrl, provider === "openai-compatible"));
  return problems;
}

function sideProblems(prefix: string, raw: unknown): { problems: string[]; side: Obj | undefined } {
  const { value, problems } = block(prefix, raw);
  return { side: value, problems: value ? [...problems, ...providerSideProblems(prefix, value)] : problems };
}

function ttsProblems(tts: Obj | undefined): string[] {
  if (!tts) return [];
  return [...nonEmptyString("voice.tts.voice", tts.voice), ...inRange("voice.tts.speed", tts.speed, [VOICE_SPEED_MIN, VOICE_SPEED_MAX], false)];
}

function vadProblems(vad: Obj | undefined): string[] {
  if (!vad) return [];
  return [
    ...inRange("voice.vad.threshold", vad.threshold, [0, 1], false),
    ...inRange("voice.vad.minSpeechMs", vad.minSpeechMs, [50, 2000], true),
    ...inRange("voice.vad.silenceMs", vad.silenceMs, [200, 5000], true),
    ...inRange("voice.vad.unfinishedHoldMs", vad.unfinishedHoldMs, [0, 5000], true),
    ...inRange("voice.vad.prerollMs", vad.prerollMs, [0, 1000], true),
  ];
}

function phantomPhraseProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`voice.filter.phantomPhrases must be a list of words (got ${typeName(value)})`];
  if (value.length > MAX_PHANTOM_PHRASES) return [`voice.filter.phantomPhrases must have at most ${MAX_PHANTOM_PHRASES} entries (got ${value.length})`];
  const bad = value.findIndex((entry) => typeof entry !== "string" || entry.trim() === "" || entry.length > MAX_PHANTOM_PHRASE_CHARS);
  return bad < 0 ? [] : [`voice.filter.phantomPhrases[${bad}] must be a non-empty string of at most ${MAX_PHANTOM_PHRASE_CHARS} characters`];
}

function filterProblems(filter: Obj | undefined): string[] {
  if (!filter) return [];
  return [
    ...inRange("voice.filter.minConfidence", filter.minConfidence, [0, 1], false),
    ...inRange("voice.filter.noSpeechThreshold", filter.noSpeechThreshold, [0, 1], false),
    ...inRange("voice.filter.phantomMaxMs", filter.phantomMaxMs, [0, 5000], true),
    ...phantomPhraseProblems(filter.phantomPhrases),
  ];
}

function bargeInProblems(bargeIn: Obj | undefined): string[] {
  if (!bargeIn) return [];
  return [
    ...boolean("voice.bargeIn.enabled", bargeIn.enabled),
    ...inRange("voice.bargeIn.minSpeechMs", bargeIn.minSpeechMs, [50, 2000], true),
    ...inRange("voice.bargeIn.onsetThreshold", bargeIn.onsetThreshold, [0, 1], false),
  ];
}

function textProblems(key: string, value: unknown, max: number): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") return [`${key} must be a string (got ${typeName(value)})`];
  return value.length <= max ? [] : [`${key} must be at most ${max} characters (got ${value.length})`];
}

/** `promptFile` is read from the instance, so it never names anything outside the home. */
export function resolvePromptFile(promptFile: string, home: string): string | null {
  if (path.isAbsolute(promptFile)) return null;
  const resolved = path.resolve(home, promptFile);
  return isInsidePath(resolved, home) && resolved !== path.resolve(home) ? resolved : null;
}

function promptFileProblems(promptFile: unknown, home: string): string[] {
  if (promptFile === undefined) return [];
  if (typeof promptFile !== "string" || promptFile.trim() === "") return [`voice.promptFile must be a non-empty instance-relative path (got ${typeName(promptFile)})`];
  return resolvePromptFile(promptFile, home) ? [] : ["voice.promptFile must be a relative path that stays inside the instance home"];
}

function limitsProblems(limits: Obj | undefined): string[] {
  if (!limits) return [];
  return [
    ...inRange("voice.limits.maxUtteranceSeconds", limits.maxUtteranceSeconds, [5, 120], true),
    ...inRange("voice.limits.maxConcurrentAttachments", limits.maxConcurrentAttachments, [1, 64], true),
  ];
}

function autoBackgroundProblems(autoBackground: Obj | undefined): string[] {
  if (!autoBackground) return [];
  return [...boolean("voice.autoBackground.enabled", autoBackground.enabled), ...inRange("voice.autoBackground.afterSeconds", autoBackground.afterSeconds, [1, 600], false)];
}

function cuesProblems(cues: Obj | undefined): string[] {
  if (!cues) return [];
  return [...boolean("voice.cues.enabled", cues.enabled), ...inRange("voice.cues.volume", cues.volume, [0, 1], false)];
}

function languageProblems(language: unknown, providers: unknown[]): string[] {
  if (language === undefined) return [];
  if (typeof language !== "string" || !LANGUAGE.test(language)) return [`voice.language must be a language code such as "en" (got ${JSON.stringify(language)})`];
  if (providers.includes("local") && !/^en(-|$)/.test(language)) {
    return [`voice.language "${language}" is not supported by the local provider, which speaks English only; use an English code or switch stt.provider and tts.provider`];
  }
  return [];
}

/**
 * Problems with the `voice` block, each naming its key. Voice stays off while any
 * exists; they are not part of `validateConfigShape`, so a bad block never stops the
 * gateway starting or a reload (see `voiceOffReason`). `home` is the instance home `promptFile` must stay inside.
 */
export function voiceConfigProblems(voice: unknown, home: string = HUNDREDFOLD_HOME): string[] {
  if (voice === undefined || voice === null) return [];
  if (!isObject(voice)) return [`voice must be a mapping (got ${typeName(voice)})`];
  const stt = sideProblems("voice.stt", voice.stt);
  const tts = sideProblems("voice.tts", voice.tts);
  const parts = {
    vad: block("voice.vad", voice.vad), filter: block("voice.filter", voice.filter), bargeIn: block("voice.bargeIn", voice.bargeIn), autoBackground: block("voice.autoBackground", voice.autoBackground),
    limits: block("voice.limits", voice.limits), local: block("voice.local", voice.local), cues: block("voice.cues", voice.cues),
  };
  return [
    ...boolean("voice.enabled", voice.enabled),
    ...oneOf("voice.mode", voice.mode, MODES),
    ...languageProblems(voice.language, [stt.side?.provider ?? "local", tts.side?.provider ?? "local"]),
    ...stt.problems, ...tts.problems, ...ttsProblems(tts.side),
    ...vadProblems(parts.vad.value), ...filterProblems(parts.filter.value), ...bargeInProblems(parts.bargeIn.value), ...autoBackgroundProblems(parts.autoBackground.value),
    ...cuesProblems(parts.cues.value),
    ...textProblems("voice.prompt", voice.prompt, MAX_PROMPT_CHARS), ...promptFileProblems(voice.promptFile, home),
    ...textProblems("voice.stylePrompt", voice.stylePrompt, MAX_STYLE_PROMPT_CHARS),
    ...textProblems("voice.holdingLine", voice.holdingLine, MAX_HOLDING_LINE_CHARS),
    ...limitsProblems(parts.limits.value), ...oneOf("voice.local.device", parts.local.value?.device, DEVICES),
    ...Object.values(parts).flatMap((part) => part.problems),
  ];
}

/** Whether the config asks for voice: anything but an object whose `enabled` is absent or `false`. A block that asks for it may still be invalid. */
export function asksForVoice(voice: unknown): boolean {
  return !(isObject(voice) && (voice.enabled === undefined || voice.enabled === false));
}

/**
 * Why voice is off though the config asks for it: the block's problems, each naming its key, or null
 * when the block is fine or voice is simply off (absent, or `enabled: false`). The text never carries a
 * key or a URL's user name: the validator's messages do not echo them.
 */
export function voiceOffReason(voice: unknown, home: string = HUNDREDFOLD_HOME): string | null {
  const problems = voiceConfigProblems(voice, home);
  if (problems.length === 0) return null;
  if (!asksForVoice(voice)) return null;
  return `Voice is off because config.yaml has problems in voice: ${problems.join("; ")}`;
}

/**
 * The environment variables the enabled voice block's `apiKey` settings name. The gateway takes them out of its own
 * environment at load (`setVoiceKeyEnv`), so no engine child inherits a provider key. Empty while the config does not
 * ask for voice, so a variable a disabled block names stays where it is. A block that asks for voice but is invalid
 * (`enabled: "yes"`) still withholds them: voice is off for that reason, not because nobody wanted it.
 */
export function voiceKeyEnvNames(voice: unknown): string[] {
  if (!isObject(voice) || !asksForVoice(voice)) return [];
  const names = [voice.stt, voice.tts].map((side) => (isObject(side) && typeof side.apiKey === "string" ? ENV_REFERENCE.exec(side.apiKey) : null));
  return [...new Set(names.flatMap((match) => (match ? [match[0].slice(2, -1)] : [])))];
}

let lastWarned = "";

/**
 * Log the voice block's problems when they change. They do not fail the config (FR-025): voice stays off
 * and the rest of the gateway carries on. `loadConfig` is polled, so one bad key must not flood the log.
 */
export function warnAboutVoiceProblems(voice: unknown): void {
  const reason = voiceOffReason(voice);
  const key = reason ?? "";
  if (key === lastWarned) return;
  lastWarned = key;
  if (reason) logger.warn(`config voice: ${reason}`);
}

const sub = (parent: Obj, key: string): Obj => (isObject(parent[key]) ? (parent[key] as Obj) : {});

/** `source[key]`, or `fallback` when the key is absent: the one place a default is applied. */
function setting<T>(source: Obj, key: string, fallback: T): T {
  return source[key] === undefined ? fallback : (source[key] as T);
}

function resolveSide(raw: Obj, kind: "stt" | "tts"): ResolvedVoiceSide {
  const provider = setting<VoiceProviderId>(raw, "provider", "local");
  const defaults = VOICE_PROVIDER_DEFAULTS[provider];
  const baseUrl = typeof raw.baseUrl === "string" && provider === "openai-compatible" ? raw.baseUrl.replace(/\/+$/, "") : null;
  return {
    provider,
    model: setting(raw, "model", kind === "stt" ? defaults.sttModel : defaults.ttsModel),
    baseUrl,
    apiKeyRef: setting<string | null>(raw, "apiKey", null),
  };
}

function resolveTts(voice: Obj): ResolvedVoiceConfig["tts"] {
  const tts = sub(voice, "tts");
  const side = resolveSide(tts, "tts");
  return { ...side, voice: setting(tts, "voice", VOICE_PROVIDER_DEFAULTS[side.provider].ttsVoice), speed: setting(tts, "speed", VOICE_SPEED_DEFAULT) };
}

function resolveVad(vad: Obj): ResolvedVoiceConfig["vad"] {
  return { threshold: setting(vad, "threshold", 0.5), minSpeechMs: setting(vad, "minSpeechMs", 250), silenceMs: setting(vad, "silenceMs", 1000), unfinishedHoldMs: setting(vad, "unfinishedHoldMs", 800), prerollMs: setting(vad, "prerollMs", 300) };
}

function resolveFilter(filter: Obj): ResolvedVoiceConfig["filter"] {
  return {
    minConfidence: setting(filter, "minConfidence", 0.3),
    noSpeechThreshold: setting(filter, "noSpeechThreshold", 0.8),
    phantomMaxMs: setting(filter, "phantomMaxMs", 500),
    phantomPhrases: setting<string[]>(filter, "phantomPhrases", [...DEFAULT_PHANTOM_PHRASES]),
  };
}

function resolveBargeIn(bargeIn: Obj): ResolvedVoiceConfig["bargeIn"] {
  return { enabled: setting(bargeIn, "enabled", true), minSpeechMs: setting(bargeIn, "minSpeechMs", 250), onsetThreshold: setting(bargeIn, "onsetThreshold", 0.02) };
}

function resolveTuning(voice: Obj): Pick<ResolvedVoiceConfig, "vad" | "filter" | "bargeIn" | "autoBackground" | "cues" | "limits" | "local"> {
  const autoBackground = sub(voice, "autoBackground");
  const limits = sub(voice, "limits");
  const cues = sub(voice, "cues");
  return {
    vad: resolveVad(sub(voice, "vad")),
    filter: resolveFilter(sub(voice, "filter")),
    bargeIn: resolveBargeIn(sub(voice, "bargeIn")),
    autoBackground: { enabled: setting(autoBackground, "enabled", true), afterSeconds: setting(autoBackground, "afterSeconds", 5) },
    cues: { enabled: setting(cues, "enabled", true), volume: setting(cues, "volume", DEFAULT_CUE_VOLUME) },
    limits: { maxUtteranceSeconds: setting(limits, "maxUtteranceSeconds", 60), maxConcurrentAttachments: setting(limits, "maxConcurrentAttachments", 4) },
    local: { device: setting(sub(voice, "local"), "device", "auto") },
  };
}

/** The operator's style directions, trimmed; "" when unset or blank. */
function resolveStylePrompt(voice: Obj): string {
  return typeof voice.stylePrompt === "string" ? voice.stylePrompt.trim() : "";
}

/**
 * The effective voice settings, or null when voice is off: absent, not `enabled: true`, or
 * the block has problems (the config loader refuses those, so this is the belt to its braces).
 */
export function resolveVoiceConfig(config: { voice?: unknown }, home: string = HUNDREDFOLD_HOME): ResolvedVoiceConfig | null {
  const voice = config.voice;
  if (!isObject(voice) || voice.enabled !== true || voiceConfigProblems(voice, home).length > 0) return null;
  const inlinePrompt = typeof voice.prompt === "string" && voice.prompt !== "" ? voice.prompt : null;
  const promptFile = inlinePrompt === null && typeof voice.promptFile === "string" ? resolvePromptFile(voice.promptFile, home) : null;
  return {
    mode: setting(voice, "mode", "hands-free"),
    language: setting(voice, "language", "en"),
    stt: resolveSide(sub(voice, "stt"), "stt"),
    tts: resolveTts(voice),
    ...resolveTuning(voice),
    prompt: inlinePrompt ?? DEFAULT_VOICE_PROMPT,
    promptFile,
    stylePrompt: resolveStylePrompt(voice),
    holdingLine: setting(voice, "holdingLine", DEFAULT_HOLDING_LINE),
  };
}
