import { describe, expect, it } from "vitest";
import { VOICE_KEEPALIVE_MS } from "../../shared/gateway-events.js";
import { createHarness, OPERATOR } from "./hub-harness.js";

describe("keepalive frames", () => {
  it("go out every interval while a client is attached, and nothing before the first interval", () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.clock.advance(VOICE_KEEPALIVE_MS - 1);
    expect(socket.ofType("keepalive")).toHaveLength(0);
    h.clock.advance(1);
    expect(socket.ofType("keepalive")).toEqual([{ type: "keepalive" }]);
    h.clock.advance(VOICE_KEEPALIVE_MS * 3);
    expect(socket.ofType("keepalive")).toHaveLength(4);
  });

  it("do not start before hello, and a refused hello starts none", () => {
    const h = createHarness();
    const { socket } = h.connect({ hello: false });
    h.clock.advance(VOICE_KEEPALIVE_MS * 3);
    expect(socket.ofType("keepalive")).toHaveLength(0);
    expect(h.clock.pending()).toBe(0);
  });

  it("stop when the socket closes, and leave no timer behind", () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.clock.advance(VOICE_KEEPALIVE_MS);
    h.hub.socketClosed(attachment, socket, 1006);
    socket.clear();
    h.clock.advance(VOICE_KEEPALIVE_MS * 5);
    expect(socket.ofType("keepalive")).toHaveLength(0);
    // Only the hub's suspend-window expiry is pending; no keepalive timer.
    expect(h.clock.pending()).toBe(1);
  });

  it("resume on the new socket after a suspension, and only on it", () => {
    const h = createHarness();
    const first = h.connect();
    h.hub.socketClosed(first.attachment, first.socket, 1006);
    const second = h.connect();
    h.clock.advance(VOICE_KEEPALIVE_MS * 2);
    expect(first.socket.ofType("keepalive")).toHaveLength(0);
    expect(second.socket.ofType("keepalive")).toHaveLength(2);
  });

  it("stop on bye", () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    attachment.onText(h.json({ type: "bye" }));
    h.clock.advance(VOICE_KEEPALIVE_MS * 3);
    expect(socket.ofType("keepalive")).toHaveLength(0);
    expect(h.clock.pending()).toBe(0);
  });

  it("stop on takeover: the old socket gets none, the new one starts its own", () => {
    const h = createHarness();
    const first = h.connect();
    const second = h.connect();
    h.clock.advance(VOICE_KEEPALIVE_MS * 2);
    expect(first.socket.ofType("keepalive")).toHaveLength(0);
    expect(second.socket.ofType("keepalive")).toHaveLength(2);
    expect(h.clock.pending()).toBe(1);
  });

  it("stop on detach (access lost, session gone) and on shutdown", () => {
    const h = createHarness();
    const a = h.connect({ sessionId: "a" });
    const b = h.connect({ sessionId: "b" });
    const c = h.connect({ sessionId: "c" });
    h.hub.revoke("a", OPERATOR);
    h.hub.shutdown();
    h.clock.advance(VOICE_KEEPALIVE_MS * 3);
    for (const { socket } of [a, b, c]) expect(socket.ofType("keepalive")).toHaveLength(0);
    expect(h.clock.pending()).toBe(0);
  });
});
