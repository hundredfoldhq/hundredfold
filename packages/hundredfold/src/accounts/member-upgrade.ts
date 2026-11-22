import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { rejectCrossOriginUpgrade } from "../gateway/upgrade-guards.js";
import { trackHeartbeat } from "../gateway/ws-heartbeat.js";
import { requestUserToken } from "./cookie.js";
import { memberMayUpgrade, NOT_AVAILABLE_TO_MEMBERS } from "./member-router.js";
import { memberMaySendMessages, type MemberMessagePredicate } from "./member-chat-access.js";
import { voiceSessionId } from "../voice/paths.js";
import type { AccountsRuntime, MemberPrincipal } from "./runtime.js";

/** The voice side of a member upgrade: the gateway's voice runtime, when voice is on. */
export interface MemberVoiceUpgrader {
  upgradeMember(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    member: { principal: MemberPrincipal; sessionId: string; onSocket(ws: WebSocket): void },
  ): boolean;
  /** The member lost access to the session: end their attachment there, telling the client why first. */
  revoke(sessionId: string, principal: MemberPrincipal): void;
}

export interface MemberUpgradeDeps {
  accounts: AccountsRuntime;
  memberWss: WebSocketServer;
  voice?: MemberVoiceUpgrader;
  /** Whether a member may message a session; absent is the built-in answer, which is no. */
  maySendMessages?: MemberMessagePredicate;
}

function refuse(socket: Duplex, status: string, error: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ error })}`);
  socket.destroy();
}

/**
 * A member's WebSocket upgrade. Only `/ws` is open to them, and `/ws/voice/:id` on a session they may send
 * messages to (not `/ws/pty/*`, not a plugin's event stream), from the gateway's own origin; everything else is
 * refused 403 before any other handler sees the socket.
 * The accepted socket is tied to the member's session and closed 4401 when that session stops being valid.
 * It is not in the general broadcast's client set: it is sent only the re-serialised Todo frames for its member's boards.
 */
function handleMemberUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  principal: MemberPrincipal,
  deps: MemberUpgradeDeps,
): void {
  const maySendMessages = deps.maySendMessages ?? memberMaySendMessages;
  if (!memberMayUpgrade(req.url || "", { principal, maySendMessages })) return refuse(socket, "403 Forbidden", NOT_AVAILABLE_TO_MEMBERS);
  if (rejectCrossOriginUpgrade(req, socket)) return;
  const voiceId = voiceSessionId(req.url || "");
  if (voiceId !== null) return memberVoiceUpgrade(req, socket, head, { principal, sessionId: voiceId, maySendMessages }, deps);
  deps.memberWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    trackHeartbeat(ws);
    deps.accounts.memberSockets.add(ws, principal.sessionId);
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m?.event === "ping" && ws.readyState === 1) ws.send(JSON.stringify({ event: "pong", payload: {} }));
      } catch { /* ignore non-JSON frames */ }
    });
    ws.on("close", () => deps.accounts.memberSockets.remove(ws));
    ws.on("error", () => deps.accounts.memberSockets.remove(ws));
  });
}

/** A member's voice socket: tied to their session and to their permission to message this one. */
function memberVoiceUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  member: { principal: MemberPrincipal; sessionId: string; maySendMessages: MemberMessagePredicate },
  deps: MemberUpgradeDeps,
): void {
  const accepted = deps.voice?.upgradeMember(req, socket, head, {
    principal: member.principal,
    sessionId: member.sessionId,
    onSocket: (ws) => {
      deps.accounts.memberSockets.addGuarded(
        ws,
        member.principal.sessionId,
        () => member.maySendMessages(member.principal, member.sessionId),
        () => deps.voice?.revoke(member.sessionId, member.principal),
      );
      ws.on("close", () => deps.accounts.memberSockets.remove(ws));
      ws.on("error", () => deps.accounts.memberSockets.remove(ws));
    },
  });
  if (!accepted) socket.destroy();
}

/**
 * The member branch of the server's upgrade handler: resolves who is asking with the same `resolvePrincipal`
 * the HTTP handler uses and, for a member, answers the upgrade. True when it did (the caller returns); false
 * for everyone else, who go on to the operator gate untouched. A request with no member cookie costs nothing.
 */
export function routeMemberUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: MemberUpgradeDeps,
): boolean {
  if (!requestUserToken(req.headers, deps.accounts.home)) return false;
  const principal = deps.accounts.resolvePrincipal(req);
  if (principal.kind !== "member") return false;
  handleMemberUpgrade(req, socket, head, principal, deps);
  return true;
}

/** Re-check every member socket's session on a timer, for expiry and for changes made outside the API. */
export function startMemberSocketSweep(accounts: AccountsRuntime, intervalMs = 30_000): () => void {
  const timer = setInterval(() => accounts.memberSockets.sweep(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
