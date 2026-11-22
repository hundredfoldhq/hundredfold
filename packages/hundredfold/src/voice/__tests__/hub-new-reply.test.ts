import { describe, expect, it } from "vitest";
import { createHarness, SESSION, type Harness } from "./hub-harness.js";
import { settle } from "./fakes.js";

/** Say hello on a fresh socket and bye on it, as one tap-to-tap run of voice mode does. */
async function runAndStop(h: Harness, spoken: string): Promise<void> {
  const { attachment } = h.connect();
  await h.say(attachment, spoken);
  await h.reply("First answer.");
  attachment.onText(h.json({ type: "bye" }));
  await settle();
}

describe("a new reply jumps to the new text", () => {
  it("a reply that starts while the last one is still queued or playing cuts it and speaks only the new text", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.event("session:started");
    h.delta("text", "Old one. Old two. Old three. ");
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toContain("Old one.");
    h.event("session:completed", { result: "Old one. Old two. Old three.", error: null });
    await settle();
    socket.clear();

    h.event("session:started");
    h.delta("text", "New answer. ");
    h.event("session:completed", { result: "New answer.", error: null });
    await settle();

    expect(socket.ofType("stop_playback")).toEqual([{ type: "stop_playback", reason: "new_reply" }]);
    const spoken = socket.ofType("segment_start").map((f) => f.text);
    expect(spoken).toEqual(["New answer."]);
    // The cut reply's stored message keeps what was heard, not what was sent.
    expect(h.merges.some((m) => (m.patch as { voice: { interrupted?: boolean } }).voice.interrupted === true)).toBe(true);
  });

  it("sentences of the old reply still waiting on synthesis are never spoken", async () => {
    const h = createHarness();
    let release!: () => void;
    h.tts.gate = new Promise<void>((resolve) => { release = resolve; });
    const { socket } = h.connect();
    h.event("session:started");
    h.delta("text", "Old one. Old two. Old three. ");
    h.event("session:completed", { result: "Old one. Old two. Old three.", error: null });
    await settle();
    expect(socket.ofType("segment_start")).toHaveLength(0);

    h.event("session:started");
    h.delta("text", "Fresh start. ");
    h.event("session:completed", { result: "Fresh start.", error: null });
    release();
    await settle();

    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Fresh start."]);
  });

  it("with nothing of the old reply left to hear, a new reply sends no stop", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await h.reply("Done. ");
    for (const start of socket.ofType("segment_start")) attachment.onText(h.json({ type: "played", segmentId: start.segmentId }));
    await settle();
    socket.clear();
    await h.reply("Another.");
    expect(socket.ofType("stop_playback")).toHaveLength(0);
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Another."]);
  });

  it("a holding line on its own is not cut by the turn that follows it", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    // The holding line is the only thing pending: speak it directly through the pipeline.
    (attachment as unknown as { voice: { speakHolding(line: string): void } }).voice.speakHolding("One moment.");
    await settle();
    socket.clear();
    h.event("session:started");
    await settle();
    expect(socket.ofType("stop_playback")).toHaveLength(0);
  });
});

