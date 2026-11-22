import { describe, expect, it } from "vitest";
import { UtteranceCapture, type FinishedUtterance } from "../utterance-capture.js";
import { FakeClock, FakeStt, FakeVad } from "./fakes.js";

/** 20 ms of 16 kHz PCM16 mono. */
const FRAME = Buffer.alloc(640, 3);

function make(over: { pushToTalk?: boolean; prerollMs?: number; maxUtteranceMs?: number } = {}) {
  const clock = new FakeClock();
  const stt = new FakeStt();
  const vad = new FakeVad();
  const log: string[] = [];
  const finals: FinishedUtterance[] = [];
  let n = 0;
  const capture = new UtteranceCapture({
    stt, vad, language: "en", prerollMs: over.prerollMs ?? 300, maxUtteranceMs: over.maxUtteranceMs ?? 60_000,
    pushToTalk: over.pushToTalk ?? false, clock, newId: () => `u${++n}`,
    events: {
      onVad: (s) => log.push(`vad:${s}`),
      onStart: (id) => log.push(`start:${id}`),
      onPartial: (id, text) => log.push(`partial:${id}:${text}`),
      onFinal: (u) => { finals.push(u); log.push(`final:${u.id}`); },
      onFailed: (id) => log.push(`failed:${id}`),
      onTooLong: (id) => log.push(`toolong:${id}`),
    },
  });
  const feed = (frames: number) => { for (let i = 0; i < frames; i += 1) capture.write(FRAME); };
  return { clock, stt, vad, log, finals, capture, feed };
}

describe("UtteranceCapture, hands-free", () => {
  it("gives every frame to the VAD, and none to STT until speech starts", () => {
    const { vad, stt, feed } = make({ prerollMs: 0 });
    feed(5);
    expect(vad.written).toBe(5 * 640);
    expect(stt.streams).toHaveLength(0);
  });

  it("opens an STT stream on speech start, seeded with the pre-roll, then streams live audio without repeating a frame", () => {
    const { vad, stt, feed, log } = make({ prerollMs: 100 });
    feed(50); // 1000 ms of quiet
    vad.start(1000); // the VAD says speech began at 1000 ms, as of this frame
    feed(0);
    expect(log).toContain("vad:true");
    expect(log).toContain("start:u1");
    // Pre-roll 100 ms (5 frames) + the audio from 1000 ms on (none yet): the stream holds 100 ms.
    expect(stt.last().bytes()).toBe(5 * 640);
    feed(10);
    expect(stt.last().bytes()).toBe(15 * 640);
  });

  it("an utterance the VAD opens while a frame is written is not given that frame twice", () => {
    const { vad, stt, capture } = make({ prerollMs: 0 });
    for (let i = 0; i < 10; i += 1) capture.write(FRAME);
    // Fire the start from inside the next write, as an in-process VAD does.
    const original = vad.write.bind(vad);
    vad.write = (pcm: Buffer) => { original(pcm); if (vad.written === 11 * 640) vad.start(200); };
    capture.write(FRAME);
    // From 200 ms (frame 10) to the end of the frame just written: exactly one frame.
    expect(stt.last().bytes()).toBe(640);
  });

  it("the pause ends the utterance: it asks the stream for its final, and reports partials, then the final with the stt time", () => {
    const { vad, stt, feed, finals, log, clock } = make({ prerollMs: 0 });
    feed(5);
    vad.start(100);
    feed(20);
    stt.last().partial("hello wor");
    vad.end();
    expect(stt.last().ended).toBe(true);
    clock.advance(180);
    stt.last().final("hello world");
    expect(log).toEqual(["vad:true", "start:u1", "partial:u1:hello wor", "vad:false", "final:u1"]);
    expect(finals[0]).toMatchObject({ id: "u1", text: "hello world", sttMs: 180 });
    expect(finals[0].audioMs).toBeGreaterThan(300);
  });

  it("speech starting again while a final is awaited opens a second utterance, each answered on its own", () => {
    const { vad, stt, feed, finals } = make({ prerollMs: 0 });
    vad.start(0); feed(5); vad.end();
    vad.start(100); feed(5); vad.end();
    expect(stt.streams).toHaveLength(2);
    stt.streams[1].final("second");
    stt.streams[0].final("first");
    expect(finals.map((f) => f.text)).toEqual(["second", "first"]);
  });

  it("cuts an utterance that runs past the limit, uses what was captured, and ignores the rest of that speech", () => {
    const { vad, stt, feed, log } = make({ prerollMs: 0, maxUtteranceMs: 200 });
    vad.start(0);
    feed(30); // 600 ms
    expect(log.filter((l) => l.startsWith("toolong"))).toEqual(["toolong:u1"]);
    expect(stt.last().ended).toBe(true);
    expect(stt.last().bytes()).toBeLessThan(15 * 640);
    vad.start(700); // still the same breath: a new utterance must not open
    expect(stt.streams).toHaveLength(1);
    vad.end();
    vad.start(900); // a fresh breath is a fresh utterance
    expect(stt.streams).toHaveLength(2);
  });

  it("a provider error fails that utterance and nothing else", () => {
    const { vad, stt, log } = make({ prerollMs: 0 });
    vad.start(0);
    stt.last().emit({ type: "error", message: "secret detail" });
    expect(log).toContain("failed:u1");
    expect(stt.last().aborted).toBe(true);
  });

  it("a final that never comes is given up on", () => {
    const { vad, stt, clock, log, feed } = make({ prerollMs: 0 });
    vad.start(0); feed(3); vad.end();
    clock.advance(16_000);
    expect(log).toContain("failed:u1");
    stt.last().final("too late");
    expect(log.filter((l) => l.startsWith("final"))).toEqual([]);
  });

  it("close drops everything in flight: no event after it", () => {
    const { vad, stt, capture, log, feed } = make({ prerollMs: 0 });
    vad.start(0); feed(3);
    capture.close();
    expect(vad.closed).toBe(true);
    expect(stt.last().aborted).toBe(true);
    stt.last().final("late");
    feed(2);
    expect(log.filter((l) => l.startsWith("final"))).toEqual([]);
  });
});

describe("UtteranceCapture, push-to-talk", () => {
  it("ignores audio outside the key, never feeds the VAD and does not endpoint on it", () => {
    const { vad, stt, feed, capture, finals } = make({ pushToTalk: true });
    feed(10);
    expect(stt.streams).toHaveLength(0);
    capture.pttDown();
    feed(10);
    vad.end(); // a VAD end must change nothing in this mode
    expect(stt.last().ended).toBe(false);
    capture.pttUp();
    expect(stt.last().ended).toBe(true);
    stt.last().final("pushed to talk");
    expect(vad.written).toBe(0);
    expect(stt.last().bytes()).toBe(10 * 640);
    expect(finals[0].text).toBe("pushed to talk");
  });
});
