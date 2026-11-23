import { describe, expect, it } from "vitest";
import { VOICE_AUDIO_HEADER_BYTES } from "../../shared/gateway-events.js";
import { SpeechPipeline, type Segment } from "../speech-pipeline.js";
import type { TtsSynthesisOptions } from "../provider.js";
import { FakeTts, settle } from "./fakes.js";

/**
 * A voice that takes 10 ms of audio per character at speed 1, as a provider that applies `speed` does (Kokoro,
 * tts-1): audio gets shorter as speed goes up. With `applies` false it ignores the request, as gpt-4o-mini-tts does.
 */
class PacedTts extends FakeTts {
  constructor(private readonly applies = true) {
    super();
    if (!applies) (this as { honoursSpeed?: boolean }).honoursSpeed = false;
  }
  override async *synthesize(text: string, options: TtsSynthesisOptions): AsyncIterable<Buffer> {
    this.calls.push(text);
    this.speeds.push(options.speed);
    const ms = (text.length * 10) / (this.applies ? (options.speed ?? 1) : 1);
    const samples = Math.round((24_000 * ms) / 1000);
    const pcm = Buffer.alloc(samples * 2);
    // A tone, so a time stretch has something to work on.
    for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 160 * i) / 24_000)), i * 2);
    yield pcm;
  }
}

function make(tts = new FakeTts(), speed: number | (() => number) = 1) {
  const json: Array<Record<string, unknown>> = [];
  const audio: Buffer[] = [];
  const firstAudio: Segment[] = [];
  const errors: unknown[] = [];
  const pipeline = new SpeechPipeline({
    tts, voice: "v", speed, language: "en",
    sink: { json: (f) => json.push(f as unknown as Record<string, unknown>), audio: (b) => audio.push(b) },
    onAudio: (s) => firstAudio.push(s),
    onSynthesisError: (e) => errors.push(e),
  });
  return { tts, pipeline, json, audio, firstAudio, errors };
}

const segmentOf = (frame: Buffer): number => frame.readUInt32LE(4);

