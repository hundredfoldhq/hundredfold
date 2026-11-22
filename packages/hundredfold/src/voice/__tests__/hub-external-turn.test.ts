import { describe, expect, it } from "vitest";
import { createHarness } from "./hub-harness.js";
import { settle } from "./fakes.js";

/**
 * A reply the engine writes on its own (the CLI reporting finished background work) is not a gateway turn: no
 * session event streams it. It reaches the hub only as `session:external-turn`, after the sync stored it.
 */
describe("replies the engine wrote outside a gateway turn (FR-016)", () => {
  it("speaks the stored reply, names its message, and records what was spoken", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    const [id] = h.externalTurn("The build finished. All tests passed.");
    await settle();
    expect(socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([
      ["The build finished.", id], ["All tests passed.", id],
    ]);
    expect(socket.audio().length).toBeGreaterThan(0);
    expect(h.merges).toEqual([{ id, patch: { voice: { spokenText: "The build finished. All tests passed." } } }]);
  });

  it("speaks each new assistant message in order, and skips user, system, tool-call and empty rows", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.store("user", "Typed at the terminal.");
    h.store("system", "A system note.");
    h.store("assistant", "A tool call.", true);
    h.store("assistant", "   ");
    const [first, second] = h.externalTurn("First report.", "Second report.");
    await settle();
    expect(socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([["First report.", first], ["Second report.", second]]);
  });

  it("never speaks a message stored before the attachment began", async () => {
    const h = createHarness();
    h.store("assistant", "Said long before anyone listened.");
    const { socket } = h.connect();
    h.event("session:external-turn");
    await settle();
    expect(socket.ofType("segment_start")).toEqual([]);
    const [fresh] = h.externalTurn("This one is news.");
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.messageId)).toEqual([fresh]);
  });

  it("speaks a message once, however many times the event arrives", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.externalTurn("Once only.");
    h.event("session:external-turn");
    h.event("session:external-turn");
    await settle();
    expect(socket.ofType("segment_start")).toHaveLength(1);
  });

  it("a sync that only upgraded rows in place stores nothing new and speaks nothing", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    // The gateway turn spoke its reply from deltas; its stored message is behind the watermark once the turn ends.
    h.state.replyMessage = h.store("assistant", "The answer is four.");
    await h.reply("The answer is four.");
    expect(socket.ofType("segment_start")).toHaveLength(1);
    // The Stop hook's transcript sync reconciles that same row (a longer text, no new rows) and emits.
    h.event("session:external-turn");
    await settle();
    expect(socket.ofType("segment_start")).toHaveLength(1);
    expect(h.tts.calls).toEqual(["The answer is four."]);
  });

  it("speaks the late report behind a gateway reply without repeating that reply", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.state.replyMessage = h.store("assistant", "Started it in the background.");
    await h.reply("Started it in the background.");
    const [late] = h.externalTurn("The command finished.");
    await settle();
    expect(socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([
      ["Started it in the background.", null], ["The command finished.", late],
    ]);
  });

  it("a gateway reply still streaming keeps its own sentences: the late report is spoken, nothing is dropped", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.event("session:started");
    h.delta("text", "First part of the live reply. ");
    const [late] = h.externalTurn("The late report.");
    h.delta("text", "Second part of the live reply. ");
    h.state.replyMessage = h.store("assistant", "First part of the live reply. Second part of the live reply.");
    h.event("session:completed", { result: "", error: null });
    await settle();
    const spoken = socket.ofType("segment_start").map((f) => f.text);
    expect([...spoken].sort()).toEqual(["First part of the live reply.", "Second part of the live reply.", "The late report."].sort());
    expect(h.merges.find((m) => m.id === late)?.patch).toEqual({ voice: { spokenText: "The late report." } });
    // The live reply's record is its own two sentences, not the late report's.
    expect(h.merges.find((m) => m.id === h.state.replyMessage)?.patch).toEqual({ voice: { spokenText: "First part of the live reply. Second part of the live reply." } });
  });

  it("a suspended attachment keeps the late report as a missed reply and speaks it on resume", async () => {
    const h = createHarness();
    const first = h.connect();
    h.hub.socketClosed(first.attachment, first.socket, 1006);
    const [late] = h.externalTurn("The deploy is done.");
    await settle();
    expect(h.tts.calls).toEqual([]);
    expect(first.socket.audio()).toHaveLength(0);
    const back = h.connect();
    back.attachment.onText(h.json({ type: "resume", suspendedMs: 60_000 }));
    await settle();
    expect(back.socket.ofType("missed")).toEqual([{ type: "missed", messageIds: [late] }]);
    expect(back.socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([["The deploy is done.", late]]);
    // And once is enough: the event arriving again does not queue it twice.
    h.event("session:external-turn");
    await settle();
    expect(back.socket.ofType("segment_start")).toHaveLength(1);
  });

  it("barge-in on a late report records what was heard of it, as for any reply", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [late] = h.externalTurn("Alpha one two three. Beta one two three four. Gamma ends it.");
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Alpha one two three.", "Beta one two three four.", "Gamma ends it."]);
    // The person talks over the second sentence with words of their own.
    attachment.onText(JSON.stringify({ type: "barge_in", segmentId: 2, playedMs: 0 }));
    await h.say(attachment, "actually stop");
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].envelope).toContain("Alpha one two three.");
    expect(h.merges.filter((m) => m.id === late).map((m) => m.patch)).toContainEqual({ voice: { spokenText: "Alpha one two three.", interrupted: true } });
  });

  it("a session with no attachment reads nothing", () => {
    const h = createHarness();
    let reads = 0;
    const read = h.deps.messagesAfterCursor;
    h.deps.messagesAfterCursor = (...args) => { reads += 1; return read(...args); };
    h.externalTurn("Nobody is listening.");
    expect(reads).toBe(0);
  });
});
