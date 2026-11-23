import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DICTATION_SAMPLE_RATE,
  DictationError,
  MAX_DICTATION_BYTES,
  decodeAudioFile,
  dictationUnavailableReason,
  liveDictationUnavailableReason,
  setDictationConfig,
  splitAtSilence,
  transcribeAudioFile,
  transcribePcm,
} from "../dictation.js";
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

const SPEECH = { provider: "openai-compatible", baseUrl: "http://speech.example" };
const READY_CONFIG = { voice: { enabled: true, stt: SPEECH, tts: SPEECH } } as never;
const NOT_READY_CONFIG = { voice: { enabled: true, stt: { ...SPEECH, apiKey: "${DICTATION_FILE_KEY_NOT_SET}" }, tts: SPEECH } } as never;

afterEach(() => {
  setDictationConfig(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("liveDictationUnavailableReason", () => {
  it("says it is not available before the gateway has handed over its config", () => {
    expect(liveDictationUnavailableReason()).toMatch(/not available yet/);
  });

  it("follows the live config: off, not ready, ready", () => {
    setDictationConfig(() => ({}) as never);
    expect(liveDictationUnavailableReason()).toMatch(/turn voice mode on/);
    setDictationConfig(() => NOT_READY_CONFIG);
    expect(liveDictationUnavailableReason({ env: {} })).toMatch(/not ready/);
    setDictationConfig(() => READY_CONFIG);
    expect(liveDictationUnavailableReason()).toBeNull();
  });
});

describe("transcribeAudioFile", () => {
  const decoded = (pcm: Buffer) => async () => pcm;

  it("refuses before decoding while no config has been handed over", async () => {
    const decode = vi.fn(decoded(tone(1)));
    await expect(transcribeAudioFile("a.ogg", {}, decode)).rejects.toThrow(/not available yet/);
    expect(decode).not.toHaveBeenCalled();
  });

  it("refuses before decoding while voice mode is off", async () => {
    setDictationConfig(() => ({}) as never);
    const decode = vi.fn(decoded(tone(1)));
    const failure = await transcribeAudioFile("a.ogg", {}, decode).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DictationError);
    expect((failure as Error).message).toMatch(/turn voice mode on/);
    expect(decode).not.toHaveBeenCalled();
  });

  it("refuses before decoding while the speech provider is not ready", async () => {
    setDictationConfig(() => NOT_READY_CONFIG);
    const decode = vi.fn(decoded(tone(1)));
    const failure = await transcribeAudioFile("a.ogg", { env: {} }, decode).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DictationError);
    expect((failure as Error).message).toMatch(/not ready/);
    expect(decode).not.toHaveBeenCalled();
  });

  it("refuses audio that decodes to more than 20 minutes without calling the provider", async () => {
    setDictationConfig(() => READY_CONFIG);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const failure = await transcribeAudioFile("a.ogg", {}, decoded(Buffer.alloc(MAX_DICTATION_BYTES + 2))).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DictationError);
    expect((failure as Error).message).toMatch(/too long/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("joins the text of every segment of a long note", async () => {
    setDictationConfig(() => ({ voice: { ...(READY_CONFIG as { voice: object }).voice, language: "en" } }) as never);
    const replies = ["one", "two", "three"];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: replies.shift() }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudioFile("a.ogg", {}, decoded(tone(130)))).resolves.toBe("one two three");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("decodeAudioFile", () => {
  const scratch: string[] = [];
  afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const bin = (script?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "dictation-bin-"));
    scratch.push(dir);
    if (script) {
      writeFileSync(join(dir, "ffmpeg"), script);
      chmodSync(join(dir, "ffmpeg"), 0o755);
    }
    return dir;
  };

  it("says ffmpeg is not installed when there is none on the path", async () => {
    vi.stubEnv("PATH", bin());
    const failure = await decodeAudioFile("a.ogg").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DictationError);
    expect((failure as Error).message).toMatch(/ffmpeg is not installed/);
  });

  it("returns what ffmpeg wrote, and reports its failure in a message fit to show", async () => {
    vi.stubEnv("PATH", bin("#!/bin/sh\nprintf 'abcd'\n"));
    await expect(decodeAudioFile("a.ogg")).resolves.toEqual(Buffer.from("abcd"));
    vi.stubEnv("PATH", bin("#!/bin/sh\necho 'bad file' >&2\nexit 1\n"));
    const failure = await decodeAudioFile("a.ogg").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DictationError);
    expect((failure as Error).message).toMatch(/could not be decoded/);
  });
});
