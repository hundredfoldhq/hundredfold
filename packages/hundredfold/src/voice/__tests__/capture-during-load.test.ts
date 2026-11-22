import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SpeechSidecarClient } from "../sidecar/client.js";
import { UtteranceCapture } from "../utterance-capture.js";
import { FakeClock, FakeStt } from "./fakes.js";

/**
 * Speech spoken while the local models load, through the real sidecar client's hold queue: the fake sidecar says hello
 * late, the client holds the audio, and the VAD's events for it arrive in a burst once the sidecar is up.
 */
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-sidecar.mjs");
const VAD = { threshold: 0.5, minSpeechMs: 250, silenceMs: 700, prerollMs: 300 };
/** The sidecar takes this long to load: more than the 5 s the report called slow. */
const LOAD_MS = 8000;
const FRAME_MS = 20;

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

describe("speech spoken while the sidecar loads", () => {
  it("transcribes both utterances whole, cut by the VAD's offsets, though its events arrive 8 s late in a burst", async () => {
    const sidecar = new SpeechSidecarClient({
      spawnProcess: () => {
        const child = spawn(process.execPath, [FAKE], {
          env: { ...process.env, FAKE: "marker-vad", FAKE_HELLO_DELAY_MS: String(LOAD_MS) }, stdio: ["pipe", "pipe", "pipe"],
        });
        spawned.push(child);
        return child;
      },
      hello: () => ({ device: "auto", models: {} }),
      timing: { pingEveryMs: 60_000, respawnMinMs: 60_000, idleReapMs: 60_000, killGraceMs: 200, helloTimeoutMs: 20_000 },
    });
    clients.push(sidecar);
    const stt = new FakeStt();
    const capture = new UtteranceCapture({
      stt, vad: sidecar.vad("v1", VAD), language: "en", prerollMs: VAD.prerollMs, tailMs: VAD.silenceMs, maxUtteranceMs: 60_000,
      pushToTalk: false, clock: new FakeClock(), newId: (() => { let n = 0; return () => `u${++n}`; })(),
      events: { onVad() {}, onStart() {}, onPartial() {}, onFinal() {}, onFailed() {}, onTooLong() {} },
    });

    // 12 s of audio is spoken while the sidecar loads: speech at 2-4 s and again at 6-8 s, quiet around them.
    const loud = (n: number) => (n >= 100 && n < 200) || (n >= 300 && n < 400);
    for (let n = 0; n < 600; n += 1) capture.write(frameFor(n, loud(n)));
    expect(stt.streams).toHaveLength(0); // the sidecar is not up: no VAD event yet

    const deadline = Date.now() + LOAD_MS + 10_000;
    while (stt.streams.length < 2 || !stt.streams.every((s) => s.ended)) {
      if (Date.now() > deadline) throw new Error("the VAD events never arrived");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const preroll = VAD.prerollMs / FRAME_MS;
    const tail = VAD.silenceMs / FRAME_MS;
    // [start, end + tail): speech frames 100..199 with 15 frames of pre-roll before and 35 of trailing silence after.
    expect(framesOf(stt.streams[0].writes)).toEqual(range(100 - preroll, 200 + tail));
    expect(framesOf(stt.streams[1].writes)).toEqual(range(300 - preroll, 400 + tail));
    expect(stt.streams[0].aborted || stt.streams[1].aborted).toBe(false);
  }, 40_000);
});
