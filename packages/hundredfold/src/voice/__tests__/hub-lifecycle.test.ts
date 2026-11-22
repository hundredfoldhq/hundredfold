import { describe, expect, it } from "vitest";
import { VOICE_CLOSE } from "../../shared/gateway-events.js";
import { RESUME_WINDOW_MS } from "../hub.js";
import { createHarness, OPERATOR, SESSION } from "./hub-harness.js";

const member = (id: string) => ({ kind: "member" as const, userId: id, userSessionId: `us-${id}` });

describe("attachment lifecycle and limits", () => {
  it("hello is answered with ready, per the contract", () => {
    const h = createHarness({ engine: { soft: { preserves: true }, steerable: true } });
    const { socket } = h.connect();
    expect(socket.ofType("ready")).toEqual([{
      type: "ready", protocol: 1, sessionId: SESSION,
      input: { encoding: "pcm16", sampleRate: 16_000 }, output: { encoding: "pcm16", sampleRate: 24_000 },
      stt: { provider: "fake-stt", partials: true }, tts: { provider: "fake-tts", voice: "af_test" },
      onset: { threshold: 0.02, minSpeechMs: 250 }, backgrounding: "native", limits: { maxUtteranceSeconds: 60 },
    }]);
  });

  it.each([
    ["a soft interrupt that keeps long work running", { soft: { preserves: true } }, true, "native"],
    ["the same with backgrounding turned off, steerable", { soft: { preserves: true }, steerable: true }, false, "steer"],
    ["the same with backgrounding turned off, not steerable", { soft: { preserves: true } }, false, "none"],
    ["a soft interrupt that does not keep it, steerable", { soft: { preserves: false }, steerable: true }, true, "steer"],
    ["steer only", { steerable: true }, true, "steer"],
    ["neither", {}, true, "none"],
  ] as const)("reports backgrounding from the engine's capabilities: %s", (_name, engine, autoBackground, expected) => {
    const h = createHarness({ engine, config: { autoBackground: { enabled: autoBackground, afterSeconds: 5 } } });
    expect(h.connect().socket.ofType("ready")[0].backgrounding).toBe(expected);
  });

  it("a frame before hello is a bad_frame; audio before hello too", () => {
    const h = createHarness();
    const { socket, attachment } = h.connect({ hello: false });
    attachment.onText(h.json({ type: "ptt_down" }));
    attachment.onBinary(Buffer.alloc(640));
    expect(socket.ofType("error").map((f) => f.code)).toEqual(["bad_frame", "bad_frame"]);
    expect(socket.ofType("ready")).toHaveLength(0);
  });

  it("unreadable frames, odd or oversized or empty audio, an unknown mode: bad_frame, and the attachment lives on", () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    attachment.onText("{not json");
    attachment.onText(h.json({ nope: 1 }));
    attachment.onBinary(Buffer.alloc(641));
    attachment.onBinary(Buffer.alloc(4098));
    attachment.onBinary(Buffer.alloc(0));
    expect(socket.ofType("error").map((f) => f.code)).toEqual(["bad_frame", "bad_frame", "bad_frame", "bad_frame", "bad_frame"]);
    expect(socket.closed).toBeNull();
    const other = h.connect({ hello: false, sessionId: "s2" });
    other.attachment.onText(h.json({ type: "hello", protocol: 1, mode: "shouting", client: "web" }));
    expect(other.socket.ofType("error")[0].code).toBe("bad_frame");
  });

  it("an unsupported protocol version closes 4400", () => {
    const h = createHarness();
    const { socket, attachment } = h.connect({ hello: false });
    attachment.onText(h.json({ type: "hello", protocol: 2, mode: "hands-free", client: "web" }));
    expect(socket.closed?.code).toBe(VOICE_CLOSE.protocolError);
  });

  it("the same principal opening it again takes over: the old one is told and closed, the new one is ready", () => {
    const h = createHarness();
    const first = h.connect();
    const second = h.connect();
    expect(first.socket.ofType("detached")).toEqual([{ type: "detached", reason: "taken_over" }]);
    expect(first.socket.closed?.code).toBe(1000);
    expect(second.socket.ofType("ready")).toHaveLength(1);
    expect(h.hub.size()).toBe(1);
    expect(h.hub.get(SESSION)).toBe(second.attachment);
  });

  it("a different principal is refused 4409 and the one in voice mode is not disturbed", () => {
    const h = createHarness();
    const first = h.connect({ principal: member("alice") });
    const refused = h.connect({ principal: member("bob") });
    expect(refused.attachment).toBeNull();
    expect(refused.socket.closed).toEqual({ code: VOICE_CLOSE.inUse, reason: "in_use" });
    expect(first.socket.closed).toBeNull();
    expect(first.socket.ofType("detached")).toHaveLength(0);
    // The operator is a different principal from a member, too.
    expect(h.connect({ principal: OPERATOR }).socket.closed?.code).toBe(VOICE_CLOSE.inUse);
  });

  it("the attachment cap refuses 4429, but a take-over of a session already held is not a new one", () => {
    const h = createHarness({ config: { limits: { maxUtteranceSeconds: 60, maxConcurrentAttachments: 2 } } });
    h.connect({ sessionId: "a" });
    h.connect({ sessionId: "b" });
    const over = h.connect({ sessionId: "c" });
    expect(over.attachment).toBeNull();
    expect(over.socket.closed).toEqual({ code: VOICE_CLOSE.limit, reason: "limit" });
    const again = h.connect({ sessionId: "b" });
    expect(again.socket.ofType("ready")).toHaveLength(1);
    expect(h.hub.size()).toBe(2);
  });

  it("a freed slot is usable again", () => {
    const h = createHarness({ config: { limits: { maxUtteranceSeconds: 60, maxConcurrentAttachments: 1 } } });
    const a = h.connect({ sessionId: "a" });
    a.attachment.onText(h.json({ type: "bye" }));
    expect(a.socket.closed?.code).toBe(1000);
    expect(h.hub.size()).toBe(0);
    expect(h.connect({ sessionId: "b" }).socket.ofType("ready")).toHaveLength(1);
  });

  it("voice off: nothing attaches, and the client is told voice is off, not that its chat is gone", () => {
    const h = createHarness();
    h.state.config = null;
    const { socket, attachment } = h.connect();
    expect(attachment).toBeNull();
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "disabled" }]);
    expect(socket.closed).toMatchObject({ code: 1000, reason: "disabled" });
  });

  it.each([
    ["session:deleted", "session_gone", VOICE_CLOSE.sessionGone],
    ["session:stopped", "session_gone", VOICE_CLOSE.sessionGone],
  ])("%s ends voice mode with a reason", (event, reason, code) => {
    const h = createHarness();
    const { socket } = h.connect();
    h.event(event);
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason }]);
    expect(socket.closed?.code).toBe(code);
    expect(h.hub.size()).toBe(0);
  });

  it("an event for another session leaves this one alone", () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.hub.onEvent("session:deleted", { sessionId: "elsewhere" });
    expect(socket.closed).toBeNull();
  });

  it("voice turned off by a config reload ends every attachment, with a reason", () => {
    const h = createHarness();
    const a = h.connect({ sessionId: "a" });
    const b = h.connect({ sessionId: "b" });
    h.state.config = null;
    h.hub.onEvent("config:reloaded", {});
    for (const { socket } of [a, b]) {
      expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "disabled" }]);
      expect(socket.closed).not.toBeNull();
    }
    expect(h.hub.size()).toBe(0);
  });

  it("losing access ends it with 4401; shutdown ends it with 1001", () => {
    const h = createHarness();
    const a = h.connect({ sessionId: "a" });
    h.hub.revoke("a", OPERATOR);
    expect(a.socket.ofType("detached")).toEqual([{ type: "detached", reason: "access_lost" }]);
    expect(a.socket.closed?.code).toBe(VOICE_CLOSE.accessLost);
    const b = h.connect({ sessionId: "b" });
    h.hub.shutdown();
    expect(b.socket.ofType("detached")).toEqual([{ type: "detached", reason: "shutdown" }]);
    expect(b.socket.closed?.code).toBe(1001);
  });

  it("revoke ends only the attachment whose principal lost access", () => {
    const h = createHarness();
    const pat = h.connect({ sessionId: "m", principal: member("pat") });
    h.hub.revoke("m", member("sam")); // another member
    h.hub.revoke("m", OPERATOR);
    h.hub.revoke("other-session", member("pat"));
    expect(pat.socket.ofType("detached")).toEqual([]);
    expect(pat.socket.closed).toBeNull();
    expect(h.hub.size()).toBe(1);
    h.hub.revoke("m", member("pat"));
    expect(pat.socket.ofType("detached")).toEqual([{ type: "detached", reason: "access_lost" }]);
    expect(pat.socket.closed?.code).toBe(VOICE_CLOSE.accessLost);
    expect(h.hub.size()).toBe(0);
  });

  it("revoke for one sign-in leaves the same member's attachment from another sign-in alone", () => {
    const h = createHarness();
    const pat = h.connect({ sessionId: "m", principal: member("pat") });
    h.hub.revoke("m", { kind: "member", userId: "pat", userSessionId: "us-other-device" });
    expect(pat.socket.ofType("detached")).toEqual([]);
    expect(pat.socket.closed).toBeNull();
    h.hub.revoke("m", member("pat"));
    expect(pat.socket.closed?.code).toBe(VOICE_CLOSE.accessLost);
  });

  it("a sign-in that picks up a suspended attachment is the one whose revoke ends it", () => {
    const h = createHarness();
    const first = h.connect({ sessionId: "m", principal: { kind: "member", userId: "pat", userSessionId: "us-a" } });
    h.hub.socketClosed(first.attachment, first.socket, 1006);
    const second = h.connect({ sessionId: "m", principal: { kind: "member", userId: "pat", userSessionId: "us-b" } });
    expect(second.attachment).toBe(first.attachment);
    h.hub.revoke("m", { kind: "member", userId: "pat", userSessionId: "us-a" });
    expect(second.socket.closed).toBeNull();
    h.hub.revoke("m", { kind: "member", userId: "pat", userSessionId: "us-b" });
    expect(second.socket.ofType("detached")).toEqual([{ type: "detached", reason: "access_lost" }]);
    expect(second.socket.closed?.code).toBe(VOICE_CLOSE.accessLost);
  });

  it("a provider that is down is reported as speech_unavailable with a reason that carries no address, and the socket closes", () => {
    const h = createHarness();
    h.stt.available = false;
    h.stt.reason = "Cannot reach https://user:secret-token@speech.internal:8443/v1?key=abc123 right now";
    const { socket } = h.connect();
    const error = socket.ofType("error")[0];
    expect(error.code).toBe("speech_unavailable");
    expect(JSON.stringify(error)).not.toMatch(/secret-token|abc123|speech\.internal|https?:/);
    expect(socket.closed?.code).toBe(1000);
    expect(socket.ofType("ready")).toHaveLength(0);
  });

  describe("a socket that closes", () => {
    it.each([1000, 1001, VOICE_CLOSE.accessLost, VOICE_CLOSE.sessionGone, VOICE_CLOSE.protocolError])("with %s ends voice mode", (code) => {
      const h = createHarness();
      const { socket, attachment } = h.connect();
      h.hub.socketClosed(attachment, socket, code);
      expect(h.hub.size()).toBe(0);
    });

    it.each([1005, 1009])("%i (no status, an oversize frame) ends the attachment at once and frees its slot", (code) => {
      const h = createHarness();
      const { socket, attachment } = h.connect();
      h.hub.socketClosed(attachment, socket, code);
      expect(h.hub.size()).toBe(0);
      expect(attachment.suspended).toBe(false);
    });

    it("without a goodbye (1006) leaves the attachment suspended for ten minutes, then drops it", () => {
      const h = createHarness();
      const { socket, attachment } = h.connect();
      h.hub.socketClosed(attachment, socket, 1006);
      expect(h.hub.size()).toBe(1);
      expect(attachment.suspended).toBe(true);
      h.clock.advance(RESUME_WINDOW_MS - 1);
      expect(h.hub.size()).toBe(1);
      h.clock.advance(2);
      expect(h.hub.size()).toBe(0);
    });

    it("after bye ends it even if the close code looks like a suspension", () => {
      const h = createHarness();
      const { socket, attachment } = h.connect();
      attachment.onText(h.json({ type: "bye" }));
      h.hub.socketClosed(attachment, socket, 1006);
      expect(h.hub.size()).toBe(0);
    });

    it("a stale socket's close changes nothing once a newer socket has the attachment", () => {
      const h = createHarness();
      const first = h.connect();
      h.hub.socketClosed(first.attachment, first.socket, 1006);
      const second = h.connect();
      expect(second.attachment).toBe(first.attachment);
      h.hub.socketClosed(first.attachment, first.socket, 1006);
      expect(first.attachment.owns(second.socket)).toBe(true);
      expect(h.hub.size()).toBe(1);
    });

    it("another principal is refused while one is suspended", () => {
      const h = createHarness();
      const { socket, attachment } = h.connect({ principal: member("alice") });
      h.hub.socketClosed(attachment, socket, 1006);
      expect(h.connect({ principal: member("bob") }).socket.closed?.code).toBe(VOICE_CLOSE.inUse);
    });
  });
});
