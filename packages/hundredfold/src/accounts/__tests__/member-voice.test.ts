import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./accounts-harness.js";
import { inviteAndAccept, type Joined } from "./flows-helpers.js";
import { routeMemberUpgrade } from "../member-upgrade.js";
import { memberMayUpgrade } from "../member-router.js";
import { memberMaySendMessages } from "../member-chat-access.js";
import { MEMBER_SOCKET_CLOSE_UNAUTHORIZED } from "../member-sockets.js";
import { FakeStt, FakeTts, FakeVad } from "../../voice/__tests__/fakes.js";
import type { MemberPrincipal } from "../runtime.js";

/**
 * A member's voice socket (T055). Voice authorises through one predicate, "may this member send messages to this
 * session", false for every member today because members have no chat. These tests drive the real upgrade router
 * and the real voice runtime: refused now, and with the predicate stubbed true accepted, tied to the member sweep,
 * and closed 4401 within one sweep once the permission is gone.
 */
let h: Harness;
let pat: Joined;
let server: http.Server;
let port: number;
let sessionId: string;
let runtime: NonNullable<ReturnType<typeof import("../../voice/runtime.js").createVoiceRuntime>>;
let allowed: boolean;
let predicateCalls: Array<{ userId: string; sessionId: string }>;
let operatorSawUpgrade: string[];
const memberWss = new WebSocketServer({ noServer: true });
const sockets: WebSocket[] = [];

beforeEach(async () => {
  h = await startHarness();
  pat = await inviteAndAccept(h, "pat@example.test");
  const registry = await import("../../sessions/registry.js");
  sessionId = registry.createSession({ engine: "codex", source: "web", sourceRef: `web:member-voice-${Date.now()}` }).id;
  const { createVoiceRuntime } = await import("../../voice/runtime.js");
  const made = createVoiceRuntime({
    getConfig: () => ({ gateway: {}, engines: {}, voice: { enabled: true } }) as never,
    getContext: () => ({ sessionManager: { getEngine: () => undefined } }) as never,
    operatorAuthenticated: () => false,
    providers: () => ({ stt: new FakeStt(), tts: new FakeTts(), createVad: () => new FakeVad() }),
  });
  if (!made) throw new Error("no voice runtime");
  runtime = made;
  allowed = true;
  predicateCalls = [];
  operatorSawUpgrade = [];
  server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    const handled = routeMemberUpgrade(req, socket, head, {
      accounts: h.rt, memberWss, voice: runtime,
      maySendMessages: (principal: MemberPrincipal, id: string) => { predicateCalls.push({ userId: principal.userId, sessionId: id }); return allowed; },
    });
    if (handled) return;
    operatorSawUpgrade.push(req.url ?? "");
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
}, 120_000);

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const client of memberWss.clients) client.terminate();
  runtime.shutdown();
  await new Promise((resolve) => server.close(resolve));
  h.close();
});

type Outcome = { ws: WebSocket } | { status: number; body: string } | { destroyed: true };

function connect(path: string, cookie: string, extra: Record<string, string> = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { cookie, ...extra } });
    ws.on("open", () => { sockets.push(ws); resolve({ ws }); });
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    ws.on("error", () => resolve({ destroyed: true }));
  });
}

describe("memberMayUpgrade", () => {
  const principal = { kind: "member", userId: "u1", sessionId: "us1" } as unknown as MemberPrincipal;

  it("admits /ws, and a voice path only when the predicate says the member may message that session", () => {
    expect(memberMayUpgrade("/ws")).toBe(true);
    expect(memberMayUpgrade("/ws/voice/abc")).toBe(false);
    expect(memberMayUpgrade("/ws/voice/abc", { principal, maySendMessages: () => false })).toBe(false);
    const seen: string[] = [];
    expect(memberMayUpgrade("/ws/voice/abc%20d?x=1", { principal, maySendMessages: (_p, id) => { seen.push(id); return true; } })).toBe(true);
    expect(seen).toEqual(["abc d"]);
  });

  it("never admits anything else, whatever the predicate says", () => {
    const yes = { principal, maySendMessages: () => true };
    for (const path of ["/ws/pty/x", "/ws/voice", "/ws/voice/", "/ws/voice/a/b", "/ws/", "/api/plugins/demo/events", "/ws/voice%"]) {
      expect(memberMayUpgrade(path, yes), path).toBe(false);
    }
  });

  it("the built-in predicate is no for every member: members have no chat", () => {
    expect(memberMaySendMessages(principal, "any")).toBe(false);
  });
});

