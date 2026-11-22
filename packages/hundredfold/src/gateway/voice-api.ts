/**
 * `GET /api/voice/config` and `POST /api/voice/install`
 * (specs/009-voice-mode/contracts/voice-config.md). The config reply says whether voice is on, whether
 * its providers can run right now and why not, and how far the local install is. It never carries a key,
 * a base URL or the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayEmit } from "../shared/gateway-events.js";
import type { HundredfoldConfig } from "../shared/types.js";
import { resolveVoiceConfig, type ResolvedVoiceConfig } from "../shared/voice-config.js";
import type { VoiceProviderStatus } from "../voice/provider.js";
import type { LocalSpeech } from "../voice/providers/local.js";
import { createSttProvider, createTtsProvider, onVoiceInstallChange, sharedLocalSpeech, type ProviderDeps } from "../voice/providers/registry.js";
import { findPythonCached, voicePaths, helloModels, resolveDevice, type InstallStatus } from "../voice/sidecar/bootstrap.js";
import { readKokoroVoices } from "../voice/voices-file.js";
import { json, type ParsedRoute } from "./route-helpers.js";

/** OpenAI's built-in speech voices (public information about the provider), for a picker. */
export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"];

export interface VoiceApiDeps extends ProviderDeps {
  /** Broadcast a gateway event (`voice:install`). */
  emit?: GatewayEmit;
  /**
   * Whether the gateway built its voice runtime at boot. Voice is set up only then, so a config that turned it on
   * since is not running. Absent (a bare context) means no claim is made either way.
   */
  voiceRunning?: () => boolean;
}

/** What `GET /api/voice/config` says while the config has voice on and the gateway has no voice runtime. */
export const VOICE_RESTART_REASON = "Restart the gateway to turn voice on";

export interface VoiceConfigResponse {
  enabled: boolean;
  [key: string]: unknown;
}

const subscribed = new WeakSet<object>();

/** Turn the installer's state changes into `voice:install` gateway events, once per emitter. */
function broadcastInstall(emit: NonNullable<VoiceApiDeps["emit"]>): void {
  if (subscribed.has(emit)) return;
  subscribed.add(emit);
  onVoiceInstallChange((status) => emit("voice:install", status));
}

function installView(resolved: ResolvedVoiceConfig, local: LocalSpeech): InstallStatus {
  const usesLocal = resolved.stt.provider === "local" || resolved.tts.provider === "local";
  if (!usesLocal) return { state: "ready", progress: 1 };
  const status = local.installer.status();
  return status.state === "failed" ? { state: "failed", progress: status.progress, reason: status.reason } : { state: status.state, progress: status.progress };
}

/** The voice names `tts.voice` may take: the Kokoro file's for local, OpenAI's built-ins, else unknown. */
function ttsVoices(resolved: ResolvedVoiceConfig, home?: string): string[] {
  if (resolved.tts.provider === "openai") return OPENAI_VOICES;
  if (resolved.tts.provider !== "local") return [];
  const models = helloModels(voicePaths(home), resolveDevice(resolved.local.device)).tts as { voices: string };
  return readKokoroVoices(models.voices);
}

/** A local TTS voice that is not in the voice file is reported as unavailable, with the reason. */
function ttsStatus(resolved: ResolvedVoiceConfig, base: VoiceProviderStatus, voices: string[]): VoiceProviderStatus {
  if (!base.available || resolved.tts.provider !== "local" || voices.length === 0 || voices.includes(resolved.tts.voice)) return base;
  return { available: false, reason: `Voice "${resolved.tts.voice}" is not in the Kokoro voice list` };
}

/** The reply to `GET /api/voice/config`. */
export function voiceConfigResponse(config: { voice?: unknown }, deps: VoiceApiDeps = {}): VoiceConfigResponse {
  const resolved = resolveVoiceConfig(config);
  if (!resolved) return { enabled: false };
  const local = deps.local ?? sharedLocalSpeech(resolved, deps.home);
  const stt = createSttProvider(resolved, { ...deps, local });
  const tts = createTtsProvider(resolved, { ...deps, local });
  const voices = ttsVoices(resolved, deps.home);
  const sttState = withPythonHint(stt.status(), resolved, local);
  const ttsState = ttsStatus(resolved, withPythonHint(tts.status(), resolved, local), voices);
  const reason = [sttState, ttsState].find((state) => !state.available)?.reason ?? null;
  const needsRestart = deps.voiceRunning?.() === false;
  return {
    enabled: true,
    available: !needsRestart && reason === null,
    reason: needsRestart ? VOICE_RESTART_REASON : reason,
    mode: resolved.mode,
    language: resolved.language,
    stt: { provider: stt.id, partials: stt.partials, status: sttState },
    tts: { provider: tts.id, voice: resolved.tts.voice, voices, status: ttsState },
    onset: { threshold: resolved.bargeIn.onsetThreshold, minSpeechMs: resolved.bargeIn.minSpeechMs },
    bargeIn: { enabled: resolved.bargeIn.enabled },
    cues: { enabled: resolved.cues.enabled, volume: resolved.cues.volume },
    autoBackground: { enabled: resolved.autoBackground.enabled, afterSeconds: resolved.autoBackground.afterSeconds },
    limits: { maxUtteranceSeconds: resolved.limits.maxUtteranceSeconds },
    install: installView(resolved, local),
  };
}

/** Before the install runs, say what is missing on this machine, if that is Python. */
function withPythonHint(status: VoiceProviderStatus, resolved: ResolvedVoiceConfig, local: LocalSpeech): VoiceProviderStatus {
  const isLocal = resolved.stt.provider === "local" || resolved.tts.provider === "local";
  if (status.available || !isLocal || local.installer.status().state !== "not_installed") return status;
  return findPythonCached() ? status : { available: false, reason: "Python 3.10+ with venv and pip not found; install it first (see docs/voice.md)" };
}

export interface VoiceApiOptions extends VoiceApiDeps {
  getConfig: () => HundredfoldConfig;
}

/** Handle `/api/voice/*`; false for anything else so the dispatcher carries on. */
export async function handleVoiceApi(_req: IncomingMessage, res: ServerResponse, route: ParsedRoute, options: VoiceApiOptions): Promise<boolean> {
  if (route.pathname === "/api/voice/config" && route.method === "GET") {
    if (options.emit) broadcastInstall(options.emit);
    json(res, voiceConfigResponse(options.getConfig(), options));
    return true;
  }
  if (route.pathname === "/api/voice/install" && route.method === "POST") {
    return startInstall(res, options);
  }
  return false;
}

function startInstall(res: ServerResponse, options: VoiceApiOptions): boolean {
  const resolved = resolveVoiceConfig(options.getConfig());
  if (!resolved) {
    json(res, { error: "Voice mode is not enabled" }, 409);
    return true;
  }
  if (options.emit) broadcastInstall(options.emit);
  const local = options.local ?? sharedLocalSpeech(resolved, options.home);
  void local.installer.ensureInstalled(); // long: the reply is the state it is in now, and progress follows as events
  json(res, installView({ ...resolved, stt: { ...resolved.stt, provider: "local" } }, local));
  return true;
}
