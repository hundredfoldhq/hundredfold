import { describe, expect, it } from "vitest";
import { BARGE_IN_GRACE_MS } from "../barge-in.js";
import type { VoiceAttachment } from "../attachment.js";
import { createHarness, type Harness } from "./hub-harness.js";
import { settle, type FakeSocket } from "./fakes.js";

const REPLY = "Alpha one two three. Beta one two three four. Gamma ends it.";
const ALPHA = "Alpha one two three.";
const BETA = "Beta one two three four.";
const GAMMA = "Gamma ends it.";
const REPORT_TWO = "Delta report two. Epsilon ends it.";

const lastPatch = (h: Harness, id: string) => h.merges.filter((m) => m.id === id).map((m) => m.patch).at(-1);
const texts = (socket: FakeSocket) => socket.ofType("segment_start").map((f) => f.text);
/** Sentences of the stored reports: the holding line the hub speaks when words arrive mid-turn is not one. */
const reportSentences = (socket: FakeSocket) => socket.ofType("segment_start").filter((f) => f.messageId !== null).map((f) => f.text);
const bargeIn = (attachment: VoiceAttachment, segmentId: number | null, playedMs = 0) =>
  attachment.onText(JSON.stringify({ type: "barge_in", segmentId, playedMs }));

/** The cut turned out to be noise: the grace period passes with no utterance and speech carries on. */
async function noWordsFollow(h: Harness): Promise<void> {
  h.tts.gate = null;
  h.clock.advance(BARGE_IN_GRACE_MS + 1);
  await settle();
}

describe("a replayed sentence is counted once in what was spoken (a cut, then no words)", () => {
  it("a streamed reply cut mid-sentence and resumed records each sentence once, and is not marked interrupted", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.event("session:started");
    h.delta("text", `${REPLY} `);
    await settle();
    bargeIn(attachment, 2, 0);
    await noWordsFollow(h);
    expect(texts(socket)).toEqual([ALPHA, BETA, GAMMA, BETA, GAMMA]);
    h.event("session:completed", { result: REPLY, error: null });
    await settle();
    expect(lastPatch(h, "assistant-1")).toEqual({ voice: { spokenText: REPLY } });
  });

  it("a reply that finished before the cut is told all of it was spoken once the replay is done", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    h.event("session:started");
    h.delta("text", `${ALPHA} `);
    await settle();
    let release!: () => void;
    h.tts.gate = new Promise<void>((resolve) => { release = resolve; });
    h.delta("text", `${BETA} ${GAMMA} `);
    h.event("session:completed", { result: REPLY, error: null });
    await settle();
    bargeIn(attachment, 1, 10);
    // Nothing is idle but the cut: what was spoken so far is recorded now, and must be corrected by the replay.
    await settle();
    expect(lastPatch(h, "assistant-1")).toEqual({ voice: { spokenText: ALPHA } });
    release();
    await noWordsFollow(h);
    expect(lastPatch(h, "assistant-1")).toEqual({ voice: { spokenText: REPLY } });
  });

  it("a second barge-in on the replay, with words, records what was heard, each sentence once, as interrupted", async () => {
    const h = createHarness();
    h.state.turnRunning = true;
    const { socket, attachment } = h.connect();
    h.event("session:started");
    h.delta("text", `${REPLY} `);
    await settle();
    bargeIn(attachment, 2, 0);
    await noWordsFollow(h);
    // The replay is Beta, Gamma again: cut while Gamma's replay plays, so Alpha and the replayed Beta were heard.
    const gammaAgain = Number(socket.ofType("segment_start").at(-1)?.segmentId);
    bargeIn(attachment, gammaAgain, 0);
    await h.say(attachment, "actually stop");
    h.event("session:completed", { result: REPLY, error: null });
    await settle();
    expect(h.delivered[0].envelope).toContain(`${ALPHA} ${BETA}`);
    expect(lastPatch(h, "assistant-1")).toEqual({ voice: { spokenText: `${ALPHA} ${BETA}`, interrupted: true } });
  });

  it("a report cut mid-sentence and resumed records each sentence once, and is not marked interrupted", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [row] = h.externalTurn(REPLY);
    await settle();
    bargeIn(attachment, 2, 0);
    await noWordsFollow(h);
    expect(texts(socket)).toEqual([ALPHA, BETA, GAMMA, BETA, GAMMA]);
    expect(lastPatch(h, row)).toEqual({ voice: { spokenText: REPLY } });
  });
});

