import { describe, expect, it } from "vitest";
import { toWav } from "../providers/audio.js";
import { wavFacts } from "../../tts/wav-facts.js";
import { createTracer, errorField, traceLine } from "../trace.js";
import { createHarness, SESSION } from "./hub-harness.js";
import { settle } from "./fakes.js";

describe("trace lines", () => {
  it("write one key=value line, leave out undefined fields and quote what needs it", () => {
    expect(traceLine("segment_end", { segment: 3, bytes: 4096, error: undefined, ok: true, none: null, ratio: 1.23456, who: "a b", empty: "" }))
      .toBe('[voice] event=segment_end segment=3 bytes=4096 ok=true none=null ratio=1.23 who="a b" empty=""');
  });

  it("flatten line breaks and cap a long value", () => {
    const line = traceLine("x", { text: `one\ntwo\r\n${"y".repeat(400)}` });
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.length).toBeLessThan(220);
  });

  it("put the base fields first and tolerate a sink with no debug", () => {
    const lines: string[] = [];
    const tracer = createTracer({ info: (m) => lines.push(m), warn: (m) => lines.push(m) }, { att: "a1", session: "s1" });
    tracer.debug("dropped_silently", { n: 1 });
    tracer.info("kept", { n: 2 });
    expect(lines).toEqual(["[voice] event=kept att=a1 session=s1 n=2"]);
  });

  it("never throw on a value that is not a string or number, and never write its contents", () => {
    const line = traceLine("x", { a: { secret: 1 } as never, b: ["x"] as never, c: 10n as never, d: (() => 1) as never });
    expect(line).toBe("[voice] event=x a=<object> b=<array> c=<bigint> d=<function>");
  });

  it("swallow a sink that throws, and skip a debug line when the sink says debug is off", () => {
    const throwing = createTracer({ info: () => { throw new Error("disk full"); }, warn: () => { throw new Error("disk full"); } });
    expect(() => throwing.info("a")).not.toThrow();
    expect(() => throwing.warn("a")).not.toThrow();
    let built = 0;
    const lines: string[] = [];
    const off = createTracer({ info: (m) => lines.push(m), warn: (m) => lines.push(m), debug: (m) => lines.push(m), debugEnabled: () => false });
    off.debug("frame", () => { built += 1; return { n: 1 }; });
    expect(built).toBe(0);
    expect(lines).toEqual([]);
    const on = createTracer({ info: (m) => lines.push(m), warn: (m) => lines.push(m), debug: (m) => lines.push(m), debugEnabled: () => true });
    on.debug("frame", () => { built += 1; return { n: 1 }; });
    expect(built).toBe(1);
    expect(lines).toEqual(["[voice] event=frame n=1"]);
  });

  it("report an error without an address", () => {
    expect(errorField(new Error("could not reach https://api.example.com/v1/audio?key=abc now"))).toBe("could not reach <url> now");
  });

  it("formats any thrown value without throwing itself", () => {
    const bare = Object.create(null) as object;
    const odd = new Error("x");
    Object.defineProperty(odd, "message", { value: 42 });
    const hostile = { toString: () => { throw new Error("no"); } };
    expect(errorField(bare)).toBe("unknown");
    expect(errorField(odd)).toBe("unknown");
    expect(errorField(hostile)).toBe("unknown");
    expect(errorField(undefined)).toBe("undefined");
  });
});

describe("wavFacts", () => {
  const pcm = Buffer.alloc(48_000); // one second at 24 kHz

  it("reads the rate and length of a whole clip", () => {
    expect(wavFacts(toWav(pcm, 24_000))).toMatchObject({ wav_ok: true, wav_rate: 24_000, wav_channels: 1, wav_bits: 16, wav_data_bytes: 48_000, wav_ms: 1000 });
  });

  it("says a clip is cut short when its data chunk declares more than the buffer holds", () => {
    const whole = toWav(pcm, 24_000);
    const facts = wavFacts(whole.subarray(0, whole.length - 12_000));
    expect(facts.wav_ok).toBe(false);
    expect(facts.wav_data_bytes).toBe(36_000);
    expect(facts.wav_ms).toBe(750);
  });

  it("does not throw on bytes that are not a WAV", () => {
    expect(wavFacts(Buffer.from("not audio"))).toEqual({ wav_bytes: 9, wav_ok: false });
  });
});

