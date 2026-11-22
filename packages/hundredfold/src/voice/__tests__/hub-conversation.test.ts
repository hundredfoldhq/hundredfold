import { describe, expect, it } from "vitest";
import { VOICE_PROMPT_OPEN, VOICE_REMINDER, interruptedNote } from "../envelope.js";
import { baseConfig, createHarness, SESSION } from "./hub-harness.js";
import { settle } from "./fakes.js";

describe("a spoken round trip (US1)", () => {
  it("speech becomes one message; partials show while speaking; the reply is spoken sentence by sentence; the exchange is measured", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    socket.clear();
    h.vad().start(); // spoken: vad frame
    h.audio(attachment, 10);
    h.stt.last().partial("what is");
    h.stt.last().partial("what is the time");
    h.vad().end();
    h.clock.advance(120);
    h.stt.last().final("what is the time");
    await settle();

    expect(socket.ofType("vad").map((f) => f.speaking)).toEqual([true, false]);
    expect(socket.ofType("transcript")).toEqual([
      { type: "transcript", utteranceId: "id2", text: "what is", final: false },
      { type: "transcript", utteranceId: "id2", text: "what is the time", final: false },
      { type: "transcript", utteranceId: "id2", text: "what is the time", final: true },
    ]);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({ sessionId: SESSION, text: "what is the time", mode: "queue", operator: true });
    expect(h.delivered[0].meta).toEqual({ voice: { utteranceId: "id2", sttProvider: "fake-stt", audioMs: expect.any(Number) } });

    h.event("session:started");
    h.delta("text", "It is noon. ");
    h.delta("text", "Anything else?");
    await settle();
    h.clock.advance(0);
    const starts = socket.ofType("segment_start");
    expect(starts.map((f) => f.text)).toEqual(["It is noon."]);
    expect(socket.audio().length).toBeGreaterThan(0);
    h.event("session:completed", { result: "It is noon. Anything else?", error: null });
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["It is noon.", "Anything else?"]);
    expect(socket.ofType("metrics")).toEqual([{ type: "metrics", utteranceId: "id2", sttMs: 120, ttfaMs: expect.any(Number) }]);
  });

  it("the time to first audio runs from the final to the first audio byte of the reply, and is kept on the reply's stored message", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await h.say(attachment, "hello there");
    h.clock.advance(350); // the model thinks
    h.event("session:started");
    h.delta("text", "Hi to you. ");
    await settle();
    expect(socket.ofType("metrics")[0].ttfaMs).toBe(350);
    h.event("session:completed", { result: "Hi to you.", error: null });
    await settle();
    expect(h.merges).toEqual([{ id: "assistant-1", patch: { voice: { spokenText: "Hi to you.", ttfaMs: 350 } } }]);
  });

  it("a final with no words delivers nothing; a final of only spaces neither", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await h.say(attachment, "");
    await h.say(attachment, "   \n ");
    expect(h.delivered).toHaveLength(0);
    expect(socket.ofType("transcript").filter((f) => f.final)).toHaveLength(2);
  });

  it("the person's words are trimmed and delivered exactly once per final, in order", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "  one  ");
    await h.say(attachment, "two");
    expect(h.delivered.map((d) => d.text)).toEqual(["one", "two"]);
  });

  it("a reply the session starts itself (a finished background command) is spoken too, with no exchange to measure", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    await h.reply("The build finished. All green.");
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["The build finished.", "All green."]);
    expect(socket.ofType("metrics")).toHaveLength(0);
  });

  it("an exchange whose turn ends in silence still reports its stt time, with no first-audio time", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await h.say(attachment, "do the thing");
    h.event("session:started");
    h.event("session:completed", { result: "", error: null });
    await settle();
    expect(socket.ofType("metrics")).toEqual([{ type: "metrics", utteranceId: "id2", sttMs: 0, ttfaMs: null }]);
  });

  it("turn frames follow the engine: thinking, working with the tool, speaking, then idle once heard", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await h.say(attachment, "go");
    socket.clear();
    h.event("session:started");
    h.delta("tool_use", "", { toolName: "Bash" });
    h.delta("tool_result", "ok");
    h.delta("text", "Done. ");
    await settle();
    h.event("session:completed", { result: "Done.", error: null });
    await settle();
    const ids = socket.ofType("segment_start").map((f) => f.segmentId as number);
    for (const id of ids) attachment.onText(h.json({ type: "played", segmentId: id }));
    expect(socket.ofType("turn")).toEqual([
      { type: "turn", state: "thinking" },
      { type: "turn", state: "working", tool: "Bash" },
      { type: "turn", state: "thinking" },
      { type: "turn", state: "speaking" },
      { type: "turn", state: "idle" },
    ]);
  });

  it("sub-agent text and tools are not the main reply", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.event("session:started");
    h.delta("text", "Sub-agent chatter. ", { sidechain: true });
    h.delta("tool_use", "", { toolName: "Grep", sidechain: true });
    h.delta("text", "Real reply. ");
    h.event("session:completed", { result: "", error: null });
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Real reply."]);
    expect(socket.ofType("turn").some((f) => f.tool === "Grep")).toBe(false);
  });
});

