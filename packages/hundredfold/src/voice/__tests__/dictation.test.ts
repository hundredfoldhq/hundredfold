import { describe, expect, it } from "vitest";
import { DICTATION_SAMPLE_RATE, dictationUnavailableReason, splitAtSilence, transcribePcm } from "../dictation.js";
import { FakeStt, settle } from "./fakes.js";

const SECOND = DICTATION_SAMPLE_RATE * 2;

/** `seconds` of PCM at a constant sample value. */
const tone = (seconds: number, value = 8000): Buffer => {
  const pcm = Buffer.alloc(seconds * SECOND);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(value, offset);
  return pcm;
};

describe("splitAtSilence", () => {
  it("keeps a recording of a minute or less whole", () => {
    expect(splitAtSilence(tone(60))).toHaveLength(1);
    expect(splitAtSilence(Buffer.alloc(0))).toHaveLength(0);
  });

  it("cuts a long recording into segments that add up to all of it", () => {
    const pcm = tone(150);
    const segments = splitAtSilence(pcm);
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(Buffer.concat(segments).equals(pcm)).toBe(true);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(60 * SECOND);
      expect(segment.length % 2).toBe(0);
    }
  });

  it("cuts at the quietest moment in the last ten seconds of a segment", () => {
    const pcm = tone(100);
    const quietAt = 55 * SECOND;
    pcm.fill(0, quietAt, quietAt + 640);
    const [first] = splitAtSilence(pcm);
    expect(first.length).toBeGreaterThanOrEqual(quietAt);
    expect(first.length).toBeLessThanOrEqual(quietAt + 640 + 640);
  });
});

describe("transcribePcm", () => {
  it("joins the text of each segment, in order, one segment at a time", async () => {
    const stt = new FakeStt();
    const pending = transcribePcm(stt, tone(130), { language: "en" });
    for (const text of ["first part", "second part", "third part"]) {
      await settle();
      expect(stt.last().ended).toBe(true);
      stt.last().final(text);
    }
    await expect(pending).resolves.toBe("first part second part third part");
    expect(stt.streams.map((stream) => stream.options.sampleRate)).toEqual([16000, 16000, 16000]);
    expect(stt.streams.every((stream) => stream.options.language === "en")).toBe(true);
    expect(stt.streams.reduce((sum, stream) => sum + stream.bytes(), 0)).toBe(130 * SECOND);
  });

  it("skips a segment with no speech in it", async () => {
    const stt = new FakeStt();
    const pending = transcribePcm(stt, tone(70), { language: "en" });
    await settle();
    stt.last().final("  ");
    await settle();
    stt.last().final("hello");
    await expect(pending).resolves.toBe("hello");
  });

  it("rejects with the provider's message when a segment fails", async () => {
    const stt = new FakeStt();
    const pending = transcribePcm(stt, tone(5), { language: "en" });
    await settle();
    stt.last().emit({ type: "error", message: "the speech engine fell over" });
    await expect(pending).rejects.toThrow("the speech engine fell over");
  });

  it("aborts the recognition when the caller gives up", async () => {
    const stt = new FakeStt();
    const abort = new AbortController();
    const pending = transcribePcm(stt, tone(5), { language: "en", signal: abort.signal });
    await settle();
    abort.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(stt.last().aborted).toBe(true);
  });
});

describe("dictationUnavailableReason", () => {
  it("says to turn voice mode on when it is off, and is clear when its provider is ready", () => {
    expect(dictationUnavailableReason({})).toMatch(/turn voice mode on/);
    expect(dictationUnavailableReason({ voice: { enabled: false } })).toMatch(/turn voice mode on/);
    const ready = { voice: { enabled: true, stt: { provider: "openai-compatible", baseUrl: "http://speech.example" }, tts: { provider: "openai-compatible", baseUrl: "http://speech.example" } } };
    expect(dictationUnavailableReason(ready)).toBeNull();
  });

  it("carries the provider's reason when it is not ready", () => {
    const keyMissing = { voice: { enabled: true, stt: { provider: "openai-compatible", baseUrl: "http://speech.example", apiKey: "${DICTATION_TEST_KEY_NOT_SET}" }, tts: { provider: "openai-compatible", baseUrl: "http://speech.example" } } };
    expect(dictationUnavailableReason(keyMissing, { env: {} })).toMatch(/API key not set/);
  });
});