describe("a report that arrives while an earlier one is being spoken joins it", () => {
  it("is spoken after the first, each stored message recording what was spoken of it", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn(REPLY);
    await settle();
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    expect(socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([
      [ALPHA, one], [BETA, one], [GAMMA, one], ["Delta report two.", two], ["Epsilon ends it.", two],
    ]);
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: REPLY } });
    expect(lastPatch(h, two)).toEqual({ voice: { spokenText: REPORT_TWO } });
  });

  it("with no words after a barge-in, the replay goes from the cut sentence through the second report, once each", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn(REPLY);
    await settle();
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    socket.clear();
    bargeIn(attachment, 2, 0);
    await noWordsFollow(h);
    expect(socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([
      [BETA, one], [GAMMA, one], ["Delta report two.", two], ["Epsilon ends it.", two],
    ]);
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: REPLY } });
    expect(lastPatch(h, two)).toEqual({ voice: { spokenText: REPORT_TWO } });
  });

  it("with words after a barge-in, the second report's message records nothing heard instead of being lost", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn(REPLY);
    await settle();
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    socket.clear();
    bargeIn(attachment, 2, 0);
    await h.say(attachment, "actually stop");
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: ALPHA, interrupted: true } });
    expect(lastPatch(h, two)).toEqual({ voice: { spokenText: null, interrupted: true } });
    expect(reportSentences(socket)).toEqual([]);
  });

  it("arriving while the first is stopped awaiting words, it is held with the rest: spoken once on a no-words resume", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn(REPLY);
    await settle();
    bargeIn(attachment, 2, 0);
    socket.clear();
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    expect(socket.ofType("segment_start")).toEqual([]);
    await noWordsFollow(h);
    expect(socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([
      [BETA, one], [GAMMA, one], ["Delta report two.", two], ["Epsilon ends it.", two],
    ]);
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: REPLY } });
    expect(lastPatch(h, two)).toEqual({ voice: { spokenText: REPORT_TWO } });
  });

  it("arriving while the first is stopped awaiting words, then words: its message records nothing heard and is never spoken", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn(REPLY);
    await settle();
    bargeIn(attachment, 2, 0);
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    socket.clear();
    await h.say(attachment, "actually stop");
    await settle();
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: ALPHA, interrupted: true } });
    expect(lastPatch(h, two)).toEqual({ voice: { spokenText: null, interrupted: true } });
    expect(reportSentences(socket)).toEqual([]);
  });

  it("one arriving when nothing is being spoken is spoken as a report of its own, as before", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn("The first report.");
    await settle();
    // The client played it all out.
    for (const frame of socket.ofType("segment_start")) attachment.onText(JSON.stringify({ type: "played", segmentId: frame.segmentId }));
    await settle();
    socket.clear();
    const [two] = h.externalTurn("The second report.");
    await settle();
    expect(socket.ofType("segment_start").map((f) => [f.text, f.messageId])).toEqual([["The second report.", two]]);
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: "The first report." } });
  });
});

const idOf = (socket: FakeSocket, text: string): number => Number(socket.ofType("segment_start").filter((f) => f.text === text).at(-1)?.segmentId);