describe("voice stopped and started again", () => {
  it("a message sent after voice stopped is not spoken: nothing is attached, and nothing is replayed on the next start", async () => {
    const h = createHarness();
    await runAndStop(h, "first question");
    expect(h.hub.size()).toBe(0);

    // The second message arrives with voice off: no attachment, so nothing to speak it.
    await h.reply("Second answer, typed while voice was off.");

    const second = h.connect();
    await settle();
    expect(second.socket.ofType("ready")).toHaveLength(1);
    expect(second.socket.ofType("missed")).toHaveLength(0);
    expect(second.socket.ofType("segment_start")).toHaveLength(0);
    expect(second.socket.audio()).toHaveLength(0);
  });

  it("starts, stops and starts again as often as asked, in the same chat and in another", async () => {
    const h = createHarness();
    for (let run = 0; run < 3; run += 1) {
      const { socket, attachment } = h.connect();
      expect(socket.ofType("ready")).toHaveLength(1);
      expect(h.hub.size()).toBe(1);
      await h.say(attachment, `question ${run}`);
      await h.reply(`Answer ${run}.`);
      expect(socket.ofType("segment_start").map((f) => f.text)).toEqual([`Answer ${run}.`]);
      attachment.onText(h.json({ type: "bye" }));
      await settle();
      expect(h.hub.size()).toBe(0);
    }
    const other = h.connect({ sessionId: "s2" });
    expect(other.socket.ofType("ready")).toHaveLength(1);
    await h.say(other.attachment, "in another chat");
    expect(h.delivered.at(-1)).toMatchObject({ text: "in another chat" });
    expect(h.hub.get("s2")).toBe(other.attachment);
  });

  it("a stop whose goodbye never arrives does not keep the next start from the chat", async () => {
    const h = createHarness();
    const first = h.connect();
    await h.say(first.attachment, "first question");
    const again = h.connect(); // the same sign-in starts again before the old socket's close is seen
    expect(first.socket.ofType("detached")).toEqual([{ type: "detached", reason: "taken_over" }]);
    expect(again.socket.ofType("ready")).toHaveLength(1);
    expect(h.hub.get(SESSION)).toBe(again.attachment);
  });

  it("after a stop and restart, a reply that arrives while another is still playing speaks only the new one", async () => {
    const h = createHarness();
    await runAndStop(h, "first question");
    const { socket, attachment } = h.connect();
    await h.say(attachment, "second question");
    h.event("session:started");
    h.delta("text", "Second one. Second two. Second three. ");
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toContain("Second one.");
    h.event("session:completed", { result: "Second one. Second two. Second three.", error: null });
    await settle();
    socket.clear();

    // A message typed while that is still being spoken.
    h.event("session:started");
    h.delta("text", "Typed answer. ");
    h.event("session:completed", { result: "Typed answer.", error: null });
    await settle();

    expect(socket.ofType("stop_playback")).toEqual([{ type: "stop_playback", reason: "new_reply" }]);
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Typed answer."]);
    expect(socket.audio().length).toBeGreaterThan(0);
  });

  it("an engine's own report arriving while a reply plays jumps to the report; one arriving mid-stream queues with it", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.event("session:started");
    h.delta("text", "Chat one. Chat two. ");
    h.event("session:completed", { result: "Chat one. Chat two.", error: null });
    await settle();
    socket.clear();
    h.externalTurn("The background job is done.");
    await settle();
    expect(socket.ofType("stop_playback")).toEqual([{ type: "stop_playback", reason: "new_reply" }]);
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["The background job is done."]);
  });

  it("connections that dropped and were never reopened do not use up the gateway: the longest-suspended makes room, a live one never does", async () => {
    const h = createHarness({ config: { limits: { maxUtteranceSeconds: 60, maxConcurrentAttachments: 3 } } });
    const dropped = ["a", "b"].map((id) => {
      const c = h.connect({ sessionId: id });
      h.clock.advance(1000);
      h.hub.socketClosed(c.attachment, c.socket as never, 1006); // the network went away: no goodbye
      return c;
    });
    const live = h.connect({ sessionId: "c" });
    expect(h.hub.size()).toBe(3);

    const fresh = h.connect({ sessionId: "d" });
    expect(fresh.socket.ofType("ready")).toHaveLength(1);
    expect(fresh.socket.closed).toBeNull();
    // The one that had been gone longest was let go; the other still waits for its client, and so does the live one.
    expect(h.hub.get("a")).toBeUndefined();
    expect(h.hub.get("b")).toBe(dropped[1].attachment);
    expect(h.hub.get("c")).toBe(live.attachment);

    // Only a live attachment is left to refuse with once nothing is suspended.
    const evicted = h.connect({ sessionId: "e" });
    expect(h.hub.get("b")).toBeUndefined();
    expect(evicted.socket.ofType("ready")).toHaveLength(1);
    const refused = h.connect({ sessionId: "f" });
    expect(refused.socket.closed).toMatchObject({ code: 4429 });
    expect(h.hub.get("c")).toBe(live.attachment);
  });
});

