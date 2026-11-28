import { describe, expect, it } from "vitest";
import { RESUME_WINDOW_MS } from "../hub.js";
import type { VoicePrincipal } from "../hub-types.js";
import { voiceEndsSuspended } from "../paths.js";
import { createHarness, SESSION, type Harness } from "./hub-harness.js";
import { FakeSocket, settle } from "./fakes.js";

/** A pause the user asked for: the client closes with a code that is not an ending one, so the attachment is kept. */
const USER_PAUSE = 4000;

function harness() {
  const h = createHarness();
  const discarded: string[] = [];
  h.deps.discardIfEmptySpokenStart = (id) => { discarded.push(id); };
  return { h, discarded };
}

function pause(h: Harness, c: ReturnType<Harness["connect"]>): void {
  h.hub.socketClosed(c.attachment, c.socket, USER_PAUSE);
}

/** The goodbye of a client that paused and then ended voice mode: `/ws/voice/:id?end=suspended`. */
function endSuspended(h: Harness, principal: VoicePrincipal = { kind: "operator" }, sessionId = SESSION) {
  const socket = new FakeSocket();
  const attachment = h.hub.attach(socket, { sessionId, principal, endSuspended: true });
  return { socket, attachment };
}

describe("ending a conversation the client left suspended (`?end=suspended`)", () => {
  it("ends it as a bye would: the slot is free, the empty start is discarded and the socket is closed at once", () => {
    const { h, discarded } = harness();
    const first = h.connect();
    pause(h, first);
    expect(h.hub.size()).toBe(1);
    const end = endSuspended(h);
    expect(end.attachment).toBeNull();
    expect(end.socket.closed).toEqual({ code: 1000, reason: "bye" });
    expect(end.socket.sent).toEqual([]);
    expect(h.hub.size()).toBe(0);
    expect(discarded).toEqual([SESSION]);
    // The resume window it no longer waits out changes nothing when it passes.
    h.clock.advance(RESUME_WINDOW_MS);
    expect(discarded).toEqual([SESSION]);
  });

  it("drops the replies it held: a later start on the chat is a fresh conversation with nothing missed", async () => {
    const { h } = harness();
    const first = h.connect();
    h.state.replyMessage = "assistant-9";
    pause(h, first);
    await h.reply("Finished while paused.");
    endSuspended(h);
    const later = h.connect();
    expect(later.attachment).not.toBe(first.attachment);
    later.attachment.onText(h.json({ type: "resume", suspendedMs: 1_000 }));
    await settle();
    expect(later.socket.ofType("missed")).toEqual([]);
    expect(later.socket.ofType("segment_start")).toEqual([]);
  });

  it("leaves a live attachment alone: another tab of the same principal that took the conversation over carries on", () => {
    const { h, discarded } = harness();
    const paused = h.connect();
    pause(h, paused);
    const other = h.connect();
    expect(other.attachment).toBe(paused.attachment);
    const end = endSuspended(h);
    expect(end.socket.closed).toEqual({ code: 1000, reason: "bye" });
    expect(h.hub.get(SESSION)).toBe(other.attachment);
    expect(other.socket.closed).toBeNull();
    expect(other.socket.ofType("detached")).toEqual([]);
    expect(discarded).toEqual([]);
  });

  it("leaves an attachment alone while another socket is picking it up, before its hello", () => {
    const { h, discarded } = harness();
    const paused = h.connect();
    pause(h, paused);
    const adopting = h.connect({ hello: false });
    expect(h.hub.get(SESSION)?.suspended).toBe(true); // still suspended until the hello, but a socket is attached
    endSuspended(h);
    expect(h.hub.get(SESSION)).toBe(adopting.attachment);
    expect(adopting.socket.closed).toBeNull();
    expect(discarded).toEqual([]);
  });

  it("leaves a running conversation alone", () => {
    const { h, discarded } = harness();
    const live = h.connect();
    endSuspended(h);
    expect(h.hub.get(SESSION)).toBe(live.attachment);
    expect(live.socket.closed).toBeNull();
    expect(live.socket.ofType("detached")).toEqual([]);
    expect(discarded).toEqual([]);
  });

  it("leaves another principal's suspended attachment alone", () => {
    const { h, discarded } = harness();
    const alice: VoicePrincipal = { kind: "member", userId: "u-a", userSessionId: "us-a" };
    const bob: VoicePrincipal = { kind: "member", userId: "u-b", userSessionId: "us-b" };
    const held = h.connect({ principal: alice });
    pause(h, held);
    endSuspended(h, bob);
    endSuspended(h, { kind: "operator" });
    expect(h.hub.get(SESSION)).toBe(held.attachment);
    expect(discarded).toEqual([]);
    endSuspended(h, alice);
    expect(h.hub.size()).toBe(0);
    expect(discarded).toEqual([SESSION]);
  });

  it("with nothing on the session it creates nothing and takes no slot", () => {
    const { h, discarded } = harness();
    const end = endSuspended(h);
    expect(end.attachment).toBeNull();
    expect(end.socket.closed).toEqual({ code: 1000, reason: "bye" });
    expect(h.hub.size()).toBe(0);
    expect(discarded).toEqual([]);
  });

  it("with voice turned off it is answered as any other socket then", () => {
    const { h } = harness();
    h.state.config = null;
    const end = endSuspended(h);
    expect(end.socket.ofType("detached")).toEqual([{ type: "detached", reason: "disabled" }]);
    expect(end.socket.closed).toMatchObject({ code: 1000 });
  });
});

describe("voiceEndsSuspended", () => {
  it("reads only `end=suspended` from the query", () => {
    expect(voiceEndsSuspended("/ws/voice/s1?end=suspended")).toBe(true);
    expect(voiceEndsSuspended("/ws/voice/s1?x=1&end=suspended")).toBe(true);
    expect(voiceEndsSuspended("/ws/voice/s1")).toBe(false);
    expect(voiceEndsSuspended("/ws/voice/s1?end=all")).toBe(false);
    expect(voiceEndsSuspended("/ws/voice/s1?end")).toBe(false);
  });
});