describe("a member's voice upgrade", () => {
  it("is refused today: the built-in predicate says no, and nothing else sees the socket", async () => {
    const closed = http.createServer();
    const seen: string[] = [];
    closed.on("upgrade", (req, socket, head) => {
      if (routeMemberUpgrade(req, socket, head, { accounts: h.rt, memberWss, voice: runtime })) return;
      seen.push(req.url ?? "");
      socket.destroy();
    });
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const otherPort = (closed.address() as AddressInfo).port;
    const result = await new Promise<{ status: number; body: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${otherPort}/ws/voice/${sessionId}`, { headers: { cookie: pat.cookie } });
      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      ws.on("error", () => undefined);
    });
    await new Promise((resolve) => closed.close(resolve));
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: "Not available to board members" });
    expect(seen).toEqual([]);
    expect(runtime.hub.size()).toBe(0);
  });

  it("with the predicate true: accepted, hello is answered, the member is the principal, the socket is in the sweep", async () => {
    const result = await connect(`/ws/voice/${sessionId}`, pat.cookie);
    expect("ws" in result).toBe(true);
    const { ws } = result as { ws: WebSocket };
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (raw: Buffer, isBinary: boolean) => { if (!isBinary) frames.push(JSON.parse(raw.toString())); });
    ws.send(JSON.stringify({ type: "hello", protocol: 1, mode: "hands-free", client: "web" }));
    for (let i = 0; i < 300 && !frames.some((f) => f.type === "ready"); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(frames.find((f) => f.type === "ready")).toMatchObject({ sessionId });
    expect(runtime.hub.get(sessionId)?.principal).toEqual({ kind: "member", userId: pat.userId, userSessionId: expect.any(String) });
    expect(h.rt.memberSockets.size()).toBe(1);
    expect(predicateCalls[0]).toEqual({ userId: pat.userId, sessionId });
    expect(operatorSawUpgrade).toEqual([]);
  });

  it("closes 4401 within one sweep once the member may no longer message the session, and the attachment goes", async () => {
    const { ws } = (await connect(`/ws/voice/${sessionId}`, pat.cookie)) as { ws: WebSocket };
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    for (let i = 0; i < 300 && runtime.hub.size() === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(h.rt.memberSockets.sweep()).toBe(0);
    allowed = false; // the grant was removed
    expect(h.rt.memberSockets.sweep()).toBe(1);
    expect(await closed).toBe(MEMBER_SOCKET_CLOSE_UNAUTHORIZED);
    for (let i = 0; i < 300 && runtime.hub.size() !== 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(runtime.hub.size()).toBe(0);
    expect(h.rt.memberSockets.size()).toBe(0);
  });

  it("the sweep tells the client `detached access_lost` first, then closes 4401, and only that member's attachment goes", async () => {
    const { ws } = (await connect(`/ws/voice/${sessionId}`, pat.cookie)) as { ws: WebSocket };
    const events: string[] = [];
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const frame = JSON.parse(raw.toString()) as { type: string; reason?: string };
      if (frame.type === "detached") events.push(`detached:${frame.reason}`);
    });
    ws.on("close", (code) => events.push(`close:${code}`));
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
    ws.send(JSON.stringify({ type: "hello", protocol: 1, mode: "hands-free", client: "web" }));
    for (let i = 0; i < 300 && runtime.hub.get(sessionId)?.principal === undefined; i += 1) await new Promise((r) => setTimeout(r, 10));
    // Another session of the same member is unaffected: only this attachment's principal is revoked.
    const registry = await import("../../sessions/registry.js");
    const otherId = registry.createSession({ engine: "codex", source: "web", sourceRef: `web:member-voice-other-${Date.now()}` }).id;
    const operatorSide = { sent: [] as string[], closed: null as number | null };
    runtime.hub.attach(
      { readyState: 1, send: (data: string | Buffer) => { operatorSide.sent.push(String(data)); }, close: (code?: number) => { operatorSide.closed = code ?? null; } } as never,
      { sessionId: otherId, principal: { kind: "operator" } },
    );
    allowed = false;
    expect(h.rt.memberSockets.sweep()).toBe(1);
    await closed;
    expect(events).toEqual(["detached:access_lost", `close:${MEMBER_SOCKET_CLOSE_UNAUTHORIZED}`]);
    expect(runtime.hub.get(otherId)).toBeDefined();
    expect(operatorSide.closed).toBeNull();
  });

  it("a revoked sign-in closes the socket even while the permission still holds", async () => {
    const first = (await connect(`/ws/voice/${sessionId}`, pat.cookie)) as { ws: WebSocket };
    const closed = new Promise<number>((resolve) => first.ws.on("close", (code) => resolve(code)));
    allowed = true;
    await h.asOperator("DELETE", `/api/people/${pat.userId}/sessions`);
    expect(await closed).toBe(MEMBER_SOCKET_CLOSE_UNAUTHORIZED);
  });

  it("hears nothing of the broadcast: a voice socket is not given Todo frames", async () => {
    const { ws } = (await connect(`/ws/voice/${sessionId}`, pat.cookie)) as { ws: WebSocket };
    const frames: string[] = [];
    ws.on("message", (raw) => frames.push(raw.toString()));
    h.rt.memberSockets.publish("company:changed", { kind: "work-item", id: "X-1" });
    await new Promise((r) => setTimeout(r, 100));
    expect(frames).toEqual([]);
  });

  it("a cross-origin browser is refused even for a member who may message the session", async () => {
    const result = await connect(`/ws/voice/${sessionId}`, pat.cookie, { origin: "http://evil.example" });
    expect(result).toMatchObject({ status: 403 });
  });

  it("a session that does not exist is a 404, and voice off at the runtime is a destroyed socket", async () => {
    expect(await connect("/ws/voice/no-such-session", pat.cookie)).toMatchObject({ status: 404 });
    const quiet = http.createServer();
    quiet.on("upgrade", (req, socket, head) => {
      if (routeMemberUpgrade(req, socket, head, { accounts: h.rt, memberWss, maySendMessages: () => true })) return;
      socket.destroy();
    });
    await new Promise<void>((resolve) => quiet.listen(0, "127.0.0.1", resolve));
    const quietPort = (quiet.address() as AddressInfo).port;
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${quietPort}/ws/voice/${sessionId}`, { headers: { cookie: pat.cookie } });
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("destroyed"));
    });
    await new Promise((resolve) => quiet.close(resolve));
    expect(outcome).toBe("destroyed");
  });
});
