import { describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./hub-harness.js";
import { settle } from "./fakes.js";
import { UtteranceCapture } from "../utterance-capture.js";
import { FakeClock, FakeStt, FakeVad } from "./fakes.js";
import { phantomReason } from "../phantom-filter.js";
import { DEFAULT_PHANTOM_PHRASES } from "../../shared/voice-config.js";

/** One spoken-or-not utterance: the VAD hears `speechMs` of voice, then the provider's final comes back. */
async function utterance(h: Harness, attachment: ReturnType<Harness["connect"]>["attachment"], text: string, speechMs: number, quality?: { confidence?: number; noSpeechProb?: number }): Promise<void> {
  h.vad().start();
  h.audio(attachment, 6);
  h.vad().end(undefined, speechMs);
  h.stt.last().final(text, quality);
  await settle();
}

const finals = (frames: Array<Record<string, unknown>>) => frames.filter((f) => f.final === true).map((f) => f.text);

describe("phantom utterances are not sent as the person's words", () => {
  it("a short clip that came back as a known phantom phrase is dropped: the client gets an empty final, nothing is delivered", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await utterance(h, attachment, "Thank you.", 280);
    expect(finals(socket.ofType("transcript"))).toEqual([""]);
    expect(h.delivered).toHaveLength(0);
    expect(h.infos.some((line) => line.includes("known phantom phrase"))).toBe(true);
    expect(h.infos.join("\n")).not.toContain("Thank you");
  });

  it("an empty transcript is silence, not a dropped utterance: nothing is logged even when the provider doubts it", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await utterance(h, attachment, "", 900, { noSpeechProb: 0.99 });
    expect(finals(socket.ofType("transcript"))).toEqual([""]);
    expect(h.infos.some((line) => line.includes("dropped an utterance"))).toBe(false);
  });

  it("the same words from a clip long enough to be said on purpose go through", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await utterance(h, attachment, "Thank you.", 620);
    expect(finals(socket.ofType("transcript"))).toEqual(["Thank you."]);
    expect(h.delivered).toHaveLength(1);
  });

  it("short real words go through, as do words in a clip whose length the VAD did not say", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await utterance(h, attachment, "Yes", 300);
    await utterance(h, attachment, "Stop", 300);
    h.vad().start();
    h.audio(attachment, 6);
    h.vad().end();
    h.stt.last().final("you");
    await settle();
    expect(h.delivered.map((d) => d.text)).toEqual(["Yes", "Stop", "you"]);
  });

  it("a transcript the provider calls probably not speech, with no confidence to say otherwise, is dropped however long the clip", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await utterance(h, attachment, "And that's dope", 900, { noSpeechProb: 0.93 });
    expect(finals(socket.ofType("transcript"))).toEqual([""]);
    expect(h.delivered).toHaveLength(0);
  });

  it("a high no-speech chance does not drop a transcript the provider was confident about", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await utterance(h, attachment, "Yes", 300, { noSpeechProb: 0.9, confidence: 0.9 });
    expect(h.delivered.map((d) => d.text)).toEqual(["Yes"]);
  });

  it("a high no-speech chance together with a low confidence is dropped", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await utterance(h, attachment, "Amen", 900, { noSpeechProb: 0.95, confidence: 0.1 });
    expect(h.delivered).toHaveLength(0);
  });

  it("a low-confidence transcript is dropped; a confident short one is not", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await utterance(h, attachment, "Amen", 900, { confidence: 0.12 });
    await utterance(h, attachment, "Yes", 300, { confidence: 0.6, noSpeechProb: 0.2 });
    expect(h.delivered.map((d) => d.text)).toEqual(["Yes"]);
  });

  it("the thresholds are the operator's: a lower confidence floor keeps what the default drops, and an emptied list keeps phantom phrases", async () => {
    const h = createHarness({ config: { filter: { minConfidence: 0.05, noSpeechThreshold: 1, phantomMaxMs: 500, phantomPhrases: [] } } });
    const { attachment } = h.connect();
    await utterance(h, attachment, "Amen", 300, { confidence: 0.12, noSpeechProb: 0.99 });
    expect(h.delivered.map((d) => d.text)).toEqual(["Amen"]);
  });

  it("a dropped utterance while the assistant was speaking lets it carry on from the sentence not heard, like an empty one", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.event("session:started");
    h.delta("text", "Alpha one two three. ");
    await settle();
    let release!: () => void;
    h.tts.gate = new Promise<void>((resolve) => { release = resolve; });
    h.delta("text", "Beta one two three four. Gamma ends it. ");
    await settle();
    attachment.onText(JSON.stringify({ type: "barge_in", segmentId: 2, playedMs: 0 }));
    h.tts.gate = null;
    release();
    await utterance(h, attachment, "You", 200);
    expect(h.delivered).toHaveLength(0);
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Alpha one two three.", "Beta one two three four.", "Gamma ends it."]);
  });
});

