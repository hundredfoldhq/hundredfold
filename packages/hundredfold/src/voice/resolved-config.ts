/**
 * The voice configuration the hub runs on: every default filled, no provider
 * key on it (keys are resolved from the environment inside each provider and
 * never sit on an object that could be serialised). Contract:
 * specs/009-voice-mode/contracts/voice-config.md.
 *
 * `resolveVoiceConfig` here is a MINIMAL STAND-IN with the contract's name and
 * signature, so the hub can be built before the config work lands. It fills
 * defaults and applies the `enabled` rule; it validates nothing and does not
 * read `promptFile`. When the real resolver arrives in `shared/voice-config.ts`
 * this file is deleted and its importers point there.
 */
import type { HundredfoldConfig } from "../shared/types.js";

export const DEFAULT_VOICE_PROMPT =
  "You are in a spoken conversation. Your replies are converted to speech. Answer in short, natural "
  + "sentences and lead with the answer. Never read out code, logs, tables, paths or URLs: put them in the "
  + "chat and say you have. Summarise rather than recite. Before work that takes more than a moment, say in "
  + "one sentence what you are about to do. If the user interrupts you, drop the old thread and answer what "
  + "they just said.";

export const DEFAULT_HOLDING_LINE = "Still working on the last thing. I'll come to that as soon as it's done.";

export interface ResolvedVoiceConfig {
  mode: "hands-free" | "push-to-talk";
  language: string;
  stt: { provider: string; model: string | null };
  tts: { provider: string; model: string | null; voice: string | null; speed: number };
  vad: { threshold: number; minSpeechMs: number; silenceMs: number; prerollMs: number };
  bargeIn: { enabled: boolean; minSpeechMs: number; onsetThreshold: number };
  autoBackground: { enabled: boolean; afterSeconds: number };
  prompt: string;
  holdingLine: string;
  limits: { maxUtteranceSeconds: number; maxConcurrentAttachments: number };
  local: { device: "auto" | "gpu" | "cpu" };
}

const DEFAULTS = {
  stt: { provider: "local", model: null as string | null },
  tts: { provider: "local", model: null as string | null, voice: null as string | null, speed: 1 },
  vad: { threshold: 0.5, minSpeechMs: 250, silenceMs: 700, prerollMs: 300 },
  bargeIn: { enabled: true, minSpeechMs: 250, onsetThreshold: 0.02 },
  autoBackground: { enabled: true, afterSeconds: 5 },
  limits: { maxUtteranceSeconds: 60, maxConcurrentAttachments: 4 },
  local: { device: "auto" as ResolvedVoiceConfig["local"]["device"] },
};

/** `defaults` with every value `given` actually sets laid over it. */
function section<T extends object>(defaults: T, given: Partial<Record<keyof T, unknown>> | undefined): T {
  const set = Object.entries(given ?? {}).filter(([key, value]) => value !== undefined && key in defaults);
  return { ...defaults, ...Object.fromEntries(set) };
}

/** `null` unless voice is turned on. */
export function resolveVoiceConfig(config: Pick<HundredfoldConfig, "voice">): ResolvedVoiceConfig | null {
  const voice = config.voice;
  if (voice?.enabled !== true) return null;
  return {
    mode: voice.mode ?? "hands-free",
    language: voice.language ?? "en",
    stt: section(DEFAULTS.stt, voice.stt),
    tts: section(DEFAULTS.tts, voice.tts),
    vad: section(DEFAULTS.vad, voice.vad),
    bargeIn: section(DEFAULTS.bargeIn, voice.bargeIn),
    autoBackground: section(DEFAULTS.autoBackground, voice.autoBackground),
    prompt: voice.prompt ?? DEFAULT_VOICE_PROMPT,
    holdingLine: voice.holdingLine ?? DEFAULT_HOLDING_LINE,
    limits: section(DEFAULTS.limits, voice.limits),
    local: section(DEFAULTS.local, voice.local),
  };
}
