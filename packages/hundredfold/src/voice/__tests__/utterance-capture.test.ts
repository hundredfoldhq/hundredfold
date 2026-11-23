import { describe, expect, it } from "vitest";
import { UtteranceCapture, vadLagFor, type FinishedUtterance } from "../utterance-capture.js";
import { VAD_HOLD_MS } from "../sidecar/client.js";
import { FakeClock, FakeStt, FakeVad } from "./fakes.js";

/** 20 ms of 16 kHz PCM16 mono. */
const FRAME = Buffer.alloc(640, 3);

function make(over: { pushToTalk?: boolean; prerollMs?: number; maxUtteranceMs?: number; tailMs?: number; vadLagMs?: number; unfinishedHoldMs?: number } = {}) {
  const clock = new FakeClock();
  const stt = new FakeStt();
  const vad = new FakeVad();
  const log: string[] = [];
  const finals: FinishedUtterance[] = [];
  let n = 0;
  const capture = new UtteranceCapture({
    stt, vad, language: "en", prerollMs: over.prerollMs ?? 300, unfinishedHoldMs: over.unfinishedHoldMs, maxUtteranceMs: over.maxUtteranceMs ?? 60_000, tailMs: over.tailMs, vadLagMs: over.vadLagMs,
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
  return { clock, stt, vad, log, finals, capture, feed, sent: 0 };
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
    vad.start(900); // speech began at 1000 ms; the VAD reports where to cut from, pre-roll already taken off
    feed(0);
    expect(log).toContain("vad:true");
    expect(log).toContain("start:u1");
    // From 900 ms to now (1000 ms): the stream holds 100 ms, and the pre-roll is not taken off a second time.
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

describe("UtteranceCapture, holding an unfinished utterance", () => {
  it("does not end on the VAD's end while the words so far trail off, then ends after the hold", () => {
    const { vad, stt, feed, clock, log } = make({ prerollMs: 0, unfinishedHoldMs: 800 });
    vad.start(0); feed(20);
    stt.last().partial("I would like to book a table and");
    vad.end();
    expect(stt.last().ended).toBe(false);
    expect(log).toContain("vad:false");
    clock.advance(799);
    expect(stt.last().ended).toBe(false);
    clock.advance(1);
    expect(stt.last().ended).toBe(true);
  });

  it("speech resuming inside the hold continues the same utterance", () => {
    const { vad, stt, feed, clock, log } = make({ prerollMs: 0, unfinishedHoldMs: 800 });
    vad.start(0); feed(20);
    stt.last().partial("I would like to book a table,");
    vad.end();
    clock.advance(500);
    vad.start(900);
    expect(stt.streams).toHaveLength(1);
    clock.advance(2000); // the old hold must be gone
    expect(stt.last().ended).toBe(false);
    feed(10);
    stt.last().partial("I would like to book a table, for four.");
    vad.end();
    expect(stt.last().ended).toBe(true);
    expect(log.filter((l) => l.startsWith("start:"))).toEqual(["start:u1"]);
  });

  it("ends at once when the words read as finished, when the hold is off, or when nothing was heard", () => {
    for (const [hold, partial] of [[800, "Book me a table."], [0, "Book me a table and"], [800, ""]] as const) {
      const { vad, stt, feed } = make({ prerollMs: 0, unfinishedHoldMs: hold });
      vad.start(0); feed(10);
      if (partial) stt.last().partial(partial);
      vad.end();
      expect(stt.last().ended).toBe(true);
    }
  });

  it("close during a hold leaves nothing running", () => {
    const { vad, stt, feed, clock, capture } = make({ prerollMs: 0, unfinishedHoldMs: 800 });
    vad.start(0); feed(10);
    stt.last().partial("and");
    vad.end();
    capture.close();
    clock.advance(5000);
    expect(stt.last().ended).toBe(false);
  });

  it("a hold that runs into the length limit ends the utterance normally and does not swallow the next one", () => {
    const { vad, stt, feed, clock, log } = make({ prerollMs: 0, maxUtteranceMs: 400, unfinishedHoldMs: 800 });
    vad.start(0); feed(15);
    stt.last().partial("and the");
    vad.end();
    feed(10); // 200 ms of silence inside the hold crosses the limit
    expect(log.filter((l) => l.startsWith("toolong"))).toEqual([]);
    expect(stt.last().ended).toBe(true);
    clock.advance(2000);
    feed(20);
    vad.start(1500);
    expect(log).toContain("start:u2");
    expect(stt.streams).toHaveLength(2);
  });

  it("a catch-up utterance is never held: it ends where the VAD says", () => {
    const { vad, stt, capture, clock } = make({ prerollMs: 100, tailMs: 100, unfinishedHoldMs: 800 });
    for (let i = 0; i < 400; i += 1) capture.write(marked(i + 1)); // 8 s written while the sidecar loads
    vad.start(1000); // catch-up
    stt.last().partial("and");
    vad.end(2000);
    expect(stt.last().ended).toBe(true);
    expect(given(stt.last())).toEqual(range(1000 / 20 + 1, 2100 / 20 + 1));
    clock.advance(5000);
    expect(stt.streams).toHaveLength(1);
  });

  it("a reset during a hold ends the held utterance without a second end of speech", () => {
    const { vad, stt, feed, clock, log } = make({ prerollMs: 0, unfinishedHoldMs: 800 });
    vad.start(0); feed(20);
    stt.last().partial("and the");
    vad.end();
    vad.reset();
    expect(stt.last().ended).toBe(true);
    expect(log.filter((l) => l === "vad:false")).toHaveLength(1);
    clock.advance(5000);
    vad.start(); feed(5);
    expect(log).toContain("start:u2");
  });

  it("a hold left behind by a failed stream does not swallow the next start", () => {
    const { vad, stt, feed, log } = make({ prerollMs: 0, unfinishedHoldMs: 800 });
    vad.start(0); feed(20);
    stt.last().partial("and");
    vad.end();
    stt.last().emit({ type: "error", message: "stream failed" });
    expect(log).toContain("failed:u1");
    vad.start(); feed(5);
    expect(log).toContain("start:u2");
    expect(stt.streams).toHaveLength(2);
  });

  it("push-to-talk is never held", () => {
    const { stt, feed, capture } = make({ pushToTalk: true, unfinishedHoldMs: 800 });
    capture.pttDown(); feed(5);
    stt.last().partial("and");
    capture.pttUp();
    expect(stt.last().ended).toBe(true);
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

/** A frame whose every sample is `marker`, so the bytes an STT stream received say which audio they were. */
const marked = (marker: number): Buffer => {
  const frame = Buffer.alloc(640);
  for (let i = 0; i < 320; i += 1) frame.writeInt16LE(marker, i * 2);
  return frame;
};
/** The marker of each 20 ms frame an STT stream was given, in order. */
const markers = (bytes: Buffer): number[] => {
  const out: number[] = [];
  for (let at = 0; at < bytes.length; at += 640) out.push(bytes.readInt16LE(at));
  return out;
};
const given = (stream: { writes: Buffer[] }): number[] => markers(Buffer.concat(stream.writes));
const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);

describe("UtteranceCapture, speech spoken while the models load", () => {
  /** 20 ms frames, frame n carrying marker n + 1 so no two frames look alike. */
  function loaded(over: { prerollMs?: number; tailMs?: number; maxUtteranceMs?: number; vadLagMs?: number } = {}) {
    const made = make({ prerollMs: 100, tailMs: 100, ...over });
    const frames = (count: number) => { for (let i = 0; i < count; i += 1) made.capture.write(marked(++made.sent)); };
    return { ...made, frames };
  }
  const ms = (n: number) => n / 20;

  it("keeps the whole load window in its ring", () => {
    const { capture, stt, vad } = make({ prerollMs: 100 });
    const frameCount = (VAD_HOLD_MS + 1500 + 100) / 20 - 10;
    for (let i = 0; i < frameCount; i += 1) capture.write(marked(i + 1));
    vad.start(0); // the earliest audio there is: still in the ring, so nothing was lost
    vad.end(frameCount * 20);
    expect(markers(Buffer.concat(stt.last().writes))[0]).toBe(1);
  });

  it("cuts two utterances spoken during the load apart, each from its own start offset to its end plus the tail", () => {
    const { stt, vad, frames, log } = loaded();
    frames(400); // 8 s of audio written while the sidecar loads; no VAD event yet
    // The sidecar is up: the VAD works through the hold and reports both utterances in a burst.
    vad.start(1000); // speech at 1.1 s (pre-roll 100 ms already off)
    expect(stt.streams).toHaveLength(1);
    expect(stt.streams[0].bytes()).toBe(0); // a late start is fed nothing yet
    vad.end(2000);
    vad.start(5000);
    expect(stt.streams).toHaveLength(2);
    vad.end(6000);
    // [start, end + tail): frames 50..104 (markers 51..105) and 250..304.
    expect(given(stt.streams[0])).toEqual(range(ms(1000) + 1, ms(2100) + 1));
    expect(given(stt.streams[1])).toEqual(range(ms(5000) + 1, ms(6100) + 1));
    expect(stt.streams.map((s) => s.ended)).toEqual([true, true]);
    expect(log.filter((l) => l.startsWith("start"))).toEqual(["start:u1", "start:u2"]);
  });

  it("feeds no live frame to a catch-up utterance, and cuts it from the ring when its end comes later", () => {
    const { stt, vad, frames } = loaded();
    frames(400);
    vad.start(1000); // late start; speech goes on
    frames(50); // live audio while it waits
    expect(stt.streams[0].bytes()).toBe(0);
    vad.end(9000);
    expect(given(stt.streams[0])).toEqual(range(ms(1000) + 1, 451));
    expect(stt.streams[0].ended).toBe(true);
  });

  it("never runs a catch-up utterance past what was written", () => {
    const { stt, vad, frames } = loaded({ tailMs: 5000 });
    frames(100);
    vad.start(200);
    vad.end(1900); // the tail would reach 6.9 s; only 2 s exist
    expect(given(stt.streams[0])).toEqual(range(ms(200) + 1, 101));
  });

  it("cuts a catch-up utterance for length once its span reaches the limit", () => {
    const { stt, vad, frames, log } = loaded({ maxUtteranceMs: 3000 });
    frames(400);
    vad.start(1000); // 7 s old already: over the limit as soon as the next frame arrives
    expect(log.filter((l) => l.startsWith("toolong"))).toEqual([]);
    frames(1);
    expect(log.filter((l) => l.startsWith("toolong"))).toEqual(["toolong:u1"]);
    expect(given(stt.streams[0])).toEqual(range(ms(1000) + 1, ms(4000) + 1)); // the first 3 s of it
    expect(stt.streams[0].ended).toBe(true);
    vad.end(8000); // the rest of that speech is ignored until it ends
    expect(stt.streams).toHaveLength(1);
    vad.start(8500);
    expect(stt.streams).toHaveLength(2);
  });

  it("cuts a catch-up utterance for length when its start falls out of the ring", () => {
    const { stt, vad, frames, log } = loaded({ maxUtteranceMs: 600_000 });
    frames(400);
    vad.start(1000);
    frames((VAD_HOLD_MS + 1600) / 20); // speech goes on until the start has left the ring
    expect(log.filter((l) => l.startsWith("toolong"))).toEqual(["toolong:u1"]);
    expect(given(stt.streams[0])[0]).toBeGreaterThan(ms(1000) + 1); // what the ring still had of it
    expect(stt.streams[0].ended).toBe(true);
  });

  it("a catch-up start and end delivered together still hold the length limit", () => {
    const { stt, vad, frames, log } = loaded({ maxUtteranceMs: 5000 });
    frames(750); // 15 s
    vad.start(0);
    vad.end(10_000); // a 10 s span, back to back with its start
    expect(log.filter((l) => l.startsWith("toolong"))).toEqual(["toolong:u1"]);
    expect(given(stt.streams[0])).toEqual(range(1, ms(5000) + 1)); // the first 5 s of it, no more
    expect(stt.streams[0].ended).toBe(true);
    vad.start(11_000); // the end was delivered, so the next speech is a new utterance
    vad.end(12_000);
    expect(stt.streams).toHaveLength(2);
    expect(log.filter((l) => l.startsWith("toolong"))).toEqual(["toolong:u1"]);
  });

  it("a start older than the whole buffer cannot be cut from it: it is live, seeded from the recent window", () => {
    const { stt, vad, frames, log } = loaded();
    frames(3000); // a minute in: the ring has been trimmed
    vad.start(1000); // far behind: the buffer no longer holds it
    frames(100);
    vad.end(2800);
    expect(log.filter((l) => l.startsWith("toolong"))).toEqual([]);
    // preroll 100 + lag 1500 = 1600 ms back from where the start arrived, then the live frames.
    expect(given(stt.streams[0])).toEqual(range(3000 - ms(1600) + 1, 3101));
    expect(stt.streams[0].ended).toBe(true);
    vad.start(500);
    expect(stt.streams).toHaveLength(2); // the next utterance is not dropped either
  });

  it("a start that arrives while a catch-up utterance is open ends that one where the new speech begins", () => {
    const { stt, vad, frames, log } = loaded();
    frames(400);
    vad.start(1000); // catch-up; the sidecar that would have ended it died and was replaced
    vad.start(5000); // the new sidecar's first speech
    expect(given(stt.streams[0])).toEqual(range(ms(1000) + 1, ms(5000) + 1));
    expect(stt.streams[0].ended).toBe(true);
    expect(stt.streams).toHaveLength(2);
    vad.end(6000);
    expect(given(stt.streams[1])).toEqual(range(ms(5000) + 1, ms(6100) + 1));
    expect(log.filter((l) => l.startsWith("toolong"))).toEqual([]);
  });

  it("a start that arrives while a live utterance is open ends it and opens the next", () => {
    const { stt, vad, frames, log } = loaded();
    frames(100);
    vad.start(1840); // live
    frames(10);
    vad.start(2100); // the sidecar was replaced before it ended the first
    expect(stt.streams[0].ended).toBe(true);
    expect(given(stt.streams[0])).toEqual(range(ms(1840) + 1, 111));
    expect(stt.streams).toHaveLength(2);
    expect(given(stt.streams[1])).toEqual(range(ms(2100) + 1, 111));
    expect(log.slice(-3)).toEqual(["vad:false", "vad:true", "start:u2"]);
  });

  it("a catch-up utterance closed by the next start is held to the length limit too", () => {
    const { stt, vad, frames } = loaded({ maxUtteranceMs: 5000 });
    frames(750);
    vad.start(0);
    vad.start(11_000); // closes the first by the same length rule: its span to here is over the limit
    expect(stt.streams[0].ended).toBe(true);
    expect(given(stt.streams[0])).toEqual(range(1, ms(5000) + 1));
    expect(stt.streams).toHaveLength(2);
  });

  it("a live start behaves as before: seeded from its start, then the live frames, nothing twice", () => {
    const { stt, vad, frames } = loaded();
    frames(100); // 2 s
    vad.start(1840); // 160 ms behind: not a catch-up
    expect(given(stt.last())).toEqual(range(ms(1840) + 1, 101));
    frames(10);
    expect(given(stt.last())).toEqual(range(ms(1840) + 1, 111));
    vad.end(2100);
    expect(stt.last().ended).toBe(true);
    expect(given(stt.last())).toEqual(range(ms(1840) + 1, 111)); // live ends where the end event arrives
  });

  it("a reset ends the live utterance that was open, at the frames it already holds", () => {
    const { stt, vad, frames, log } = loaded();
    frames(100);
    vad.start(1840); // live
    frames(10);
    vad.reset(); // the sidecar behind the VAD was replaced before it ended the utterance
    expect(stt.streams[0].ended).toBe(true);
    expect(given(stt.streams[0])).toEqual(range(ms(1840) + 1, 111));
    expect(log.slice(-1)).toEqual(["vad:false"]);
    expect(stt.streams).toHaveLength(1);
  });

  it("a reset cuts a catch-up utterance from its start to the reset position", () => {
    const { stt, vad, frames } = loaded();
    frames(400);
    vad.start(1000); // catch-up
    vad.reset(5000); // the detector that was working through the hold was replaced at 5 s
    expect(stt.streams[0].ended).toBe(true);
    expect(given(stt.streams[0])).toEqual(range(ms(1000) + 1, ms(5000) + 1));
    // What the new detector reports counts from the reset on: the next speech is a separate utterance.
    vad.start(5000);
    vad.end(6000);
    expect(given(stt.streams[1])).toEqual(range(ms(5000) + 1, ms(6100) + 1));
  });

  it("a reset holds a catch-up utterance to the length limit", () => {
    const { stt, vad, frames, log } = loaded({ maxUtteranceMs: 5000 });
    frames(750);
    vad.start(0);
    vad.reset(11_000);
    expect(log.filter((l) => l.startsWith("toolong"))).toEqual(["toolong:u1"]);
    expect(given(stt.streams[0])).toEqual(range(1, ms(5000) + 1));
  });

  it("a reset clears the ignoring that follows a cut for length, so the next speech is heard", () => {
    const { stt, vad, frames, log } = loaded({ maxUtteranceMs: 1000 });
    frames(10);
    vad.start(0);
    frames(60); // over the limit: cut, and the rest of that speech is ignored
    expect(log.filter((l) => l.startsWith("toolong"))).toHaveLength(1);
    vad.reset();
    expect(log.slice(-1)).toEqual(["vad:false"]);
    vad.start();
    expect(stt.streams).toHaveLength(2);
  });

  it("a reset with nothing open changes nothing", () => {
    const { stt, vad, frames, log } = loaded();
    frames(50);
    vad.reset();
    expect(log).toEqual([]);
    expect(stt.streams).toHaveLength(0);
  });

  it("a reset does nothing in push-to-talk", () => {
    const { capture, stt, vad, feed, log } = make({ pushToTalk: true });
    capture.pttDown();
    feed(5);
    vad.reset();
    expect(stt.last().ended).toBe(false);
    expect(log).toEqual(["start:u1"]);
  });

  it("the live lag follows the detector's minimum speech: a start that late is still live", () => {
    const lagged = loaded({ vadLagMs: 2500 });
    lagged.frames(200); // 4 s
    lagged.vad.start(4000 - 2000); // 100 + 2500 allowed; this one is 2.1 s behind
    expect(lagged.stt.last().bytes()).toBe(ms(2000) * 640);
    const standard = loaded();
    standard.frames(200);
    standard.vad.start(4000 - 2000); // the same start with the default lag is a catch-up
    expect(standard.stt.last().bytes()).toBe(0);
  });

  it("derives the lag from the minimum speech with a floor of 1.5 s", () => {
    expect(vadLagFor(250)).toBe(1500);
    expect(vadLagFor(1000)).toBe(1500);
    expect(vadLagFor(2000)).toBe(2500);
  });

  it("a start exactly at the live lag bound is live; one frame past it is a catch-up", () => {
    const { stt, vad, frames } = loaded();
    frames(200); // 4 s
    vad.start(4000 - 1600); // preroll 100 + lag 1500 = 1600 ms behind
    expect(stt.last().bytes()).toBe(ms(1600) * 640);
    vad.end();
    vad.start(4000 - 1620);
    expect(stt.streams[1].bytes()).toBe(0);
  });
});
