/**
 * `GET /api/voice/config` and `POST /api/voice/install`
 * (specs/009-voice-mode/contracts/voice-config.md). The config reply says whether voice is on, whether
 * its providers can run right now and why not, and how far the local install is. It never carries a key,
 * a base URL or the prompt.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DICTATION_SAMPLE_RATE, MAX_DICTATION_BYTES, dictationUnavailableReason, transcribePcm } from "../voice/dictation.js";
import { BodyTooLargeError, readBodyRaw } from "./http-helpers.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import type { HundredfoldConfig } from "../shared/types.js";
import { resolveVoiceConfig, voiceOffReason, type ResolvedVoiceConfig } from "../shared/voice-config.js";
import type { VoiceProviderStatus } from "../voice/provider.js";
import type { LocalSpeech } from "../voice/providers/local.js";
import { createSttProvider, createTtsProvider, onVoiceInstallChange, sharedLocalSpeech, type ProviderDeps } from "../voice/providers/registry.js";
import { findPythonCached, voicePaths, helloModels, resolveDevice, type InstallStatus } from "../voice/sidecar/bootstrap.js";
import { readKokoroVoices } from "../voice/voices-file.js";
import { UNIDENTIFIED_TOOL_CALL_ERROR } from "../mcp/identity.js";
import { json, serverError, type ParsedRoute } from "./route-helpers.js";
import type { CallerIdentity } from "./session-comm-guards.js";

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
  /** The gateway's verified view of who is calling; `POST /api/voice/end` is for a session's own tool call. */
  resolveCaller?: () => CallerIdentity;
  /** Hang up the voice call on a session once its goodbye is said; absent while voice is not running. */
  endCall?: (sessionId: string) => "ending" | "no-call";
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
  if (!resolved) {
    // Asked for but invalid: say why it is off, naming the keys. Anything else is plain off.
    const invalid = voiceOffReason(config.voice);
    return invalid ? { enabled: true, available: false, reason: invalid } : { enabled: false };
  }
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
export async function handleVoiceApi(req: IncomingMessage, res: ServerResponse, route: ParsedRoute, options: VoiceApiOptions): Promise<boolean> {
  if (route.pathname === "/api/voice/config" && route.method === "GET") {
    if (options.emit) broadcastInstall(options.emit);
    json(res, voiceConfigResponse(options.getConfig(), options));
    return true;
  }
  if (route.pathname === "/api/voice/install" && route.method === "POST") {
    return startInstall(res, options);
  }
  if (route.pathname === "/api/voice/end" && route.method === "POST") {
    return endCall(res, options);
  }
  if (route.pathname === "/api/voice/transcribe" && route.method === "POST") {
    return transcribeRecording(req, res, route, options);
  }
  return false;
}

/**
 * `POST /api/voice/end`: the `end_voice_call` tool. It acts on the calling session's own voice call and takes
 * no session id, so a session can never hang up a call on another one. The operator has no session to speak
 * for, and a tool call that lost its identity is refused here too, as for heartbeats.
 */
function endCall(res: ServerResponse, options: VoiceApiOptions): boolean {
  const identity = options.resolveCaller?.();
  if (identity?.kind !== "session") {
    const error = identity?.kind === "operator" ? "A voice call is hung up by the session in it, with its end_voice_call tool." : UNIDENTIFIED_TOOL_CALL_ERROR;
    json(res, { error }, 403);
    return true;
  }
  if (!options.endCall || options.endCall(identity.callerId) === "no-call") {
    json(res, { error: "No voice call is open on this chat." }, 409);
    return true;
  }
  json(res, { status: "ending" });
  return true;
}

const TOO_LONG = "Recording too long (20 minutes at most)";

/** Why the posted recording cannot be transcribed, with the status to answer with; null when it can. */
function recordingProblem(pcm: Buffer): { status: number; message: string } | null {
  if (pcm.length === 0) return { status: 400, message: "No audio data" };
  if (pcm.length > MAX_DICTATION_BYTES) return { status: 413, message: TOO_LONG };
  if (pcm.length % 2 !== 0) return { status: 400, message: `Audio must be 16-bit PCM mono at ${DICTATION_SAMPLE_RATE} Hz` };
  return null;
}

/** The recording in the request, or the reply that refuses it. A declared length over the limit is refused before the body is read, and a body that outgrows it is no longer buffered. */
async function readRecording(req: IncomingMessage): Promise<{ pcm: Buffer } | { status: number; message: string }> {
  if (Number(req.headers["content-length"]) > MAX_DICTATION_BYTES) return { status: 413, message: TOO_LONG };
  let pcm: Buffer;
  try {
    pcm = await readBodyRaw(req, { maxBytes: MAX_DICTATION_BYTES });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return { status: 413, message: TOO_LONG };
    throw error;
  }
  return recordingProblem(pcm) ?? { pcm };
}

/**
 * `POST /api/voice/transcribe`: dictation. The body is the whole recording as PCM16LE mono at 16 kHz (the browser
 * decodes its own capture to that); `?language=` overrides `voice.language`. It runs on voice mode's speech-to-text
 * provider, so it answers 409 while voice is off or its provider is not ready.
 */
async function transcribeRecording(req: IncomingMessage, res: ServerResponse, route: ParsedRoute, options: VoiceApiOptions): Promise<boolean> {
  const config = options.getConfig();
  const resolved = resolveVoiceConfig(config);
  const unavailable = dictationUnavailableReason(config, options);
  if (!resolved || unavailable) {
    json(res, { error: unavailable ?? "Voice mode is not enabled" }, 409);
    return true;
  }
  const recording = await readRecording(req);
  if (!("pcm" in recording)) {
    json(res, { error: recording.message }, recording.status);
    return true;
  }
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  const language = route.url.searchParams.get("language")?.trim() || resolved.language;
  try {
    json(res, { text: await transcribePcm(createSttProvider(resolved, options), recording.pcm, { language, signal: abort.signal }) });
  } catch (error) {
    if (!abort.signal.aborted) serverError(res, `Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
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
