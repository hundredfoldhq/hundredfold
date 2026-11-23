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
  it("a gateway reply that starts jumps over an unheard report, and a report after it is a pass of its own", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.state.turnRunning = true;
    const [one] = h.externalTurn(REPLY);
    await settle();
    socket.clear();
    await h.reply("Hi there.");
    const [two] = h.externalTurn(REPORT_TWO);
    await settle();
    expect(socket.ofType("stop_playback").map((f) => f.reason)).toEqual(["new_reply", "new_reply"]);
    expect(texts(socket)).toEqual(["Hi there.", "Delta report two.", "Epsilon ends it."]);
    expect(lastPatch(h, one)).toEqual({ voice: { spokenText: null, interrupted: true } });
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