describe("a second cut on a replay", () => {
  it("whose report joined during the first hold: what the replay already played counts as heard (words)", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn(REPLY);
    await settle();
    bargeIn(attachment, 2, 0);
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    await noWordsFollow(h);
    // The replay plays Beta, Gamma first, then the report that joined: cut on its first sentence.
    expect(texts(socket).slice(-4)).toEqual([BETA, GAMMA, "Delta report two.", "Epsilon ends it."]);
    bargeIn(attachment, idOf(socket, "Delta report two."), 0);
    await h.say(attachment, "stop now");
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: REPLY, interrupted: null } });
    expect(lastPatch(h, two)).toEqual({ voice: { spokenText: null, interrupted: true } });
  });

  it("whose report joined during the first hold: with no words, only what was not heard is spoken again", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn(REPLY);
    await settle();
    bargeIn(attachment, 2, 0);
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    await noWordsFollow(h);
    const deltaId = idOf(socket, "Delta report two.");
    socket.clear();
    bargeIn(attachment, deltaId, 0);
    await noWordsFollow(h);
    expect(texts(socket)).toEqual(["Delta report two.", "Epsilon ends it."]);
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: REPLY } });
    expect(lastPatch(h, two)).toEqual({ voice: { spokenText: REPORT_TWO } });
  });

  it("before the first replay had been sent: the reply is still counted once", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    h.state.turnRunning = true;
    const [row] = h.externalTurn(REPLY);
    await settle();
    bargeIn(attachment, 2, 0);
    h.tts.gate = new Promise<void>(() => undefined);
    h.clock.advance(BARGE_IN_GRACE_MS + 1);
    await settle();
    bargeIn(attachment, null, 0);
    await noWordsFollow(h);
    expect(lastPatch(h, row)).toEqual({ voice: { spokenText: REPLY } });
  });

  it("before the first replay had been sent, for a streamed reply: still counted once", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    h.event("session:started");
    h.delta("text", `${REPLY} `);
    await settle();
    bargeIn(attachment, 2, 0);
    h.tts.gate = new Promise<void>(() => undefined);
    h.clock.advance(BARGE_IN_GRACE_MS + 1);
    await settle();
    bargeIn(attachment, null, 0);
    await noWordsFollow(h);
    h.event("session:completed", { result: REPLY, error: null });
    await settle();
    expect(lastPatch(h, "assistant-1")).toEqual({ voice: { spokenText: REPLY } });
  });

  it("with both reports already sent: the sentences spoken again are not also counted as cut", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn(REPLY);
    await settle();
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    bargeIn(attachment, 2, 0);
    await noWordsFollow(h);
    bargeIn(attachment, idOf(socket, "Delta report two."), 0);
    await h.say(attachment, "stop now");
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: REPLY, interrupted: null } });
    expect(lastPatch(h, two)).toEqual({ voice: { spokenText: null, interrupted: true } });
  });
});

describe("which reply the sentences belong to", () => {
  it("a report that joins a pass after a gateway reply came and went is still part of the pass", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn(REPLY);
    await settle();
    await h.reply("Hi there.");
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    socket.clear();
    bargeIn(attachment, 2, 0);
    await noWordsFollow(h);
    expect(texts(socket)).toEqual([BETA, GAMMA, "Delta report two.", "Epsilon ends it."]);
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: REPLY } });
    expect(lastPatch(h, two)).toEqual({ voice: { spokenText: REPORT_TWO } });
  });

  it("a reply cut and resumed while a newer reply has begun is still spoken as its own", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    h.event("session:started");
    h.delta("text", `${REPLY} `);
    h.event("session:completed", { result: REPLY, error: null });
    await settle();
    bargeIn(attachment, 2, 0);
    h.event("session:started");
    await noWordsFollow(h);
    expect(lastPatch(h, "assistant-1")).toEqual({ voice: { spokenText: REPLY } });
  });

  it("a report that arrives before the first has been made is recorded along with it", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.state.turnRunning = true;
    let release!: () => void;
    h.tts.gate = new Promise<void>((resolve) => { release = resolve; });
    const [one] = h.externalTurn(REPLY);
    await settle();
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    release();
    await settle();
    expect(texts(socket)).toEqual([ALPHA, BETA, GAMMA, "Delta report two.", "Epsilon ends it."]);
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: REPLY } });
    expect(lastPatch(h, two)).toEqual({ voice: { spokenText: REPORT_TWO } });
  });
});

const FRESH = "Fresh reply one. Fresh reply two.";
const turnStates = (socket: FakeSocket) => socket.ofType("turn").map((f) => f.state);

/** The client reports every segment sent so far as played in full. */
async function playAll(socket: FakeSocket, attachment: VoiceAttachment): Promise<void> {
  for (const frame of socket.ofType("segment_start")) attachment.onText(JSON.stringify({ type: "played", segmentId: frame.segmentId }));
  await settle();
}

describe("a report dropped when words follow a cut leaves nothing behind", () => {
  async function run(withReport: boolean) {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.replyMessage = h.store("assistant", REPLY);
    await h.reply(REPLY);
    bargeIn(attachment, 2, 0);
    if (withReport) h.externalTurn(REPORT_TWO);
    await settle();
    await h.say(attachment, "stop now");
    h.state.replyMessage = h.store("assistant", FRESH);
    await h.reply(FRESH);
    await playAll(socket, attachment);
    return { h, socket };
  }

  it("the turn ends idle after a fresh reply plays fully, as it does with no report", async () => {
    const control = await run(false);
    const dropped = await run(true);
    expect(turnStates(control.socket).at(-1)).toBe("idle");
    expect(turnStates(dropped.socket).at(-1)).toBe("idle");
    expect(turnStates(dropped.socket)).toEqual(turnStates(control.socket));
  });
});

