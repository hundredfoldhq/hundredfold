/**
 * The `/ws/voice/:sessionId` upgrade, mirroring `/ws/pty/:sessionId`: an
 * operator, from the gateway's own origin, on a session that exists and takes
 * messages (contracts/voice-socket.md, Upgrade). The members' path comes in
 * through `upgradeMember`, from the accounts router.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import type { MemberPrincipal } from "../accounts/runtime.js";
import { rejectCrossOriginUpgrade } from "../gateway/upgrade-guards.js";
import { sessionIsWithinReach } from "../gateway/session-reach-guard.js";
import { resolveCallerIdentity } from "../gateway/session-comm-guards.js";
import { trackHeartbeat } from "../gateway/ws-heartbeat.js";
import { UNIDENTIFIED_TOOL_CALL_ERROR, verifySessionCapability } from "../mcp/identity.js";
import { getSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";
import { adoptLegacyHeaders } from "../shared/wire-names.js";
import { isTerminalSession } from "../terminals/session.js";
import type { VoiceHub } from "./hub.js";
import type { VoicePrincipal, VoiceSocket } from "./hub-types.js";
import { voiceEndsSuspended, voiceSessionId } from "./paths.js";
import { createTracer, errorField } from "./trace.js";

export { voiceSessionId };

/** Frames are small: JSON control and at most 4096 bytes of audio. */
export const VOICE_MAX_PAYLOAD_BYTES = 16 * 1024;

const trace = createTracer(logger);

/** Who is calling, as far as is safe to keep: the browser or webview and the page's host, never an address or a credential. */
function callerFields(req: IncomingMessage): Record<string, string | undefined> {
  const header = (name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const origin = header("origin");
  let originHost: string | undefined;
  try { originHost = origin ? new URL(origin).host : undefined; } catch { originHost = "unparseable"; }
  return { ua: header("user-agent")?.slice(0, 120), origin_host: originHost };
}

function refuse(socket: Duplex, status: string, error: string, req?: IncomingMessage): true {
  trace.warn("ws_refused", { status, reason: error, ...(req ? callerFields(req) : {}) });
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ error })}`);
  socket.destroy();
  return true;
}

export interface VoiceUpgradeDeps {
  hub: VoiceHub;
  wss: WebSocketServer;
  /** Voice is on now: read live, so a reload that turns it off closes the door. */
  enabled(): boolean;
  /** The operator's own credential, or a same-origin browser where auth is not required (the `/ws/pty` rule). */
  operatorAuthenticated(req: IncomingMessage): boolean;
}

/** The session a voice socket may attach to, or the refusal. */
function attachableSession(sessionId: string): Session | "missing" {
  const session = getSession(sessionId);
  return !session || isTerminalSession(session) ? "missing" : session;
}

/**
 * Who is asking, for an operator upgrade. An agent session is never admitted
 * (as for `/ws/pty`): outside its reach it is told so, inside it is told voice
 * is the operator's. True when the upgrade was refused.
 */
function refusedCaller(req: IncomingMessage, socket: Duplex, session: Session, deps: VoiceUpgradeDeps): boolean {
  adoptLegacyHeaders(req.headers);
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: (id) => !!getSession(id),
    verifySessionCapability,
    requireCapability: true,
    operatorAuthenticated: deps.operatorAuthenticated(req),
  });
  if (identity.kind === "operator") return false;
  if (identity.kind === "unidentified-tool") return refuse(socket, "403 Forbidden", UNIDENTIFIED_TOOL_CALL_ERROR, req);
  if (identity.kind === "session" && !sessionIsWithinReach(session, identity.callerId)) {
    return refuse(socket, "403 Forbidden", "That session is outside your reach.", req);
  }
  // Someone with no credential at all learns only that one is needed, not what the endpoint is for.
  if (identity.kind === "unauthenticated") return refuse(socket, "403 Forbidden", "Authentication is required.", req);
  return refuse(socket, "403 Forbidden", "/ws/voice is for the operator; sessions cannot speak into other sessions.", req);
}

/**
 * The operator's voice upgrade. False when the path is not a voice path or voice
 * is off, so the caller treats it as it does any unknown path (the socket is
 * destroyed). True once it answered.
 */
export function handleVoiceUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deps: VoiceUpgradeDeps): boolean {
  const sessionId = voiceSessionId(req.url || "");
  if (sessionId === null || !deps.enabled()) return false;
  if (rejectCrossOriginUpgrade(req, socket)) return true;
  const session = attachableSession(sessionId);
  if (session === "missing") return refuse(socket, "404 Not Found", "No such session.", req);
  if (refusedCaller(req, socket, session, deps)) return true;
  acceptSocket(req, socket, head, deps, { sessionId, principal: { kind: "operator" } });
  return true;
}

/**
 * A member's voice upgrade, reached only once the accounts router has found the
 * member may send messages to this session. Same session checks; the socket is
 * returned to the router so it can tie it to the member sweep.
 */
export function upgradeMember(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: VoiceUpgradeDeps,
  member: { principal: MemberPrincipal; sessionId: string; onSocket(ws: WebSocket): void },
): boolean {
  if (!deps.enabled()) return false;
  if (attachableSession(member.sessionId) === "missing") return refuse(socket, "404 Not Found", "No such session.", req);
  const principal: VoicePrincipal = { kind: "member", userId: member.principal.userId, userSessionId: member.principal.sessionId };
  acceptSocket(req, socket, head, deps, { sessionId: member.sessionId, principal, onSocket: member.onSocket });
  return true;
}

interface Accept {
  sessionId: string;
  principal: VoicePrincipal;
  onSocket?: (ws: WebSocket) => void;
}

function acceptSocket(req: IncomingMessage, socket: Duplex, head: Buffer, deps: VoiceUpgradeDeps, accept: Accept): void {
  const openedAt = Date.now();
  const caller = callerFields(req);
  deps.wss.handleUpgrade(req, socket, head, (ws) => {
    trace.info("ws_open", { session: accept.sessionId, principal: accept.principal.kind, ...caller });
    trackHeartbeat(ws);
    accept.onSocket?.(ws);
    const endSuspended = voiceEndsSuspended(req.url || "");
    const attachment = deps.hub.attach(ws as unknown as VoiceSocket, { sessionId: accept.sessionId, principal: accept.principal, endSuspended });
    if (!attachment) return;
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!attachment.owns(ws as unknown as VoiceSocket)) return;
      if (isBinary) attachment.onBinary(toBuffer(data));
      else attachment.onText(toBuffer(data).toString("utf8"));
    });
    const gone = (code: number): void => deps.hub.socketClosed(attachment, ws as unknown as VoiceSocket, code);
    // ws raises `error` first and then `close`, and on the server side that close reports 1006 even when ws itself ended the
    // connection with 1009 (a frame over the size limit). The error is the only place the real code shows: keep it, and
    // let `close` report it, so an oversize frame ends the attachment instead of reading as a dropped network.
    let endedBy: number | null = null;
    ws.on("error", (error: Error & { code?: string }) => {
      trace.warn("ws_error", { session: accept.sessionId, code: error.code, error: errorField(error) });
      if (error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") endedBy = 1009;
    });
    ws.on("close", (code: number, reason?: Buffer) => {
      trace.info("ws_close", { session: accept.sessionId, code: endedBy ?? code, reported_code: code, reason: reason?.toString("utf8").slice(0, 40), open_ms: Date.now() - openedAt });
      gone(endedBy ?? code);
    });
  });
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}
