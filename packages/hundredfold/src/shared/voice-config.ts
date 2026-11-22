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
import { HUNDREDFOLD_HOME } from "./paths.js";
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
  /** Playback speed multiplier, 0.5 to 2. Defaults to 1. */
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
    /** Silence that ends an utterance. Defaults to 700. */
    silenceMs?: number;
    /** Audio kept from before speech started. Defaults to 300. */
    prerollMs?: number;
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
  /** Inline voice prompt; replaces the built-in one. */
  prompt?: string;
  /** Instance-relative file holding the voice prompt. `prompt` wins when both are set. */
  promptFile?: string;
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

/** Spoken-conversation instructions sent with the first voice turn (contracts/voice-config.md). */
export const DEFAULT_VOICE_PROMPT =
  "You are in a spoken conversation. Your replies are converted to speech. Answer in short, natural sentences and lead with the answer. " +
  "Never read out code, logs, tables, paths or URLs: put them in the chat and say you have. Summarise rather than recite. " +
  "Before work that takes more than a moment, say in one sentence what you are about to do. " +
  "If the user interrupts you, drop the old thread and answer what they just said.";

/** The one-line reminder that rides on every later voice turn. */
export const VOICE_TURN_REMINDER = "[Voice: spoken reply. Short, plain sentences; no markdown or code read aloud.]";

export const DEFAULT_HOLDING_LINE = "Still working on the last thing. I'll come to that as soon as it's done.";

/** Per provider: the model and voice used when the config names none. */
export const VOICE_PROVIDER_DEFAULTS: Record<VoiceProviderId, { sttModel: string; ttsModel: string; ttsVoice: string }> = {
  local: { sttModel: "parakeet-tdt-0.6b-v2", ttsModel: "kokoro-v1.0", ttsVoice: "af_heart" },
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
  vad: { threshold: number; minSpeechMs: number; silenceMs: number; prerollMs: number };
  bargeIn: { enabled: boolean; minSpeechMs: number; onsetThreshold: number };
  autoBackground: { enabled: boolean; afterSeconds: number };
  /** The inline prompt, or the built-in one. */
  prompt: string;
  /** Absolute path of the prompt file, only when no inline `prompt` is set. */
  promptFile: string | null;
  holdingLine: string;
  limits: { maxUtteranceSeconds: number; maxConcurrentAttachments: number };
  local: { device: "auto" | "gpu" | "cpu" };
}

const MODES = ["hands-free", "push-to-talk"];
const DEVICES = ["auto", "gpu", "cpu"];
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/;
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const MAX_PROMPT_CHARS = 8000;
const MAX_HOLDING_LINE_CHARS = 300;

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
    return url.protocol === "http:" || url.protocol === "https:" ? [] : [`${key} must be an http or https URL (got ${url.protocol.replace(":", "")})`];
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
  return [...nonEmptyString("voice.tts.voice", tts.voice), ...inRange("voice.tts.speed", tts.speed, [0.5, 2], false)];
}

function vadProblems(vad: Obj | undefined): string[] {
  if (!vad) return [];
  return [
    ...inRange("voice.vad.threshold", vad.threshold, [0, 1], false),
    ...inRange("voice.vad.minSpeechMs", vad.minSpeechMs, [50, 2000], true),
    ...inRange("voice.vad.silenceMs", vad.silenceMs, [200, 5000], true),
    ...inRange("voice.vad.prerollMs", vad.prerollMs, [0, 1000], true),
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
    ...inRange("voice.limits.maxUtteranceSeconds", limits.maxUtteranceSeconds, [5, 600], true),
    ...inRange("voice.limits.maxConcurrentAttachments", limits.maxConcurrentAttachments, [1, 64], true),
  ];
}

