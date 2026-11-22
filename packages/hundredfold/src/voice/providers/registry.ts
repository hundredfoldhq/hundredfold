/**
 * Picks the speech providers a resolved `voice:` config names. The local ones share one
 * speech sidecar and one install, held here so the API, the hub and the providers all see
 * the same process and the same install state.
 */
import type { ResolvedVoiceConfig } from "../../shared/voice-config.js";
import type { SttProvider, TtsProvider, VadStream } from "../provider.js";
import { SpeechInstaller, helloModels, resolveDevice, spawnSidecar, voicePaths, type InstallStatus } from "../sidecar/bootstrap.js";
import { SpeechSidecarClient } from "../sidecar/client.js";
import { EnergyVad } from "./energy-vad.js";
import { LocalSttProvider, LocalTtsProvider, openLocalVad, type LocalSpeech } from "./local.js";
import { OpenAiSttProvider, OpenAiTtsProvider, type OpenAiEndpoints } from "./openai.js";
import { OpenAiCompatibleSttProvider, OpenAiCompatibleTtsProvider } from "./openai-compatible.js";

export interface ProviderDeps {
  /** Replaces the shared local sidecar (tests). */
  local?: LocalSpeech;
  env?: NodeJS.ProcessEnv;
  endpoints?: OpenAiEndpoints;
  /** The instance home the local models live under. Defaults to the process's. */
  home?: string;
}

const shared = new Map<string, LocalSpeech>();
const installListeners = new Set<(status: InstallStatus) => void>();

/** Hear every install state change (the API turns them into `voice:install` events). Returns the unsubscribe. */
export function onVoiceInstallChange(listener: (status: InstallStatus) => void): () => void {
  installListeners.add(listener);
  return () => installListeners.delete(listener);
}

/** The one local sidecar and installer for this home and device setting, created on first ask. */
export function sharedLocalSpeech(resolved: ResolvedVoiceConfig, home?: string): LocalSpeech {
  const key = `${home ?? ""}|${resolved.local.device}`;
  const existing = shared.get(key);
  if (existing) return existing;
  const paths = voicePaths(home);
  const device = () => resolveDevice(resolved.local.device);
  const installer = new SpeechInstaller({ home, device, onChange: (status) => installListeners.forEach((listener) => listener(status)) });
  const client = new SpeechSidecarClient({
    spawnProcess: () => spawnSidecar(paths),
    hello: () => ({ device: device(), models: helloModels(paths, device()) }),
  });
  const local = { client, installer };
  shared.set(key, local);
  return local;
}

/** Kill the shared sidecars (gateway shutdown, config reload). */
export function closeSharedLocalSpeech(): void {
  for (const local of shared.values()) local.client.close();
  shared.clear();
}

const usesLocal = (resolved: ResolvedVoiceConfig): boolean => resolved.stt.provider === "local" || resolved.tts.provider === "local";

export function createSttProvider(resolved: ResolvedVoiceConfig, deps: ProviderDeps = {}): SttProvider {
  switch (resolved.stt.provider) {
    case "openai": return new OpenAiSttProvider(resolved.stt, { env: deps.env, endpoints: deps.endpoints });
    case "openai-compatible": return new OpenAiCompatibleSttProvider(resolved.stt, deps.env);
    default: return new LocalSttProvider(deps.local ?? sharedLocalSpeech(resolved, deps.home));
  }
}

export function createTtsProvider(resolved: ResolvedVoiceConfig, deps: ProviderDeps = {}): TtsProvider {
  switch (resolved.tts.provider) {
    case "openai": return new OpenAiTtsProvider(resolved.tts, { env: deps.env, endpoints: deps.endpoints });
    case "openai-compatible": return new OpenAiCompatibleTtsProvider(resolved.tts, deps.env);
    default: return new LocalTtsProvider(deps.local ?? sharedLocalSpeech(resolved, deps.home), resolved.tts);
  }
}

/**
 * VAD for one attachment: Silero through the local sidecar when a local provider is in use or the
 * local models are installed anyway; otherwise an in-process energy detector (less accurate).
 */
export function createVad(resolved: ResolvedVoiceConfig, deps: ProviderDeps = {}): VadStream {
  // Making the shared sidecar object starts nothing: it spawns on first use, and the install is a file check.
  const local = deps.local ?? sharedLocalSpeech(resolved, deps.home);
  if (usesLocal(resolved) || local.installer.status().state === "ready") return openLocalVad(local, resolved.vad);
  return new EnergyVad(resolved.vad);
}