describe("a report queued behind a gateway reply that is cut", () => {
  const DELTA = "Delta report two.";
  const EPSILON = "Epsilon ends it.";

  /** The reply is made but nothing of it has been sent: the voice provider has not answered yet. */
  async function gated() {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.replyMessage = h.store("assistant", REPLY);
    h.tts.gate = new Promise<void>(() => undefined);
    await h.reply(REPLY);
    const [report] = h.externalTurn(REPORT_TWO);
    await settle();
    expect(texts(socket)).toEqual([]);
    bargeIn(attachment, null, 0);
    return { h, socket, attachment, report };
  }

  /** The reply and the report are sent, none of it played: the client is still on the reply's second sentence. */
  async function sentNotPlayed() {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.replyMessage = h.store("assistant", REPLY);
    await h.reply(REPLY);
    const [report] = h.externalTurn(REPORT_TWO);
    await settle();
    expect(texts(socket)).toEqual([ALPHA, BETA, GAMMA, DELTA, EPSILON]);
    bargeIn(attachment, 2, 0);
    return { h, socket, attachment, report };
  }

  describe("before any of it was sent", () => {
    it("when words follow, the report records that nothing was heard and is not spoken", async () => {
      const { h, socket, attachment, report } = await gated();
      await h.say(attachment, "stop now");
      h.tts.gate = null;
      await settle();
      expect(lastPatch(h, report)).toEqual({ voice: { spokenText: null, interrupted: true } });
      expect(reportSentences(socket)).toEqual([]);
    });

    it("with no words, the reply starts over and the report is spoken once, and recorded as spoken", async () => {
      const { h, socket, report } = await gated();
      await noWordsFollow(h);
      expect(texts(socket)).toEqual([ALPHA, BETA, GAMMA, DELTA, EPSILON]);
      expect(lastPatch(h, report)).toEqual({ voice: { spokenText: REPORT_TWO } });
      expect(lastPatch(h, h.state.replyMessage!)).toEqual({ voice: { spokenText: REPLY } });
    });
  });

  describe("sent in full but not yet played", () => {
    it("when words follow, the report records only what was played of it: nothing", async () => {
      const { h, attachment, report } = await sentNotPlayed();
      await h.say(attachment, "stop now");
      expect(lastPatch(h, report)).toEqual({ voice: { spokenText: null, interrupted: true } });
      expect(lastPatch(h, h.state.replyMessage!)).toEqual({ voice: { spokenText: ALPHA, interrupted: true } });
    });

    it("with no words, what was not played is spoken again, the report once more, and recorded as spoken", async () => {
      const { h, socket, report } = await sentNotPlayed();
      socket.clear();
      await noWordsFollow(h);
      expect(texts(socket)).toEqual([BETA, GAMMA, DELTA, EPSILON]);
      expect(lastPatch(h, report)).toEqual({ voice: { spokenText: REPORT_TWO } });
    });

    it("a report played before the cut one keeps all of it", async () => {
      const h = createHarness();
      const { socket, attachment } = h.connect();
      const [report] = h.externalTurn(REPORT_TWO);
      await settle();
      h.state.replyMessage = h.store("assistant", REPLY);
      await h.reply(REPLY);
      expect(texts(socket)).toEqual([DELTA, EPSILON, ALPHA, BETA, GAMMA]);
      bargeIn(attachment, idOf(socket, BETA), 0);
      await h.say(attachment, "stop now");
      expect(lastPatch(h, report)).toEqual({ voice: { spokenText: REPORT_TWO } });
    });
  });

  it("an earlier report that was spoken in full keeps its record when an unrelated reply is cut and words follow", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    const [earlier] = h.externalTurn("The first report.");
    await settle();
    await playAll(socket, attachment);
    h.state.replyMessage = h.store("assistant", REPLY);
    await h.reply(REPLY);
    bargeIn(attachment, idOf(socket, BETA), 0);
    await h.say(attachment, "stop now");
    expect(lastPatch(h, earlier)).toEqual({ voice: { spokenText: "The first report." } });
    expect(lastPatch(h, h.state.replyMessage!)).toEqual({ voice: { spokenText: ALPHA, interrupted: true } });
  });
});
