import { describe, expect, it } from "vitest";
import { END_GRACE_MS, END_REQUEST_TTL_MS } from "../attachment.js";
import { createHarness, playedAll, SESSION } from "./hub-harness.js";
import { settle } from "./fakes.js";

/** The turn the tool is called in: a goodbye is streamed, and the turn ends. */
async function goodbye(h: ReturnType<typeof createHarness>, text = "Goodbye, talk soon."): Promise<void> {
  h.event("session:started");
  h.delta("text", text);
  h.event("session:completed", { result: text, error: null });
  await settle();
}

describe("hanging up a call from the assistant's side", () => {
  it("says there is no call when no client is attached", () => {
    const h = createHarness();
    expect(h.hub.endCall(SESSION)).toBe("no-call");
  });

  it("does not cut the goodbye: the call ends once the turn is over and the goodbye has been played", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    expect(h.hub.endCall(SESSION)).toBe("ending");
    // The tool was called mid-turn: nothing ends yet, and the goodbye is still to come.
    expect(socket.closed).toBeNull();
    await goodbye(h);
    expect(socket.ofType("segment_start").length).toBeGreaterThan(0);
    expect(socket.closed).toBeNull();
    playedAll(socket, attachment);
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
    expect(socket.closed?.code).toBe(1000);
    expect(h.hub.size()).toBe(0);
  });

  it("waits for every sentence of the goodbye, not just the first", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.hub.endCall(SESSION);
    await goodbye(h, "Sure thing. Goodbye for now. Talk soon.");
    const starts = socket.ofType("segment_start");
    expect(starts.length).toBeGreaterThan(1);
    attachment.onText(JSON.stringify({ type: "played", segmentId: starts[0].segmentId }));
    expect(socket.closed).toBeNull();
    playedAll(socket, attachment);
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
  });

  it("ends at once when the turn had nothing to say", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.hub.endCall(SESSION);
    h.event("session:started");
    h.event("session:completed", { result: "", error: null });
    await settle();
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
  });

  it("ends after a bounded wait when the client never reports the goodbye played", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.hub.endCall(SESSION);
    await goodbye(h);
    h.clock.advance(END_GRACE_MS - 1);
    expect(socket.closed).toBeNull();
    h.clock.advance(2);
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
    expect(h.hub.size()).toBe(0);
  });

  it("a user who speaks after asking keeps the call: the pending hang-up is dropped", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.hub.endCall(SESSION);
    await goodbye(h);
    await h.say(attachment, "wait, one more thing");
    playedAll(socket, attachment);
    // A later bit of noise must not revive the dropped hang-up.
    await h.say(attachment, "   ");
    playedAll(socket, attachment);
    h.clock.advance(END_GRACE_MS * 2);
    expect(socket.ofType("detached")).toEqual([]);
    expect(socket.closed).toBeNull();
    expect(h.hub.size()).toBe(1);
  });

  it("noise with no words does not drop the hang-up", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.hub.endCall(SESSION);
    await goodbye(h);
    await h.say(attachment, "   ");
    playedAll(socket, attachment);
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
  });

  it("someone mid-sentence when the goodbye finishes holds the hang-up until their words are known", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.hub.endCall(SESSION);
    await goodbye(h);
    h.vad().start();
    h.audio(attachment, 10);
    playedAll(socket, attachment);
    h.clock.advance(END_GRACE_MS * 2);
    expect(socket.ofType("detached")).toEqual([]);
    // Nothing intelligible came of it: the goodbye that was talked over carries on, and the call ends after it as asked.
    h.vad().end();
    h.stt.last().final("");
    await settle();
    playedAll(socket, attachment);
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
  });

  it("a failed recognition while the hang-up is held lets it through", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.hub.endCall(SESSION);
    await goodbye(h);
    h.vad().start();
    h.audio(attachment, 10);
    h.stt.last().emit({ type: "error", message: "stt down" });
    await settle();
    playedAll(socket, attachment);
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
  });

  it("asking twice is the same as asking once", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.hub.endCall(SESSION);
    h.hub.endCall(SESSION);
    await goodbye(h);
    playedAll(socket, attachment);
    expect(socket.ofType("detached")).toHaveLength(1);
  });

  it("a played report before the turn ends does not end the call", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.event("session:started");
    h.delta("text", "Let me wrap this up. ");
    await settle();
    h.hub.endCall(SESSION);
    playedAll(socket, attachment);
    expect(socket.closed).toBeNull();
    h.delta("text", "Goodbye.");
    h.event("session:completed", { result: "Let me wrap this up. Goodbye.", error: null });
    await settle();
    playedAll(socket, attachment);
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
  });

  it("a hang-up that comes due while the client is away is carried out, and told, when the client returns", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.hub.socketClosed(attachment, socket, 1006);
    expect(attachment.suspended).toBe(true);
    h.hub.endCall(SESSION);
    await goodbye(h);
    // Still within the resume window: nothing to tell yet, and the grace period is not what ends it.
    h.clock.advance(END_GRACE_MS * 2);
    expect(h.hub.size()).toBe(1);
    const back = h.connect();
    expect(back.socket.ofType("ready")).toEqual([]);
    expect(back.socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
    expect(back.socket.closed?.code).toBe(1000);
    expect(h.hub.size()).toBe(0);
  });

  it("an utterance that died with a dropped connection no longer holds the hang-up", async () => {
    const h = createHarness();
    const first = h.connect();
    h.hub.endCall(SESSION);
    await goodbye(h);
    h.vad().start();
    h.audio(first.attachment, 10);
    playedAll(first.socket, first.attachment);
    expect(first.socket.closed).toBeNull();
    h.hub.socketClosed(first.attachment, first.socket, 1006);
    const back = h.connect();
    expect(back.socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
    expect(h.hub.size()).toBe(0);
  });

  it("a user already mid-utterance when the hang-up is asked for is heard out first", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.event("session:started");
    h.vad().start();
    h.audio(attachment, 10);
    h.hub.endCall(SESSION);
    h.delta("text", "Goodbye.");
    h.event("session:completed", { result: "Goodbye.", error: null });
    await settle();
    playedAll(socket, attachment);
    h.clock.advance(END_GRACE_MS * 2);
    expect(socket.ofType("detached")).toEqual([]);
    // Their words keep the call.
    h.vad().end();
    h.stt.last().final("actually, one more thing");
    await settle();
    playedAll(socket, attachment);
    expect(socket.ofType("detached")).toEqual([]);
    expect(h.hub.size()).toBe(1);
  });

  it("a hang-up pending when a second tab takes the call over ends the call there too", async () => {
    const h = createHarness();
    const first = h.connect();
    h.hub.endCall(SESSION);
    const second = h.connect();
    expect(first.socket.ofType("detached")).toEqual([{ type: "detached", reason: "taken_over" }]);
    await goodbye(h);
    playedAll(second.socket, second.attachment);
    expect(second.socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
    expect(h.hub.size()).toBe(0);
  });

  it("a takeover after the asking turn already ended ends the new call at once", async () => {
    const h = createHarness();
    const first = h.connect();
    h.hub.endCall(SESSION);
    await goodbye(h);
    expect(first.socket.closed).toBeNull();
    const second = h.connect({ hello: false });
    expect(second.socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
    expect(h.hub.size()).toBe(0);
  });

  it("a request made outside any turn expires instead of ending some later turn", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.hub.endCall(SESSION);
    h.clock.advance(END_REQUEST_TTL_MS + 1);
    await goodbye(h);
    playedAll(socket, attachment);
    h.clock.advance(END_GRACE_MS * 2);
    expect(socket.ofType("detached")).toEqual([]);
    expect(h.hub.size()).toBe(1);
  });

  it("leaves other sessions' calls alone", async () => {
    const h = createHarness();
    const mine = h.connect();
    const other = h.connect({ sessionId: "s2" });
    h.hub.endCall(SESSION);
    await goodbye(h, "Bye.");
    playedAll(mine.socket, mine.attachment);
    expect(mine.socket.closed).not.toBeNull();
    expect(other.socket.closed).toBeNull();
    expect(h.hub.get("s2")).toBe(other.attachment);
  });

  it("a hang-up from a member's call ends it the same way", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect({ principal: { kind: "member", userId: "u1", userSessionId: "us-u1" } });
    h.hub.endCall(SESSION);
    await goodbye(h);
    playedAll(socket, attachment);
    expect(socket.ofType("detached")).toEqual([{ type: "detached", reason: "ended" }]);
  });
});