function autoBackgroundProblems(autoBackground: Obj | undefined): string[] {
  if (!autoBackground) return [];
  return [...boolean("voice.autoBackground.enabled", autoBackground.enabled), ...inRange("voice.autoBackground.afterSeconds", autoBackground.afterSeconds, [1, 600], false)];
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
 * exists. `home` is the instance home `promptFile` must stay inside.
 */
export function voiceConfigProblems(voice: unknown, home: string = HUNDREDFOLD_HOME): string[] {
  if (voice === undefined || voice === null) return [];
  if (!isObject(voice)) return [`voice must be a mapping (got ${typeName(voice)})`];
  const stt = sideProblems("voice.stt", voice.stt);
  const tts = sideProblems("voice.tts", voice.tts);
  const parts = {
    vad: block("voice.vad", voice.vad), bargeIn: block("voice.bargeIn", voice.bargeIn), autoBackground: block("voice.autoBackground", voice.autoBackground),
    limits: block("voice.limits", voice.limits), local: block("voice.local", voice.local),
  };
  return [
    ...boolean("voice.enabled", voice.enabled),
    ...oneOf("voice.mode", voice.mode, MODES),
    ...languageProblems(voice.language, [stt.side?.provider ?? "local", tts.side?.provider ?? "local"]),
    ...stt.problems, ...tts.problems, ...ttsProblems(tts.side),
    ...vadProblems(parts.vad.value), ...bargeInProblems(parts.bargeIn.value), ...autoBackgroundProblems(parts.autoBackground.value),
    ...textProblems("voice.prompt", voice.prompt, MAX_PROMPT_CHARS), ...promptFileProblems(voice.promptFile, home),
    ...textProblems("voice.holdingLine", voice.holdingLine, MAX_HOLDING_LINE_CHARS),
    ...limitsProblems(parts.limits.value), ...oneOf("voice.local.device", parts.local.value?.device, DEVICES),
    ...Object.values(parts).flatMap((part) => part.problems),
  ];
}

function resolveSide(raw: Obj | undefined, kind: "stt" | "tts"): ResolvedVoiceSide {
  const provider = (raw?.provider as VoiceProviderId | undefined) ?? "local";
  const defaults = VOICE_PROVIDER_DEFAULTS[provider];
  return {
    provider,
    model: (raw?.model as string | undefined) ?? (kind === "stt" ? defaults.sttModel : defaults.ttsModel),
    baseUrl: provider === "openai-compatible" ? ((raw?.baseUrl as string | undefined)?.replace(/\/+$/, "") ?? null) : null,
    apiKeyRef: (raw?.apiKey as string | undefined) ?? null,
  };
}

const sub = (parent: Obj, key: string): Obj => (isObject(parent[key]) ? (parent[key] as Obj) : {});

function resolveTts(voice: Obj): ResolvedVoiceConfig["tts"] {
  const tts = sub(voice, "tts");
  const side = resolveSide(tts, "tts");
  return { ...side, voice: (tts.voice as string | undefined) ?? VOICE_PROVIDER_DEFAULTS[side.provider].ttsVoice, speed: (tts.speed as number | undefined) ?? 1 };
}

function resolveTuning(voice: Obj): Pick<ResolvedVoiceConfig, "vad" | "bargeIn" | "autoBackground" | "limits" | "local"> {
  const vad = sub(voice, "vad");
  const bargeIn = sub(voice, "bargeIn");
  const autoBackground = sub(voice, "autoBackground");
  const limits = sub(voice, "limits");
  const local = sub(voice, "local");
  return {
    vad: {
      threshold: (vad.threshold as number | undefined) ?? 0.5, minSpeechMs: (vad.minSpeechMs as number | undefined) ?? 250,
      silenceMs: (vad.silenceMs as number | undefined) ?? 700, prerollMs: (vad.prerollMs as number | undefined) ?? 300,
    },
    bargeIn: {
      enabled: (bargeIn.enabled as boolean | undefined) ?? true, minSpeechMs: (bargeIn.minSpeechMs as number | undefined) ?? 250,
      onsetThreshold: (bargeIn.onsetThreshold as number | undefined) ?? 0.02,
    },
    autoBackground: { enabled: (autoBackground.enabled as boolean | undefined) ?? true, afterSeconds: (autoBackground.afterSeconds as number | undefined) ?? 5 },
    limits: {
      maxUtteranceSeconds: (limits.maxUtteranceSeconds as number | undefined) ?? 60,
      maxConcurrentAttachments: (limits.maxConcurrentAttachments as number | undefined) ?? 4,
    },
    local: { device: (local.device as ResolvedVoiceConfig["local"]["device"] | undefined) ?? "auto" },
  };
}

/**
 * The effective voice settings, or null when voice is off: absent, not `enabled: true`, or
 * the block has problems (the config loader refuses those, so this is the belt to its braces).
 */
export function resolveVoiceConfig(config: { voice?: unknown }, home: string = HUNDREDFOLD_HOME): ResolvedVoiceConfig | null {
  const voice = config.voice;
  if (!isObject(voice) || voice.enabled !== true || voiceConfigProblems(voice, home).length > 0) return null;
  const inlinePrompt = typeof voice.prompt === "string" && voice.prompt !== "" ? voice.prompt : null;
  return {
    mode: (voice.mode as ResolvedVoiceConfig["mode"] | undefined) ?? "hands-free",
    language: (voice.language as string | undefined) ?? "en",
    stt: resolveSide(sub(voice, "stt"), "stt"),
    tts: resolveTts(voice),
    ...resolveTuning(voice),
    prompt: inlinePrompt ?? DEFAULT_VOICE_PROMPT,
    promptFile: inlinePrompt === null && typeof voice.promptFile === "string" ? resolvePromptFile(voice.promptFile, home) : null,
    holdingLine: (voice.holdingLine as string | undefined) ?? DEFAULT_HOLDING_LINE,
  };
}
