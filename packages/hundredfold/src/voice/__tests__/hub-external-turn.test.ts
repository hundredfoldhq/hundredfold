import { describe, expect, it } from "vitest";
import { createHarness } from "./hub-harness.js";
import { settle } from "./fakes.js";
import { BARGE_IN_GRACE_MS } from "../barge-in.js";

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

  it("speaks each new report in order, and never a gateway turn's own rows: user, system, tool, error or settled", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.store("user", "Typed at the terminal.");
    h.store("system", "A system note.");
    h.store("assistant", "A tool call.", true);
    h.store("assistant", "   ");
    h.store("assistant", "⛔ The turn failed.");
    h.store("assistant", "A settled gateway reply.");
    const [first, second] = h.externalTurn("First report.", "Second report.");
    await settle();
    expect(socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([["First report.", first], ["Second report.", second]]);
  });

  it("never speaks a report stored before the attachment began", async () => {
    const h = createHarness();
    h.store("assistant", "Said long before anyone listened.", false, true);
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

  it("the old thread's reply, dropped on purpose, is not spoken when a later report arrives, nor when a sync stores nothing new", async () => {
    const h = createHarness({ engine: { reportsWork: true } });
    h.state.turnRunning = true;
    h.engine.work = { tool: "Bash", startedAt: h.clock.now() - 9_000, description: "tests", backgroundable: true };
    const { socket, attachment } = h.connect();
    h.event("session:started");
    await h.say(attachment, "forget that, do this instead");
    socket.clear();
    h.delta("text", "Old thread first sentence. ");
    h.state.replyMessage = h.store("assistant", "Old thread first sentence. Old thread rest.");
    h.event("session:completed", { result: "Old thread first sentence. Old thread rest.", error: null });
    h.event("session:started");
    h.event("session:external-turn");
    await settle();
    expect(socket.ofType("segment_start")).toEqual([]);
    const [late] = h.externalTurn("The backgrounded command finished.");
    await settle();
    expect(socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([["The backgrounded command finished.", late]]);
  });

  it("an error notice a failed turn stored is not a report and is not spoken", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.event("session:started");
    h.store("assistant", "⛔ The engine stopped unexpectedly.");
    h.event("session:completed", { result: "", error: "boom" });
    h.event("session:external-turn");
    await settle();
    expect(socket.ofType("segment_start")).toEqual([]);
  });

  it("a report is not the answer the pending exchange is waiting for: its audio does not stop the clock", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await h.say(attachment, "what is two plus two");
    h.event("session:started");
    h.clock.advance(4_000);
    h.externalTurn("The deploy finished.");
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["The deploy finished."]);
    expect(socket.ofType("metrics")).toEqual([]);
    h.state.replyMessage = h.store("assistant", "Four.");
    h.delta("text", "Four. ");
    h.event("session:completed", { result: "", error: null });
    await settle();
    expect(socket.ofType("metrics")).toEqual([{ type: "metrics", utteranceId: "id2", sttMs: 0, ttfaMs: 4_000 }]);
    expect(h.merges.find((m) => m.id === h.state.replyMessage)?.patch).toEqual({ voice: { spokenText: "Four.", ttfaMs: 4_000 } });
  });

  describe("a report of several stored messages (text, tool, text), cut by a barge-in", () => {
    const first = "Alpha one two three. Beta one two three four.";
    const second = "Gamma starts here. Delta ends it.";
    const lastPatch = (h: ReturnType<typeof createHarness>, id: string) => h.merges.filter((m) => m.id === id).map((m) => m.patch).at(-1);

    it("the message the cut fell in keeps what was heard, later ones record nothing heard, and none is spoken again", async () => {
      const h = createHarness();
      const { socket, attachment } = h.connect();
      h.state.turnRunning = true;
      const [one, two] = h.externalTurn(first, second);
      await settle();
      expect(socket.ofType("segment_start").map((f) => f.messageId)).toEqual([one, one, two, two]);
      attachment.onText(JSON.stringify({ type: "barge_in", segmentId: 2, playedMs: 0 }));
      await h.say(attachment, "actually stop");
      expect(lastPatch(h, one)).toEqual({ voice: { spokenText: "Alpha one two three.", interrupted: true } });
      expect(lastPatch(h, two)).toEqual({ voice: { spokenText: null, interrupted: true } });
      expect(h.delivered[0].envelope).toContain("Alpha one two three.");
    });

    it("messages before the cut one were heard whole and are not marked interrupted", async () => {
      const h = createHarness();
      const { attachment } = h.connect();
      h.state.turnRunning = true;
      const [one, two] = h.externalTurn(first, second);
      await settle();
      attachment.onText(JSON.stringify({ type: "barge_in", segmentId: 4, playedMs: 0 }));
      await h.say(attachment, "enough");
      expect(lastPatch(h, one)).toEqual({ voice: { spokenText: first, interrupted: null } });
      expect(lastPatch(h, two)).toEqual({ voice: { spokenText: "Gamma starts here.", interrupted: true } });
    });

    it("with no words after the noise, speech goes on from the first sentence not heard, across the messages, each as its own", async () => {
      const h = createHarness();
      const { socket, attachment } = h.connect();
      h.state.turnRunning = true;
      const [one, two] = h.externalTurn(first, second);
      await settle();
      socket.clear();
      attachment.onText(JSON.stringify({ type: "barge_in", segmentId: 2, playedMs: 0 }));
      h.clock.advance(BARGE_IN_GRACE_MS + 1);
      await settle();
      expect(socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([
        ["Beta one two three four.", one], ["Gamma starts here.", two], ["Delta ends it.", two],
      ]);
    });
  });

  describe("a report arriving while a streamed reply is cut and held", () => {
    const reply = "Alpha one two three. Beta one two three four. Gamma ends it.";
    const report = "The deploy finished. Everything is green.";
    const lastPatch = (h: ReturnType<typeof createHarness>, id: string) => h.merges.filter((m) => m.id === id).map((m) => m.patch).at(-1);

    async function cutReply() {
      const h = createHarness();
      const { socket, attachment } = h.connect();
      h.state.replyMessage = h.store("assistant", reply);
      await h.reply(reply);
      expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Alpha one two three.", "Beta one two three four.", "Gamma ends it."]);
      attachment.onText(JSON.stringify({ type: "barge_in", segmentId: 2, playedMs: 0 }));
      const [late] = h.externalTurn(report);
      await settle();
      return { h, socket, attachment, late };
    }

    it("when words follow, the report records nothing heard and none of it is spoken", async () => {
      const { h, socket, attachment, late } = await cutReply();
      socket.clear();
      await h.say(attachment, "stop now");
      expect(lastPatch(h, late)).toEqual({ voice: { spokenText: null, interrupted: true } });
      expect(socket.ofType("segment_start")).toEqual([]);
      expect(h.tts.calls).not.toContain("The deploy finished.");
      // The cut reply still records what was heard of it.
      expect(lastPatch(h, h.state.replyMessage!)).toEqual({ voice: { spokenText: "Alpha one two three.", interrupted: true } });
    });

    it("with no words, the cut reply goes on from the first sentence not heard and the report is spoken once", async () => {
      const { h, socket } = await cutReply();
      socket.clear();
      h.clock.advance(BARGE_IN_GRACE_MS + 1);
      await settle();
      expect(socket.ofType("segment_start").map((f) => f.text)).toEqual([
        "Beta one two three four.", "Gamma ends it.", "The deploy finished.", "Everything is green.",
      ]);
    });
  });

  it("a session with no attachment reads nothing", () => {
    const h = createHarness();
    let reads = 0;
    const read = h.deps.externalRepliesSince;
    h.deps.externalRepliesSince = (...args) => { reads += 1; return read(...args); };
    h.externalTurn("Nobody is listening.");
    expect(reads).toBe(0);
  });
});