describe("snapshots are never re-spoken", () => {
  it("a snapshot that repeats the streamed text adds nothing", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.event("session:started");
    h.delta("text", "Streamed once. ");
    h.delta("text", "Twice over.");
    h.delta("text_snapshot", "Streamed once. Twice over.");
    h.event("session:completed", { result: "Streamed once. Twice over.", error: null });
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Streamed once.", "Twice over."]);
    expect(h.tts.calls).toEqual(["Streamed once.", "Twice over."]);
  });

  it("an engine that only sends snapshots is spoken from them, each new part once", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.event("session:started");
    h.delta("text_snapshot", "First part. ");
    h.delta("text_snapshot", "First part. Second part. ");
    h.delta("text_snapshot", "First part. Second part. ");
    h.event("session:completed", { result: "", error: null });
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["First part.", "Second part."]);
  });
});

describe("time to first audio on an engine that answers all at once", () => {
  it("is measured to the first audio byte, not reported as nothing when the turn ends first", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await h.say(attachment, "what is it");
    let release!: () => void;
    h.tts.gate = new Promise<void>((resolve) => { release = resolve; });
    h.clock.advance(200);
    h.event("session:started");
    h.event("session:completed", { result: "Here is the answer.", error: null });
    await settle();
    expect(socket.ofType("metrics")).toHaveLength(0);
    h.clock.advance(450);
    release();
    await settle();
    expect(socket.ofType("metrics")).toEqual([{ type: "metrics", utteranceId: "id2", sttMs: 0, ttfaMs: 650 }]);
  });

  it("a reply still pins its own stored message when a newer one appears before it is touched again", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "one");
    h.state.replyMessage = "row-1";
    await h.reply("First reply.");
    h.state.replyMessage = "row-2";
    await h.reply("Second reply.");
    h.state.replyMessage = "row-3";
    attachment.onText(h.json({ type: "barge_in", segmentId: 2, playedMs: 5 }));
    await h.say(attachment, "talk over it");
    expect(h.merges.filter((m) => (m.patch as { voice: { interrupted?: boolean } }).voice.interrupted).map((m) => m.id)).toEqual(["row-2"]);
  });
});

describe("an engine that answers all at once", () => {
  it("a turn that streamed nothing is spoken from the result it settled with", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.event("session:started");
    h.event("session:completed", { result: "Answered in one piece. With two sentences.", error: null });
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Answered in one piece.", "With two sentences."]);
  });

  it("a result that only repeats what streamed adds nothing, and one that is not an extension of it is left alone", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    h.event("session:started");
    h.delta("text", "Streamed in pieces. ");
    h.event("session:completed", { result: "Streamed in pieces. ", error: null });
    h.event("session:started");
    h.delta("text", "First block. ");
    h.delta("tool_use", "", { toolName: "Bash" });
    h.delta("text", "Second block. ");
    h.event("session:completed", { result: "Second block.", error: null });
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Streamed in pieces.", "First block.", "Second block."]);
  });

  it("a reply the client missed while suspended is kept from its result too", async () => {
    const h = createHarness();
    const first = h.connect();
    h.hub.socketClosed(first.attachment, first.socket, 1006);
    h.event("session:started");
    h.event("session:completed", { result: "Done while you were away.", error: null });
    const back = h.connect();
    back.attachment.onText(h.json({ type: "resume", suspendedMs: 10 }));
    await settle();
    expect(back.socket.ofType("segment_start").map((f) => f.text)).toEqual(["Done while you were away."]);
  });
});