describe("SpeechPipeline", () => {
  it("speaks a sentence while the rest of the reply is still arriving, in order, framed per the contract", async () => {
    const { pipeline, json, audio, tts } = make();
    pipeline.feed("First sentence here. Second one is");
    await settle();
    expect(json.map((f) => f.type)).toEqual(["segment_start", "segment_end"]);
    expect(json[0]).toMatchObject({ type: "segment_start", segmentId: 1, text: "First sentence here." });
    expect(audio).toHaveLength(2);
    expect(audio[0].readUInt8(0)).toBe(1);
    expect(audio[0].readUInt16LE(2)).toBe(0);
    expect(audio[1].readUInt16LE(2)).toBe(1);
    expect(segmentOf(audio[0])).toBe(1);
    expect(audio[0].length).toBe(VOICE_AUDIO_HEADER_BYTES + 960);
    pipeline.feed(" still going. ");
    pipeline.endReply();
    await settle();
    expect(tts.calls).toEqual(["First sentence here.", "Second one is still going."]);
    expect(json.filter((f) => f.type === "segment_start").map((f) => f.segmentId)).toEqual([1, 2]);
  });

  it("starts making the next sentence while the current one is still being sent", async () => {
    const { pipeline, tts } = make();
    let release!: () => void;
    tts.gate = new Promise<void>((resolve) => { release = resolve; });
    pipeline.feed("One. Two. Three. ");
    await settle();
    // Sentence 1 is gating; sentence 2 was started ahead (prefetch of one), sentence 3 was not.
    expect(tts.calls).toEqual(["One.", "Two."]);
    release();
    await settle();
    expect(tts.calls).toEqual(["One.", "Two.", "Three."]);
  });

  it("flags the first audio of each segment, once", async () => {
    const { pipeline, firstAudio } = make();
    pipeline.feed("Alpha one. Beta two. ");
    await settle();
    expect(firstAudio.map((s) => s.text)).toEqual(["Alpha one.", "Beta two."]);
  });

  it("a holding line goes out as a holding frame and a segment flagged as holding", async () => {
    const { pipeline, json, firstAudio } = make();
    pipeline.speakLine("Still working on that.");
    await settle();
    expect(json[0]).toEqual({ type: "holding", text: "Still working on that." });
    expect(json.some((f) => f.type === "segment_start")).toBe(true);
    expect(firstAudio[0].holding).toBe(true);
  });

  it("cut stops at once: no frame for an already-queued segment is sent after it returns, and its synthesis is aborted", async () => {
    const { pipeline, audio, json, tts } = make();
    let release!: () => void;
    tts.gate = new Promise<void>((resolve) => { release = resolve; });
    pipeline.feed("Queued one. Queued two. Queued three. ");
    await settle();
    const before = audio.length;
    const cut = pipeline.cut(null, 0);
    release();
    await settle();
    expect(audio.length).toBe(before);
    expect(json.filter((f) => f.type === "segment_start")).toHaveLength(0);
    expect(tts.signals.every((s) => s.aborted)).toBe(true);
    expect(cut.heard).toBe("");
    expect(cut.unheard).toEqual(["Queued one.", "Queued two.", "Queued three."]);
  });

  it("works out what was heard: whole sentences before the one playing, and a share of that one by its played milliseconds", async () => {
    const { pipeline, json } = make();
    pipeline.feed("The first sentence ends here. The second sentence has eight words in it. Third sentence last. ");
    await settle();
    const ids = json.filter((f) => f.type === "segment_start").map((f) => f.segmentId as number);
    expect(ids).toEqual([1, 2, 3]);
    // Segment 2 sent 2 chunks of 960 bytes at 24 kHz: 40 ms. The client played 20 ms of it.
    const cut = pipeline.cut(2, 20);
    expect(cut.heard.startsWith("The first sentence ends here.")).toBe(true);
    expect(cut.heard).toContain("The second sentence");
    expect(cut.heard).not.toContain("eight words in it");
    expect(cut.unheard[0]).toBe("The second sentence has eight words in it.");
    expect(cut.unheard).toContain("Third sentence last.");
    expect(cut.unheard).not.toContain("The first sentence ends here.");
  });

  it("a cut by the gateway's own hearing knows only what was reported played", async () => {
    const { pipeline } = make();
    pipeline.feed("Played one is done. Not yet reported two. ");
    await settle();
    pipeline.markPlayed(1);
    const cut = pipeline.cut(null, 0);
    expect(cut.heard).toBe("Played one is done.");
    expect(cut.unheard).toEqual(["Not yet reported two."]);
  });

  it("what was heard, and what is resumed, belong to the reply that was cut, not the one before it or a holding line", async () => {
    const { pipeline, json } = make();
    pipeline.markReply(1);
    pipeline.feed("Earlier reply sentence one. ");
    await settle();
    pipeline.markPlayed(1);
    pipeline.speakLine("Still working on that.");
    pipeline.markReply(2);
    pipeline.feed("Second reply opens here. Second reply goes on. ");
    await settle();
    const ids = json.filter((f) => f.type === "segment_start").map((f) => f.segmentId as number);
    expect(ids).toEqual([1, 2, 3, 4]);
    const cut = pipeline.cut(3, 0);
    expect(cut.heard).toBe("");
    expect(cut.unheard).toEqual(["Second reply opens here.", "Second reply goes on."]);
    expect(pipeline.spokenFor(1)).toBe("Earlier reply sentence one.");
  });

  it("resumes from the first sentence not heard, ahead of text that arrived while it was held", async () => {
    const { pipeline, json, tts } = make();
    pipeline.feed("Heard one is fine. Cut two was mid. ");
    await settle();
    pipeline.markPlayed(1);
    const cut = pipeline.cut(2, 0);
    pipeline.hold();
    pipeline.feed("Arrived while held. ");
    await settle();
    const callsHeld = tts.calls.length;
    pipeline.resumeWith(cut.unheard);
    pipeline.release();
    await settle();
    expect(callsHeld).toBe(2);
    expect(tts.calls.slice(2)).toEqual(["Cut two was mid.", "Arrived while held."]);
    expect(json.filter((f) => f.type === "segment_start").slice(2).map((f) => f.text)).toEqual(["Cut two was mid.", "Arrived while held."]);
  });

  it("a resume with other sentences than the cut left does not stand in for what was cut", async () => {
    const { pipeline } = make();
    pipeline.markReply(1);
    pipeline.feed("Alpha one two three. Beta one two three four. Gamma ends it. ");
    await settle();
    pipeline.cut(2, 0);
    pipeline.resumeWith(["Something else."]);
    await settle();
    expect(pipeline.spokenFor(1)).toBe("Alpha one two three. Beta one two three four. Gamma ends it. Something else.");
  });

  describe("a reply cut and resumed with more text that arrived during the hold", () => {
    const ALPHA = "Alpha one two three.";
    const BETA = "Beta one two three four.";
    const GAMMA = "Gamma goes on here.";
    const DELTA = "Delta arrives later.";
    const EPSILON = "Epsilon ends it all.";

    // Ids: Alpha 1, Beta 2, Gamma 3, Delta 4, Epsilon 5, then the replays Beta 6 and Gamma 7 are
    // queued ahead of Delta and Epsilon, so the client plays 1, 6, 7, 4, 5.
    async function cutOnBetaThenMoreText() {
      const made = make();
      made.pipeline.markReply(1);
      made.pipeline.feed(`${ALPHA} ${BETA} ${GAMMA} `);
      await settle();
      const cut = made.pipeline.cut(2, 0);
      made.pipeline.hold();
      made.pipeline.feed(`${DELTA} ${EPSILON} `);
      await settle();
      made.pipeline.resumeWith(cut.unheard);
      return { ...made, cut };
    }

    it("what was spoken is in the order it was played, not the order the sentences were made", async () => {
      const { pipeline } = await cutOnBetaThenMoreText();
      pipeline.release();
      await settle();
      expect(pipeline.spokenFor(1)).toBe([ALPHA, BETA, GAMMA, DELTA, EPSILON].join(" "));
    });

    it("a cut later in the replay hears the sentences played before it in play order", async () => {
      const { pipeline } = await cutOnBetaThenMoreText();
      pipeline.release();
      await settle();
      const cut = pipeline.cut(5, 0);
      expect(cut.heard).toBe([ALPHA, BETA, GAMMA, DELTA].join(" "));
      expect(cut.unheard).toEqual([EPSILON]);
    });

    it("a cut early in the replay resumes what was sent in play order", async () => {
      const { pipeline } = await cutOnBetaThenMoreText();
      pipeline.release();
      await settle();
      const cut = pipeline.cut(1, 0);
      expect(cut.unheard).toEqual([BETA, GAMMA, DELTA, EPSILON]);
    });

    it("a second cut before anything was sent resumes the replays ahead of the text that arrived in the hold", async () => {
      const { pipeline } = await cutOnBetaThenMoreText();
      const cut = pipeline.cut(null, 0);
      expect(cut.heard).toBe(ALPHA);
      expect(cut.unheard).toEqual([BETA, GAMMA, DELTA, EPSILON]);
    });
  });

  it("a sentence that made no audio was not heard, even though it was made after the one playing", async () => {
    const { pipeline, tts } = make();
    tts.failOn = "boom";
    pipeline.markReply(1);
    pipeline.feed("Alpha one two three. This will boom. ");
    await settle();
    const cut = pipeline.cut(1, 0);
    expect(cut.heard).toBe("");
    expect(cut.unheard).toEqual(["Alpha one two three."]);
  });

  it("what was held when words answered the cut is not stood in for by a later resume of the same sentences", async () => {
    const { pipeline } = make();
    pipeline.markReply(1);
    pipeline.feed("Alpha one two three. Beta one two three four. ");
    await settle();
    const cut = pipeline.cut(2, 0);
    expect(cut.unheard).toEqual(["Beta one two three four."]);
    pipeline.discardQueued();
    pipeline.markReply(2);
    pipeline.resumeWith(["Beta one two three four."]);
    await settle();
    expect(pipeline.spokenFor(1)).toBe("Alpha one two three. Beta one two three four.");
  });

  it("discarding what was held drops it, so the new turn's reply is the only thing spoken", async () => {
    const { pipeline, tts } = make();
    pipeline.cut(null, 0);
    pipeline.hold();
    pipeline.feed("Old thread text. Still old. ");
    pipeline.discardQueued();
    pipeline.release();
    pipeline.feed("Fresh reply. ");
    await settle();
    expect(tts.calls).toEqual(["Fresh reply."]);
  });

  it("a failed sentence is reported to the log side and skipped; the next one is still spoken", async () => {
    const { pipeline, tts, errors, json } = make();
    tts.failOn = "boom";
    pipeline.feed("This will boom. This one is fine. ");
    await settle();
    expect(errors).toHaveLength(1);
    expect(json.filter((f) => f.type === "segment_start").map((f) => f.text)).toEqual(["This one is fine."]);
  });

  it("splits long audio into frames of at most 16 KB and resamples a provider at another rate", async () => {
    const tts = new FakeTts();
    tts.sampleRate = 12_000;
    tts.chunkBytes = 40_000;
    tts.chunksPerSentence = 1;
    const { pipeline, audio } = make(tts);
    pipeline.feed("A long one here. ");
    await settle();
    expect(audio.length).toBeGreaterThanOrEqual(5);
    expect(audio.every((f) => f.length - VOICE_AUDIO_HEADER_BYTES <= 16 * 1024)).toBe(true);
    const bytes = audio.reduce((n, f) => n + f.length - VOICE_AUDIO_HEADER_BYTES, 0);
    expect(Math.abs(bytes - 80_000)).toBeLessThanOrEqual(8);
  });

  it("records which reply each spoken sentence belonged to", async () => {
    const { pipeline } = make();
    pipeline.markReply(7);
    pipeline.feed("Belongs to seven. ");
    pipeline.markReply(8);
    pipeline.feed("Belongs to eight. ");
    await settle();
    expect(pipeline.spokenFor(7)).toBe("Belongs to seven.");
    expect(pipeline.spokenFor(8)).toBe("Belongs to eight.");
  });

  describe("at a speed other than 1", () => {
    const SENTENCES = "The first sentence ends here. The second sentence has eight words in it. Third sentence last. ";
    const sentMs = (audio: Buffer[], id: number): number =>
      audio.filter((f) => segmentOf(f) === id).reduce((sum, f) => sum + (f.length - VOICE_AUDIO_HEADER_BYTES) / 2 / 24, 0);

    it("asks the provider for the speed, the sentence after a change at the new one", async () => {
      let speed = 1.5;
      const { pipeline, tts } = make(new PacedTts(), () => speed);
      pipeline.feed("Speak at the first pace. ");
      await settle();
      speed = 1;
      pipeline.feed("Then speak at the next pace. ");
      await settle();
      expect((tts as PacedTts).speeds).toEqual([1.5, 1]);
    });

    it("sentences are as short as the speed makes them, and the played share is of that audio", async () => {
      const fast = make(new PacedTts(), 2);
      const normal = make(new PacedTts(), 1);
      for (const run of [fast, normal]) { run.pipeline.feed(SENTENCES); await settle(); }
      const second = "The second sentence has eight words in it.";
      expect(sentMs(fast.audio, 2)).toBeCloseTo(second.length * 5, 0);
      expect(sentMs(normal.audio, 2)).toBeCloseTo(second.length * 10, 0);
      // Half of the sped-up sentence has played: its own length, not the length it would have at speed 1.
      const half = Math.round(sentMs(fast.audio, 2) / 2);
      const cut = fast.pipeline.cut(2, half);
      expect(cut.heard).toBe("The first sentence ends here. The second sentence has");
      expect(cut.unheard).toEqual([second, "Third sentence last."]);
      // The same words are heard at the same share of the way through at speed 1.
      const same = normal.pipeline.cut(2, Math.round(sentMs(normal.audio, 2) / 2));
      expect(same.heard).toBe(cut.heard);
      expect(same.unheard).toEqual(cut.unheard);
    });

    it("a sentence played in full is whole heard and nothing of it is left to resume, at any speed", async () => {
      const { pipeline, audio } = make(new PacedTts(), 1.5);
      pipeline.feed(SENTENCES);
      await settle();
      const cut = pipeline.cut(2, Math.round(sentMs(audio, 2)));
      expect(cut.heard).toBe("The first sentence ends here. The second sentence has eight words in it.");
      expect(cut.unheard).toEqual(["Third sentence last."]);
    });

    it("a provider that ignores the request is asked for speed 1 and its audio is stretched here to the same length", async () => {
      const ignoring = make(new PacedTts(false), 1.5);
      ignoring.pipeline.feed(SENTENCES);
      await settle();
      const natural = "The second sentence has eight words in it.".length * 10;
      expect((ignoring.tts as PacedTts).speeds).toEqual([1, 1, 1]);
      const ms = sentMs(ignoring.audio, 2);
      expect(ms).toBeGreaterThan((natural / 1.5) * 0.93);
      expect(ms).toBeLessThan((natural / 1.5) * 1.1);
      // Heard and unheard still follow the stretched audio.
      const cut = ignoring.pipeline.cut(2, Math.round(ms / 2));
      expect(cut.heard).toBe("The first sentence ends here. The second sentence has");
      expect(cut.unheard).toEqual(["The second sentence has eight words in it.", "Third sentence last."]);
    });

    it("a provider that ignores the request is left alone at speed 1", async () => {
      const { pipeline, audio } = make(new PacedTts(false), 1);
      pipeline.feed("Natural pace here. ");
      await settle();
      expect(sentMs(audio, 1)).toBeCloseTo("Natural pace here.".length * 10, 0);
    });
  });
});
