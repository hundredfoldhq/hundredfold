/**
 * The speech providers the gateway runs voice on. A STAND-IN until the provider
 * registry (local, OpenAI, OpenAI-compatible) is merged: every provider reports
 * itself unavailable, so an enabled voice answers `speech_unavailable` rather
 * than pretending. The merge replaces the body with `createSttProvider`,
 * `createTtsProvider` and `createVad` from the registry.
 */
import type { SttProvider, TtsProvider, VadStream } from "./provider.js";
import type { VoiceProviderSet } from "./hub-types.js";
import type { ResolvedVoiceConfig } from "./resolved-config.js";

const REASON = "Speech providers are not installed in this build.";

const unavailableStt: SttProvider = {
  id: "unavailable",
  partials: false,
  open() {
    throw new Error(REASON);
  },
  status: () => ({ available: false, reason: REASON }),
};

const unavailableTts: TtsProvider = {
  id: "unavailable",
  sampleRate: 24_000,
  defaultVoice: null,
  synthesize(): AsyncIterable<Buffer> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(REASON)) }) };
  },
  status: () => ({ available: false, reason: REASON }),
};

type ProviderFactory = (config: ResolvedVoiceConfig) => VoiceProviderSet;

let override: ProviderFactory | null = null;

/** Run voice on other providers (fakes in tests and in a functional run), or on the built-in ones again with null. */
export function setVoiceProvidersForTest(factory: ProviderFactory | null): void {
  override = factory;
}

export function createVoiceProviders(config: ResolvedVoiceConfig): VoiceProviderSet {
  if (override) return override(config);
  return {
    stt: unavailableStt,
    tts: unavailableTts,
    createVad(): VadStream {
      throw new Error(REASON);
    },
  };
}
