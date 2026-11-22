import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SpeechSidecarClient } from "../sidecar/client.js";
import { UtteranceCapture } from "../utterance-capture.js";
import { FakeClock, FakeStt } from "./fakes.js";

/**
 * The capture over the real sidecar client and a fake sidecar. Speech spoken while the local models load: the fake says
 * hello late, the client holds the audio, and the VAD's events for it arrive in a burst once the sidecar is up. And a
 * sidecar that is replaced mid-session, whose own offsets restart at 0.
 */
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-sidecar.mjs");
const VAD = { threshold: 0.5, minSpeechMs: 250, silenceMs: 700, prerollMs: 300 };
/** The sidecar takes this long to load: more than the 5 s the report called slow. */
const LOAD_MS = 8000;
const FRAME_MS = 20;
const SPEECH = { text: "hi", voice: "af_heart", speed: 1, lang: "en" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const spawned: ChildProcessWithoutNullStreams[] = [];
const clients: SpeechSidecarClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const child of spawned.splice(0)) child.kill("SIGKILL");
});

/** Frame n: a quiet frame carries n + 1, a loud one 1000 + n, so the audio an STT stream was given names its own frames. */
function frameFor(n: number, loud: boolean): Buffer {
  const frame = Buffer.alloc(640);
  for (let i = 0; i < 320; i += 1) frame.writeInt16LE(loud ? 1000 + n : n + 1, i * 2);
  return frame;
}
const framesOf = (writes: Buffer[]): number[] => {
  const all = Buffer.concat(writes);
  const out: number[] = [];
  for (let at = 0; at < all.length; at += 640) {
    const value = all.readInt16LE(at);
    out.push(value >= 1000 ? value - 1000 : value - 1);
  }
  return out;
};
const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);

function rig(env: Record<string, string>, timing: Record<string, number> = {}) {
  const sidecar = new SpeechSidecarClient({
    spawnProcess: () => {
      const child = spawn(process.execPath, [FAKE], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      spawned.push(child);
      return child;
    },
    hello: () => ({ device: "auto", models: {} }),
    timing: { pingEveryMs: 60_000, respawnMinMs: 60_000, idleReapMs: 60_000, killGraceMs: 200, helloTimeoutMs: 20_000, ...timing },
  });
  clients.push(sidecar);
  const stt = new FakeStt();
  const log: string[] = [];
  const capture = new UtteranceCapture({
    stt, vad: sidecar.vad("v1", VAD), language: "en", prerollMs: VAD.prerollMs, tailMs: VAD.silenceMs, maxUtteranceMs: 60_000,
    pushToTalk: false, clock: new FakeClock(), newId: (() => { let n = 0; return () => `u${++n}`; })(),
    events: {
      onVad: (speaking) => log.push(`vad:${speaking}`), onStart: (id) => log.push(`start:${id}`), onPartial() {}, onFinal() {},
      onFailed: (id) => log.push(`failed:${id}`), onTooLong: (id) => log.push(`toolong:${id}`),
    },
  });
  let n = 0;
  /** `count` frames; frame numbers run on across calls, so the audio an STT stream was given names its own frames. */
  const frames = (count: number, loud = false) => { for (let i = 0; i < count; i += 1) capture.write(frameFor(n++, loud)); };
  return { sidecar, stt, log, capture, frames };
}

async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

/** Kill the fake sidecar (it dies on a synthesis), let the respawn hold pass, and bring a new one up. */
async function replaceSidecar(sidecar: SpeechSidecarClient): Promise<void> {
  try { for await (const chunk of sidecar.synthesize("t1", SPEECH, new AbortController().signal)) void chunk; } catch { /* it died */ }
  await sleep(250);
  await sidecar.ensureReady();
}

describe("speech spoken while the sidecar loads", () => {
  it("transcribes both utterances whole, cut by the VAD's offsets, though its events arrive 8 s late in a burst", async () => {
    const { stt, frames } = rig({ FAKE: "marker-vad", FAKE_HELLO_DELAY_MS: String(LOAD_MS) });
    // 12 s of audio is spoken while the sidecar loads: speech at 2-4 s and again at 6-8 s, quiet around them.
    frames(100);
    frames(100, true);
    frames(100);
    frames(100, true);
    frames(200);
    expect(stt.streams).toHaveLength(0); // the sidecar is not up: no VAD event yet

    await waitFor(() => stt.streams.length >= 2 && stt.streams.every((s) => s.ended), LOAD_MS + 10_000);

    const preroll = VAD.prerollMs / FRAME_MS;
    const tail = VAD.silenceMs / FRAME_MS;
    // [start, end + tail): speech frames 100..199 with 15 frames of pre-roll before and 35 of trailing silence after.
    expect(framesOf(stt.streams[0].writes)).toEqual(range(100 - preroll, 200 + tail));
    expect(framesOf(stt.streams[1].writes)).toEqual(range(300 - preroll, 400 + tail));
    expect(stt.streams[0].aborted || stt.streams[1].aborted).toBe(false);
  }, 40_000);
});

describe("speech after the sidecar is replaced mid-session", () => {
  const replaced = { FAKE: "die-on-tts", FAKE_MARKER: "1" };
  const timing = { respawnMinMs: 150 };

  it("cuts the speech from where it was said, not from where the new sidecar counts it", async () => {
    const { sidecar, stt, frames, log } = rig(replaced, timing);
    await sidecar.ensureReady();
    frames(500); // 10 s of quiet, all taken by the first sidecar
    await replaceSidecar(sidecar);
    frames(100); // quiet, then speech at global frames 600..649, then the quiet that ends it
    frames(50, true);
    frames(40);
    await waitFor(() => stt.streams.length >= 1 && stt.streams[0].ended, 10_000);
    const preroll = VAD.prerollMs / FRAME_MS;
    expect(framesOf(stt.streams[0].writes)).toEqual(range(600 - preroll, 650 + VAD.silenceMs / FRAME_MS));
    expect(log.filter((line) => line.startsWith("toolong"))).toEqual([]);
    expect(stt.streams).toHaveLength(1);
  }, 30_000);

  it("ends the utterance the old sidecar never ended when the new one reports the next speech", async () => {
    const { sidecar, stt, frames, log } = rig(replaced, timing);
    await sidecar.ensureReady();
    frames(500);
    frames(50, true); // speech under way at global frames 500..549 when the sidecar dies
    await waitFor(() => stt.streams.length === 1, 10_000);
    await replaceSidecar(sidecar);
    frames(100);
    frames(1, true); // the new sidecar's first speech: global frame 650
    await waitFor(() => stt.streams.length === 2, 10_000);
    expect(stt.streams[0].ended).toBe(true);
    expect(Math.max(...framesOf(stt.streams[0].writes))).toBeLessThanOrEqual(650);
    expect(framesOf(stt.streams[0].writes)[0]).toBe(500 - VAD.prerollMs / FRAME_MS);
    expect(framesOf(stt.streams[1].writes)[0]).toBe(650 - VAD.prerollMs / FRAME_MS);
    expect(log.filter((line) => line.startsWith("toolong"))).toEqual([]);
  }, 30_000);
});
