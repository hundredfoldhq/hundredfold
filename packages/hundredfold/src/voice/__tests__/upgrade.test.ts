import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { collect, hello, open, OPERATOR_TOKEN, startRoute, waitFor, type Route } from "./route-harness.js";
import { VOICE_CLOSE } from "../../shared/gateway-events.js";
import type WebSocket from "ws";

type Registry = typeof import("../../sessions/registry.js");
let registry: Registry;
let identity: typeof import("../../mcp/identity.js");
let route: Route | undefined;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  registry = await import("../../sessions/registry.js");
  identity = await import("../../mcp/identity.js");
}, 120_000);

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await route?.close();
  route = undefined;
});

let n = 0;
const newSession = (opts: { source?: string; engine?: string; parentSessionId?: string } = {}) =>
  registry.createSession({ engine: opts.engine ?? "codex", source: opts.source ?? "web", sourceRef: `web:voice-route-${n++}`, parentSessionId: opts.parentSessionId });

async function start(voice?: Parameters<typeof startRoute>[0]): Promise<Route> {
  route = await startRoute(voice);
  return route;
}

const keep = (outcome: Awaited<ReturnType<typeof open>>): WebSocket => {
  if (outcome.kind !== "open") throw new Error(`expected open, got ${outcome.kind}`);
  sockets.push(outcome.ws);
  return outcome.ws;
};