/** A round trip and a barge-in through the real hub, with every line the pipeline wrote. */
describe("what a spoken conversation logs", () => {
  const all = (h: ReturnType<typeof createHarness>): string[] => [...h.infos, ...h.warnings, ...h.debugs].filter((line) => line.startsWith("[voice]"));
  const events = (h: ReturnType<typeof createHarness>): string[] => all(h).map((line) => /event=(\w+)/.exec(line)?.[1] ?? "");

  it("follows a reply from hello to the stored message, in order, with counts and timings and none of the words", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "what is the secret launch code", { partial: "what is the" });
    h.event("session:started");
    h.delta("text", "The code is hidden. ");
    h.delta("text", "Ask again later.");
    await settle();
    h.event("session:completed", { result: "The code is hidden. Ask again later.", error: null });
    await settle();

    const order = events(h);
    const firstOf = (name: string): number => {
      const at = order.indexOf(name);
      expect(at, `${name} was not logged`).toBeGreaterThanOrEqual(0);
      return at;
    };
    const sequence = ["hub_attach", "hub_created", "hello", "ready_sent", "utterance_open", "stt_final", "final_transcript", "dispatch_plan", "dispatch_deliver", "dispatch_delivered", "turn_started", "reply_start", "segment_queued", "synth_start", "segment_start", "synth_end", "segment_end", "turn_ended", "reply_finished", "reply_spoken"];
    const positions = sequence.map(firstOf);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    const lines = all(h).join("\n");
    expect(lines).toContain("att=id1 session=" + SESSION);
    expect(lines).toMatch(/event=final_transcript .*chars=30 /);
    expect(lines).toMatch(/event=segment_end .*frames=\d+ bytes=\d+ audio_ms=\d+/);
    expect(lines).toMatch(/event=reply_spoken .*fed_chars=\d+ spoken_chars=\d+/);
    // Lengths, ids and timings only: nothing said or spoken is in the log.
    for (const secret of ["secret launch code", "code is hidden", "Ask again later", "what is the"]) expect(lines).not.toContain(secret);
  });

  it("logs frames and chunks only at debug", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "hello");
    await h.reply("Hi to you.");
    const debugEvents = h.debugs.map((line) => /event=(\w+)/.exec(line)?.[1]);
    expect(debugEvents).toEqual(expect.arrayContaining(["audio_frame", "synth_chunk", "reply_text"]));
    expect(h.infos.some((line) => line.includes("event=audio_frame") || line.includes("event=synth_chunk"))).toBe(false);
  });

  it("records a barge-in from the client's report to the cut and the resume", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "go");
    h.event("session:started");
    h.delta("text", "Alpha one two three. Beta one two three four. ");
    await settle();
    attachment.onText(JSON.stringify({ type: "barge_in", segmentId: 1, playedMs: 40 }));
    await settle();
    h.vad().start();
    h.audio(attachment, 4);
    h.vad().end();
    h.stt.last().final("");
    await settle();

    const order = events(h);
    const sequence = ["client_barge_in", "pipeline_cut", "barge_in_begin", "barge_in_claimed", "barge_in_resume", "pipeline_resume"];
    const positions = sequence.map((name) => order.indexOf(name));
    expect(positions.every((at) => at >= 0), `missing: ${sequence.filter((_, i) => positions[i] < 0).join(", ")}`).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(all(h).join("\n")).toMatch(/event=client_barge_in .*segment=1 played_ms=40 speaking=true enabled=true/);
  });

  it("warns, once, when audio is dropped because the socket is gone", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await h.say(attachment, "go");
    h.event("session:started");
    socket.readyState = 3;
    h.delta("text", "One sentence here. Another sentence follows. ");
    await settle();
    const dropped = h.warnings.filter((line) => line.includes("event=audio_out_dropped"));
    expect(dropped).toHaveLength(1);
  });

  it("does not warn about a settled reply that is the last text block of a turn that used a tool", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "go");
    h.event("session:started");
    h.delta("text", "Let me check that. ");
    h.delta("tool_use", "", { toolName: "Bash" });
    h.delta("tool_result", "ok");
    h.delta("text", "The answer is four.");
    await settle();
    h.event("session:completed", { result: "The answer is four.", error: null });
    await settle();
    expect(all(h).join("\n")).toContain("event=turn_ended");
    expect(h.warnings.filter((line) => line.includes("event=reply_snapshot_ignored"))).toEqual([]);
  });

  it("does not warn about a settled reply that only lost the whitespace the stream ended in", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "go");
    h.event("session:started");
    h.delta("text", "It is noon.\n\n");
    await settle();
    h.event("session:completed", { result: "It is noon.", error: null });
    await settle();
    expect(all(h).join("\n")).toContain("event=turn_ended");
    expect(h.warnings.filter((line) => line.includes("event=reply_snapshot_ignored"))).toEqual([]);
  });

  it("warns when the settled reply disagrees with what was streamed and spoken", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "go");
    h.event("session:started");
    h.delta("text", "The answer is four.");
    await settle();
    h.event("session:completed", { result: "The answer is five.", error: null });
    await settle();
    expect(h.warnings.filter((line) => line.includes("event=reply_snapshot_ignored"))).toHaveLength(1);
  });

  it("a malformed hello gets the same answer as before and never throws out of the socket handler", () => {
    const h = createHarness();
    const { socket, attachment } = h.connect({ hello: false });
    for (const frame of [
      { type: "hello", protocol: { a: 1 }, mode: "hands-free" },
      { type: "hello", protocol: 1, mode: ["x"] },
      { type: "hello", protocol: 1, mode: "hands-free", client: { x: 1 } },
    ]) expect(() => attachment.onText(JSON.stringify(frame))).not.toThrow();
    expect(socket.ofType("error").map((f) => f.code)).toEqual(expect.arrayContaining(["bad_frame"]));
    expect(h.warnings.join("\n")).not.toContain("secret");
  });

  it("a barge_in with a segment id that is not a number is logged, not thrown", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "go");
    h.event("session:started");
    h.delta("text", "Alpha one two three. ");
    await settle();
    expect(() => attachment.onText(JSON.stringify({ type: "barge_in", segmentId: { x: 1 }, playedMs: [1] }))).not.toThrow();
    expect(all(h).join("\n")).toContain("event=client_barge_in");
  });
});
