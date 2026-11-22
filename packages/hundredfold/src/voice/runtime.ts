/**
 * Voice mode as the gateway sees it: one object `server.ts` creates when voice
 * is on and wires in a few lines (the socket server, the upgrade branch, the
 * emit tee, shutdown). Everything with logic is in this directory.
 *
 * `createVoiceRuntime` returns null when voice is off, and `server.ts` then does
 * nothing at all: no tee on `emit`, no branch in the upgrade router, no socket
 * server (FR-021). Turning voice on needs a restart for the same reason: the
 * tee is part of `emit`, which the rest of the gateway holds from boot.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { MemberPrincipal } from "../accounts/runtime.js";
import type { ApiContext } from "../gateway/api.js";
import { getSession, externalRepliesSince, latestAssistantMessageId, mergeMessageMeta } from "../sessions/registry.js";
import { resolveEnvVar } from "../shared/env-ref.js";
import { logger } from "../shared/logger.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import type { HundredfoldConfig } from "../shared/types.js";
import { voiceDeliveryFor, turnRunningFor } from "./deliver.js";
import { createVoiceEmitTee } from "./emit-tee.js";
import { VoiceHub } from "./hub.js";
import { systemClock, type VoiceHubDeps, type VoiceProviderSet } from "./hub-types.js";
import { resolveVoiceConfig, type ResolvedVoiceConfig } from "../shared/voice-config.js";
import { closeSharedLocalSpeech, createVoiceProviders } from "./providers/registry.js";
import { handleVoiceUpgrade, upgradeMember, VOICE_MAX_PAYLOAD_BYTES, type VoiceUpgradeDeps } from "./upgrade.js";

export interface VoiceRuntimeOptions {
  getConfig(): HundredfoldConfig;
  /** The API context, which exists only after the gateway has built it. */
  getContext(): ApiContext;
  /** The operator's own credential, or a same-origin browser where auth is not required. */
  operatorAuthenticated(req: IncomingMessage): boolean;
  /** Replace the speech providers (tests); the default is the provider registry. */
  providers?: (config: ResolvedVoiceConfig) => VoiceProviderSet;
}

export interface VoiceRuntime {
  readonly hub: VoiceHub;
  /** The socket server voice sockets live on, for the gateway's heartbeat sweep. */
  readonly wss: WebSocketServer;
  /** Put the tee on the gateway's `emit`. */
  wrapEmit(emit: GatewayEmit): GatewayEmit;
  /** The operator's `/ws/voice/:id` upgrade; false when it is not one, or voice has been turned off. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** A member's, once the accounts router has found they may message the session. */
  upgradeMember(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    member: { principal: MemberPrincipal; sessionId: string; onSocket(ws: WebSocket): void },
  ): boolean;
  /** A member lost access to a session (the member sweep): their attachment there gets `detached {access_lost}`, then the close. */
  revoke(sessionId: string, principal: MemberPrincipal): void;
  shutdown(): void;
}

/** The longest spoken-conversation prompt the hub sends, the same limit `voice.prompt` has. */
const MAX_PROMPT_FILE_CHARS = 8000;

/**
 * `resolved` with `prompt` taken from `promptFile` when one is set (the resolver checks the path stays inside the
 * instance home but does not read it). A file that cannot be read, or is empty, leaves the built-in prompt, with a warning.
 */
export function withPromptFile(resolved: ResolvedVoiceConfig, read: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): ResolvedVoiceConfig {
  if (!resolved.promptFile) return resolved;
  try {
    const text = read(resolved.promptFile).trim();
    if (text) return { ...resolved, prompt: text.slice(0, MAX_PROMPT_FILE_CHARS) };
    logger.warn("[voice] voice.promptFile is empty; using the built-in prompt");
  } catch (error) {
    logger.warn(`[voice] voice.promptFile could not be read (${(error as NodeJS.ErrnoException).code ?? "error"}); using the built-in prompt`);
  }
  return resolved;
}

/** The resolved config for the config as it stands, resolved (and its prompt file read) again only when the voice block itself changes. */
export function memoisedConfig(getConfig: () => HundredfoldConfig): () => ResolvedVoiceConfig | null {
  let source: unknown;
  let resolved: ResolvedVoiceConfig | null = null;
  return () => {
    const config = getConfig();
    if (config.voice !== source || resolved === null) {
      source = config.voice;
      const fresh = resolveVoiceConfig(config);
      resolved = fresh && withPromptFile(fresh);
    }
    return resolved;
  };
}

/** What the voice block's `apiKey` settings hold now: the variables they name, or (a mistake) the key written in. */
function configuredKeys(config: HundredfoldConfig): string[] {
  return [config.voice?.stt?.apiKey, config.voice?.tts?.apiKey]
    .map((ref) => resolveEnvVar(ref))
    .filter((value): value is string => typeof value === "string" && value.length >= 6);
}

/** Replaces every configured provider key in `text`: the last line of defence for text a client will read. */
export function redactorFor(getConfig: () => HundredfoldConfig): (text: string) => string {
  return (text) => configuredKeys(getConfig()).reduce((out, key) => out.split(key).join("[redacted]"), text);
}

function hubDeps(options: VoiceRuntimeOptions): VoiceHubDeps {
  return {
    config: memoisedConfig(options.getConfig),
    providers: options.providers ?? ((config) => createVoiceProviders(config)),
    getSession: (sessionId) => getSession(sessionId),
    getEngine: (name) => options.getContext().sessionManager.getEngine(name),
    turnRunning: (sessionId, engine) => {
      const session = getSession(sessionId);
      return session ? turnRunningFor(session, engine, sessionId) : false;
    },
    deliver: (delivery) => voiceDeliveryFor(options.getContext())(delivery),
    mergeMessageMeta: (messageId, patch) => { mergeMessageMeta(messageId, patch); },
    findReplyMessageId: latestAssistantMessageId,
    externalRepliesSince,
    clock: systemClock,
    log: logger,
    newId: randomUUID,
    redact: redactorFor(options.getConfig),
  };
}

/** Null when voice is off in the config at boot. */
export function createVoiceRuntime(options: VoiceRuntimeOptions): VoiceRuntime | null {
  if (resolveVoiceConfig(options.getConfig()) === null) return null;
  const deps = hubDeps(options);
  const hub = new VoiceHub(deps);
  const wss = new WebSocketServer({ noServer: true, maxPayload: VOICE_MAX_PAYLOAD_BYTES });
  const upgradeDeps: VoiceUpgradeDeps = {
    hub, wss, enabled: () => deps.config() !== null, operatorAuthenticated: options.operatorAuthenticated,
  };
  return {
    hub,
    wss,
    wrapEmit: (emit) => createVoiceEmitTee(emit, hub, logger),
    handleUpgrade: (req, socket, head) => handleVoiceUpgrade(req, socket, head, upgradeDeps),
    upgradeMember: (req, socket, head, member) => upgradeMember(req, socket, head, upgradeDeps, member),
    revoke: (sessionId, principal) => hub.revoke(sessionId, { kind: "member", userId: principal.userId, userSessionId: principal.sessionId }),
    shutdown() {
      hub.shutdown();
      wss.close();
      closeSharedLocalSpeech(); // the speech sidecar and any install in progress
    },
  };
}