describe("code and the like stay in the text", () => {
  it("fenced code, tables, paths and links are not spoken", async () => {
    const h = createHarness();
    const { socket } = h.connect();
    await h.reply("Done.\n```\nrm -rf build\n```\n| a | b |\n|---|---|\nSee /etc/hosts or https://x.test/y. All fine.\n");
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Done.", "See or the link on screen", "All fine."]);
  });
});

describe("the voice envelope on a spoken turn", () => {
  it("the first turn carries the full prompt, later turns the one-line reminder", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "first");
    await h.say(attachment, "second");
    expect(h.delivered[0].envelope).toContain(VOICE_PROMPT_OPEN);
    expect(h.delivered[1].envelope).toBe(`${VOICE_REMINDER}\n\n`);
    expect(h.delivered[0].text).toBe("first");
    expect(h.delivered[0].text).not.toContain("Voice");
  });

  it("a command goes unchanged with no envelope, and does not use up the full prompt", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "/compact");
    await h.say(attachment, "after");
    expect(h.delivered[0].envelope).toBe("");
    expect(h.delivered[1].envelope).toContain(VOICE_PROMPT_OPEN);
  });

  it("the full prompt goes again after a compaction", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "one");
    await h.say(attachment, "two");
    h.event("session:compacted", { preTokens: 9000, postTokens: 900 });
    await h.say(attachment, "three");
    expect(h.delivered.map((d) => d.envelope.includes(VOICE_PROMPT_OPEN))).toEqual([true, false, true]);
  });

  it("the full prompt goes again after an engine switch", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await h.say(attachment, "one");
    h.state.engineName = "other";
    await h.say(attachment, "two");
    await h.say(attachment, "three");
    expect(h.delivered.map((d) => d.envelope.includes(VOICE_PROMPT_OPEN))).toEqual([true, true, false]);
  });

  it("a configured style rides on the first turn's prompt and on every later turn's reminder", async () => {
    const h = createHarness({ config: { stylePrompt: "Shorter, funnier, make jokes." } });
    const { attachment } = h.connect();
    await h.say(attachment, "first");
    await h.say(attachment, "second");
    await h.say(attachment, "third");
    expect(h.delivered[0].envelope).toContain("Shorter, funnier, make jokes.");
    expect(h.delivered[0].envelope).toContain(VOICE_PROMPT_OPEN);
    for (const later of h.delivered.slice(1)) expect(later.envelope).toContain("[Voice: style directions from the user: Shorter, funnier, make jokes.]");
    expect(h.delivered.every((d) => !d.text.includes("jokes"))).toBe(true);
  });

  it("no style set leaves every envelope as it was", async () => {
    const h = createHarness({ config: { stylePrompt: "" } });
    const { attachment } = h.connect();
    await h.say(attachment, "first");
    await h.say(attachment, "second");
    expect(h.delivered[0].envelope).not.toContain("Style directions");
    expect(h.delivered[1].envelope).toBe(`${VOICE_REMINDER}\n\n`);
  });

  it("a style changed by a config reload reaches the conversation already open, with no new attachment", async () => {
    const h = createHarness({ config: { stylePrompt: "Be formal." } });
    const { attachment } = h.connect();
    await h.say(attachment, "first");
    h.state.config = baseConfig({ stylePrompt: "Be playful." });
    h.event("config:reloaded", {});
    await h.say(attachment, "second");
    h.state.config = baseConfig({ stylePrompt: "" });
    await h.say(attachment, "third");
    expect(h.delivered[0].envelope).toContain("Be formal.");
    expect(h.delivered[1].envelope).toContain("Be playful.");
    expect(h.delivered[1].envelope).not.toContain("Be formal.");
    expect(h.delivered[2].envelope).toBe(`${VOICE_REMINDER}\n\n`);
  });

  it("a replaced prompt in the configuration is the one sent", async () => {
    const h = createHarness({ config: { prompt: "Talk like a pirate." } });
    const { attachment } = h.connect();
    await h.say(attachment, "ahoy");
    expect(h.delivered[0].envelope).toContain("Talk like a pirate.");
  });

  it("a delivery that fails does not use up the full prompt, and tells the person without detail", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.state.deliverFails = true;
    await h.say(attachment, "lost");
    h.state.deliverFails = false;
    await h.say(attachment, "again");
    expect(socket.ofType("error").map((f) => f.code)).toEqual(["dispatch_failed"]);
    expect(JSON.stringify(socket.ofType("error"))).not.toContain("secret");
    expect(h.delivered[0].envelope).toContain(VOICE_PROMPT_OPEN);
  });
});