describe("phantomReason", () => {
  const filter = { minConfidence: 0.3, noSpeechThreshold: 0.8, phantomMaxMs: 500, phantomPhrases: [...DEFAULT_PHANTOM_PHRASES] };

  it("compares whole words after case and punctuation, never a part", () => {
    expect(phantomReason({ text: "THANK  you!", speechMs: 100 }, filter)).not.toBeNull();
    expect(phantomReason({ text: "thank you very much", speechMs: 100 }, filter)).toBeNull();
    expect(phantomReason({ text: "you there", speechMs: 100 }, filter)).toBeNull();
    expect(phantomReason({ text: "", speechMs: 100 }, filter)).toBeNull();
  });

  it("the duration bound is exclusive and 0 turns the phrase list off", () => {
    expect(phantomReason({ text: "amen", speechMs: 499 }, filter)).not.toBeNull();
    expect(phantomReason({ text: "amen", speechMs: 500 }, filter)).toBeNull();
    expect(phantomReason({ text: "amen", speechMs: 10 }, { ...filter, phantomMaxMs: 0 })).toBeNull();
  });

  it("a provider that reports nothing is never judged on it", () => {
    expect(phantomReason({ text: "hello there", speechMs: 100, quality: {} }, filter)).toBeNull();
  });
});

describe("the capture sums how long speech was voiced", () => {
  it("speech that resumes inside a hold adds to the utterance's voiced time", async () => {
    const clock = new FakeClock();
    const stt = new FakeStt();
    const vad = new FakeVad();
    const seen: Array<{ speechMs?: number }> = [];
    const capture = new UtteranceCapture({
      stt, vad, language: "en", prerollMs: 0, unfinishedHoldMs: 800, maxUtteranceMs: 60_000, pushToTalk: false, clock, newId: () => "u1",
      events: { onVad: () => undefined, onStart: () => undefined, onPartial: () => undefined, onFinal: (u) => seen.push(u), onFailed: () => undefined, onTooLong: () => undefined },
    });
    const pcm = Buffer.alloc(640, 3);
    vad.start(0);
    capture.write(pcm);
    stt.last().partial("I would like to book a table and");
    vad.end(300, 300);
    clock.advance(100);
    vad.start(400);
    capture.write(pcm);
    vad.end(900, 450);
    stt.last().final("I would like to book a table and chairs");
    expect(seen[0].speechMs).toBe(750);
  });

  it("speech that resumed inside a hold and was cut by a reset has no voiced time to report", async () => {
    const clock = new FakeClock();
    const stt = new FakeStt();
    const vad = new FakeVad();
    const seen: Array<{ speechMs?: number }> = [];
    const capture = new UtteranceCapture({
      stt, vad, language: "en", prerollMs: 0, unfinishedHoldMs: 800, maxUtteranceMs: 60_000, pushToTalk: false, clock, newId: () => "u1",
      events: { onVad: () => undefined, onStart: () => undefined, onPartial: () => undefined, onFinal: (u) => seen.push(u), onFailed: () => undefined, onTooLong: () => undefined },
    });
    const pcm = Buffer.alloc(640, 3);
    vad.start(0);
    capture.write(pcm);
    stt.last().partial("I would like to book a table and");
    vad.end(300, 300);
    clock.advance(100);
    vad.start(400);
    capture.write(pcm);
    vad.reset(600);
    stt.last().final("I would like to book a table and chairs");
    expect(seen).toHaveLength(1);
    expect(seen[0].speechMs).toBeUndefined();
  });
});