describe("the /ws/voice/:id upgrade", () => {
  it("accepts the operator on a session, and hello is answered with ready", async () => {
    const r = await start();
    const session = newSession();
    const ws = keep(await open(r.url(session.id)));
    const got = collect(ws);
    ws.send(hello());
    await waitFor(() => got.text.some((f) => f.type === "ready"));
    expect(got.text.find((f) => f.type === "ready")).toMatchObject({ type: "ready", protocol: 1, sessionId: session.id });
  });

  it("voice off at boot: there is no runtime, and no branch is taken; the socket is destroyed", async () => {
    const { createVoiceRuntime } = await import("../runtime.js");
    expect(createVoiceRuntime({ getConfig: () => ({ gateway: {}, engines: {} }) as never, getContext: () => ({}) as never, operatorAuthenticated: () => true })).toBeNull();
    expect(createVoiceRuntime({ getConfig: () => ({ gateway: {}, engines: {}, voice: { enabled: false } }) as never, getContext: () => ({}) as never, operatorAuthenticated: () => true })).toBeNull();
  });

  it("voice switched off by a reload after boot: the branch declines and the socket is destroyed, as for an unknown path", async () => {
    const r = await start();
    const session = newSession();
    r.config.current = { ...r.config.current, voice: { enabled: false } };
    expect((await open(r.url(session.id))).kind).toBe("destroyed");
  });

  it("voice running, then disabled in config without a restart: the config answer, a new upgrade and a live attachment all follow", async () => {
    const { voiceConfigResponse } = await import("../../gateway/voice-api.js");
    const r = await start();
    const session = newSession();
    const live = keep(await open(r.url(session.id)));
    const got = collect(live);
    live.send(hello());
    await waitFor(() => got.text.some((f) => f.type === "ready"));
    expect(voiceConfigResponse(r.config.current, { voiceRunning: () => true })).toMatchObject({ enabled: true });
    r.config.current = { ...r.config.current, voice: { enabled: false } };
    // The gateway tells voice about a reload through its emit tee.
    r.runtime.wrapEmit((() => undefined) as never)("config:reloaded" as never, {} as never);
    expect(await got.closed).toMatchObject({ reason: "disabled" });
    expect(got.text.filter((f) => f.type === "detached")).toEqual([{ type: "detached", reason: "disabled" }]);
    expect(r.runtime.hub.size()).toBe(0);
    expect(voiceConfigResponse(r.config.current, { voiceRunning: () => true })).toEqual({ enabled: false });
    expect((await open(r.url(newSession().id))).kind).toBe("destroyed");
  });

  it("a reload that makes the voice block invalid detaches a running voice like turning it off, and says why", async () => {
    const { voiceConfigResponse } = await import("../../gateway/voice-api.js");
    const r = await start();
    const session = newSession();
    const live = keep(await open(r.url(session.id)));
    const got = collect(live);
    live.send(hello());
    await waitFor(() => got.text.some((f) => f.type === "ready"));
    r.config.current = { ...r.config.current, voice: { ...(r.config.current.voice as object), vad: { silenceMs: 50 } } };
    r.runtime.wrapEmit((() => undefined) as never)("config:reloaded" as never, {} as never);
    expect(await got.closed).toMatchObject({ reason: "disabled" });
    expect(got.text.filter((f) => f.type === "detached")).toEqual([{ type: "detached", reason: "disabled" }]);
    expect(r.runtime.hub.size()).toBe(0);
    expect(voiceConfigResponse(r.config.current, { voiceRunning: () => true })).toMatchObject({ enabled: true, available: false, reason: expect.stringContaining("voice.vad.silenceMs") });
    expect((await open(r.url(newSession().id))).kind).toBe("destroyed");
  });

  it("an unrelated path is not taken", async () => {
    const r = await start();
    expect((await open(`ws://127.0.0.1:${r.port}/ws/voice`)).kind).toBe("destroyed");
    expect((await open(`ws://127.0.0.1:${r.port}/ws/voice/a/b`)).kind).toBe("destroyed");
  });

  it("refuses a caller that is not the operator, 403", async () => {
    const r = await start();
    const session = newSession();
    const outcome = await open(r.url(session.id), {});
    expect(outcome).toMatchObject({ kind: "refused", status: 403 });
  });

  it("tells a caller with no credential only that authentication is needed, without describing the endpoint", async () => {
    const r = await start();
    const outcome = await open(r.url(newSession().id), {});
    expect(outcome).toMatchObject({ kind: "refused", status: 403 });
    const body = (outcome as { body: string }).body;
    expect(body).toMatch(/Authentication is required/);
    expect(body).not.toMatch(/operator|sessions cannot speak/);
  });

  it("refuses a cross-origin browser, 403, even with the operator's credential", async () => {
    const r = await start();
    const session = newSession();
    const outcome = await open(r.url(session.id), { authorization: `Bearer ${OPERATOR_TOKEN}`, origin: "http://evil.example" });
    expect(outcome).toMatchObject({ kind: "refused", status: 403 });
    expect((outcome as { body: string }).body).toMatch(/own origin/);
    // The same origin as the Host is fine.
    const ok = await open(r.url(session.id), { authorization: `Bearer ${OPERATOR_TOKEN}`, origin: `http://127.0.0.1:${r.port}` });
    keep(ok);
  });

  it("refuses an agent session outside its reach, saying so; and one inside its reach is told voice is the operator's", async () => {
    const r = await start();
    const caller = newSession();
    const target = newSession();
    const child = newSession({ parentSessionId: caller.id });
    const asCaller = (sessionId: string) => ({
      [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
      [identity.CALLER_SESSION_HEADER]: sessionId,
      [identity.CALLER_SESSION_CAPABILITY_HEADER]: identity.ensureSessionCapability(sessionId),
    });
    const outside = await open(r.url(target.id), asCaller(caller.id));
    expect(outside).toMatchObject({ kind: "refused", status: 403 });
    expect((outside as { body: string }).body).toMatch(/outside your reach/);
    const inside = await open(r.url(child.id), asCaller(caller.id));
    expect(inside).toMatchObject({ kind: "refused", status: 403 });
    expect((inside as { body: string }).body).toMatch(/for the operator/);
    // An identity that does not verify is refused as a tool call that lost its identity.
    const forged = await open(r.url(target.id), { ...asCaller(caller.id), [identity.CALLER_SESSION_CAPABILITY_HEADER]: "forged" });
    expect(forged).toMatchObject({ kind: "refused", status: 403 });
  });

  it("404 for a session that does not exist, and for a terminal", async () => {
    const r = await start();
    expect(await open(r.url("no-such-session"))).toMatchObject({ kind: "refused", status: 404 });
    const terminal = newSession({ source: "terminal", engine: "terminal" });
    expect(await open(r.url(terminal.id))).toMatchObject({ kind: "refused", status: 404 });
  });

  it("404 for a session that was deleted", async () => {
    const r = await start();
    const session = newSession();
    registry.deleteSession(session.id);
    expect(await open(r.url(session.id))).toMatchObject({ kind: "refused", status: 404 });
  });

  it("another principal's attachment: accepted, then closed 4409 in_use, and the holder is undisturbed", async () => {
    const r = await start();
    const session = newSession();
    const held = new (await import("./fakes.js")).FakeSocket();
    expect(r.runtime.hub.attach(held, { sessionId: session.id, principal: { kind: "member", userId: "alice", userSessionId: "us1" } })).not.toBeNull();
    const ws = keep(await open(r.url(session.id)));
    const got = collect(ws);
    expect(await got.closed).toEqual({ code: VOICE_CLOSE.inUse, reason: "in_use" });
    expect(held.closed).toBeNull();
  });

  it("the attachment cap: the next one is accepted, then closed 4429 limit", async () => {
    const r = await start({ enabled: true, limits: { maxConcurrentAttachments: 1 } });
    const a = newSession();
    const b = newSession();
    keep(await open(r.url(a.id)));
    await waitFor(() => r.runtime.hub.size() === 1);
    const second = keep(await open(r.url(b.id)));
    expect(await collect(second).closed).toEqual({ code: VOICE_CLOSE.limit, reason: "limit" });
    expect(r.runtime.hub.size()).toBe(1);
  });

  it("the same operator on a second socket takes over: the first is sent detached{taken_over} and closed", async () => {
    const r = await start();
    const session = newSession();
    const first = keep(await open(r.url(session.id)));
    const firstGot = collect(first);
    first.send(hello());
    await waitFor(() => firstGot.text.some((f) => f.type === "ready"));
    const second = keep(await open(r.url(session.id)));
    const secondGot = collect(second);
    second.send(hello());
    await waitFor(() => secondGot.text.some((f) => f.type === "ready"));
    await firstGot.closed;
    expect(firstGot.text.filter((f) => f.type === "detached")).toEqual([{ type: "detached", reason: "taken_over" }]);
    expect(secondGot.text.some((f) => f.type === "detached")).toBe(false);
    expect(r.runtime.hub.size()).toBe(1);
  });

  it("bye ends it: the socket closes normally and the hub forgets the attachment", async () => {
    const r = await start();
    const session = newSession();
    const ws = keep(await open(r.url(session.id)));
    const got = collect(ws);
    ws.send(hello());
    await waitFor(() => got.text.some((f) => f.type === "ready"));
    ws.send(JSON.stringify({ type: "bye" }));
    expect((await got.closed).code).toBe(1000);
    await waitFor(() => r.runtime.hub.size() === 0);
  });

  it("a socket that drops without bye leaves the attachment suspended, ready to be picked up", async () => {
    const r = await start();
    const session = newSession();
    const ws = keep(await open(r.url(session.id)));
    const got = collect(ws);
    ws.send(hello());
    await waitFor(() => got.text.some((f) => f.type === "ready"));
    ws.terminate();
    await got.closed;
    await waitFor(() => r.runtime.hub.get(session.id)?.suspended === true);
    const back = keep(await open(r.url(session.id)));
    const backGot = collect(back);
    back.send(hello());
    await waitFor(() => backGot.text.some((f) => f.type === "ready"));
    expect(r.runtime.hub.size()).toBe(1);
  });

  it("deleting the session while attached ends voice mode with a reason and 4404", async () => {
    const r = await start();
    const session = newSession();
    const ws = keep(await open(r.url(session.id)));
    const got = collect(ws);
    ws.send(hello());
    await waitFor(() => got.text.some((f) => f.type === "ready"));
    r.runtime.hub.onEvent("session:deleted", { sessionId: session.id });
    expect((await got.closed).code).toBe(VOICE_CLOSE.sessionGone);
    expect(got.text.filter((f) => f.type === "detached")).toEqual([{ type: "detached", reason: "session_gone" }]);
  });

  it("a frame larger than the contract allows closes the socket rather than being buffered", async () => {
    const r = await start();
    const session = newSession();
    const ws = keep(await open(r.url(session.id)));
    const got = collect(ws);
    ws.send(hello());
    await waitFor(() => got.text.some((f) => f.type === "ready"));
    ws.send(Buffer.alloc(64 * 1024));
    expect((await got.closed).code).toBe(1009);
  });

  it("audio and speech run through a real socket: the final becomes the reply's speech as binary frames", async () => {
    const r = await start();
    const session = newSession();
    const ws = keep(await open(r.url(session.id)));
    const got = collect(ws);
    ws.send(hello());
    await waitFor(() => got.text.some((f) => f.type === "ready"));
    // Microphone audio reaches the VAD as sent.
    for (let i = 0; i < 5; i += 1) ws.send(Buffer.alloc(640, 1));
    await waitFor(() => (r.vads[0]?.written ?? 0) === 5 * 640);
    // A reply the session produces is spoken down the same socket.
    r.runtime.hub.onEvent("session:started", { sessionId: session.id });
    r.runtime.hub.onEvent("session:delta", { sessionId: session.id, type: "text", content: "Spoken over the wire. " });
    await waitFor(() => got.binary.length > 0);
    expect(got.binary[0].readUInt8(0)).toBe(1);
    expect(got.text.some((f) => f.type === "segment_start" && f.text === "Spoken over the wire.")).toBe(true);
  });
});