describe("a failure to record what was heard", () => {
  it("is logged, never an unhandled rejection, and the conversation goes on", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    (h.deps as { mergeMessageMeta: unknown }).mergeMessageMeta = () => { throw new Error("database is locked"); };
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await h.say(attachment, "hello");
      await h.reply("A reply to record.");
      await settle(20);
      attachment.onText(h.json({ type: "barge_in", segmentId: 1, playedMs: 1 }));
      await h.say(attachment, "again");
      await settle(20);
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toEqual([]);
    expect(h.warnings.some((w) => w.includes("could not record what was heard"))).toBe(true);
    expect(h.delivered.map((d) => d.text)).toEqual(["hello", "again"]);
  });
});

describe("limits and failures", () => {
  it("an utterance past the limit is cut, the person is told, and what was captured is used once", async () => {
    const h = createHarness({ config: { limits: { maxUtteranceSeconds: 5, maxConcurrentAttachments: 4 } } });
    const { socket, attachment } = h.connect();
    h.vad().start(0);
    h.audio(attachment, 300); // 6 s
    expect(socket.ofType("error").map((f) => f.code)).toEqual(["utterance_too_long"]);
    h.vad().end();
    h.stt.last().final("a very long thought");
    await settle();
    expect(h.delivered.map((d) => d.text)).toEqual(["a very long thought"]);
  });

  it("recognition failing tells the person with no provider detail, and voice carries on", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    h.vad().start();
    h.audio(attachment, 5);
    h.stt.last().emit({ type: "error", message: "key sk-live-secret rejected" });
    await settle();
    const errors = socket.ofType("error");
    expect(errors.map((f) => f.code)).toEqual(["stt_failed"]);
    expect(JSON.stringify(errors)).not.toContain("sk-live");
    await h.say(attachment, "second try");
    expect(h.delivered.map((d) => d.text)).toEqual(["second try"]);
  });

  it("speech failing for a reply tells the person once, with no provider detail; the reply goes on", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await h.say(attachment, "talk");
    h.tts.failOn = "bad";
    h.event("session:started");
    h.delta("text", "A bad one. Another bad one. A good one. ");
    h.event("session:completed", { result: "", error: null });
    await settle();
    const errors = socket.ofType("error");
    expect(errors.map((f) => f.code)).toEqual(["tts_failed"]);
    expect(JSON.stringify(errors)).not.toContain("secret-ish");
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["A good one."]);
    expect(h.warnings.some((w) => w.includes("synthesis failed"))).toBe(true);
  });
});

describe("push to talk", () => {
  it("the key marks the utterance; audio outside it is ignored; no VAD endpointing", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect({ mode: "push-to-talk" });
    h.audio(attachment, 10);
    attachment.onText(h.json({ type: "ptt_down" }));
    h.audio(attachment, 10);
    h.stt.last().partial("held key");
    attachment.onText(h.json({ type: "ptt_up" }));
    h.stt.last().final("held key words");
    await settle();
    expect(h.vad().written).toBe(0);
    expect(h.stt.streams).toHaveLength(1);
    expect(h.stt.last().bytes()).toBe(10 * 640);
    expect(h.delivered.map((d) => d.text)).toEqual(["held key words"]);
    expect(socket.ofType("transcript").map((f) => f.text)).toEqual(["held key", "held key words"]);
  });
});

describe("the interrupted line in the envelope", () => {
  it("is built from what was heard, one line", () => {
    expect(interruptedNote("so far this")).toContain('"so far this"');
  });
});
