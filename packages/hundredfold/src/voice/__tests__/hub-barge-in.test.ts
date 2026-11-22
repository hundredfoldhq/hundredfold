import { describe, expect, it } from "vitest";
import { BARGE_IN_GRACE_MS } from "../barge-in.js";
import { interruptedNote } from "../envelope.js";
import { createHarness, OPERATOR, SESSION, type Harness } from "./hub-harness.js";
import { settle, type FakeEngineOptions } from "./fakes.js";
import type { VoiceAttachment } from "../attachment.js";

/** A reply mid-way: sentence one has gone out, two and three are made but held back by the gate. */
async function midReply(h: Harness): Promise<void> {
  h.event("session:started");
  h.delta("text", "Alpha one two three. ");
  await settle();
  let release!: () => void;
  h.tts.gate = new Promise<void>((resolve) => { release = resolve; });
  h.delta("text", "Beta one two three four. Gamma ends it. ");
  await settle();
  (h as unknown as { release: () => void }).release = release;
}

const bargeIn = (attachment: VoiceAttachment, segmentId: number | null, playedMs = 0) =>
  attachment.onText(JSON.stringify({ type: "barge_in", segmentId, playedMs }));

describe("barge-in (US2)", () => {
  it("after barge_in no audio is sent for a segment that was already queued, and its synthesis is aborted", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await midReply(h);
    const audioBefore = socket.audio().length;
    bargeIn(attachment, 1, 20);
    (h as unknown as { release: () => void }).release();
    await settle();
    expect(socket.audio().length).toBe(audioBefore);
    expect(socket.ofType("segment_start")).toHaveLength(1);
    expect(h.tts.signals.slice(1).every((s) => s.aborted)).toBe(true);
    expect(h.delivered).toHaveLength(0);
  });

  it("an utterance with no words resumes speaking from the first sentence not heard, and sends nothing", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await midReply(h);
    bargeIn(attachment, 2, 0);
    h.tts.gate = null;
    h.vad().start();
    h.audio(attachment, 6);
    h.vad().end();
    h.stt.last().final("");
    await settle();
    expect(h.delivered).toHaveLength(0);
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Alpha one two three.", "Beta one two three four.", "Gamma ends it."]);
    expect(h.merges).toEqual([]);
  });

  it("a stop with no utterance after it (a cough the VAD never heard) resumes after the grace period", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await midReply(h);
    bargeIn(attachment, 2, 0);
    h.tts.gate = null;
    await settle();
    h.clock.advance(BARGE_IN_GRACE_MS - 10);
    await settle();
    expect(socket.ofType("segment_start")).toHaveLength(1);
    h.clock.advance(20);
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text).slice(1)).toEqual(["Beta one two three four.", "Gamma ends it."]);
  });

  it("an utterance that does start takes the stop over: no resume at the grace period", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await midReply(h);
    bargeIn(attachment, 2, 0);
    h.tts.gate = null;
    h.vad().start();
    h.clock.advance(BARGE_IN_GRACE_MS * 3);
    await settle();
    expect(socket.ofType("segment_start")).toHaveLength(1);
  });

  it("an utterance with words is the next message, tells the session what was heard, and records it on the reply", async () => {
    const h = createHarness();
    h.state.turnRunning = true;
    const { socket, attachment } = h.connect();
    await midReply(h);
    bargeIn(attachment, 2, 0);
    await h.say(attachment, "actually stop that");
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].text).toBe("actually stop that");
    expect(h.delivered[0].envelope).toContain(interruptedNote("Alpha one two three."));
    // Nothing was heard past sentence one, and nothing of the old thread is spoken again.
    expect(socket.ofType("segment_start")).toHaveLength(1);
    h.event("session:completed", { result: "", error: null });
    await settle();
    expect(h.merges).toEqual([{ id: "assistant-1", patch: { voice: { spokenText: "Alpha one two three.", interrupted: true } } }]);
  });

  it("the gateway's own VAD hearing speech over playback stops playback and tells the client", async () => {
    const h = createHarness();
    const { socket, attachment } = h.connect();
    await midReply(h);
    socket.clear();
    h.vad().start();
    expect(socket.ofType("stop_playback")).toEqual([{ type: "stop_playback", reason: "speech" }]);
    (h as unknown as { release: () => void }).release();
    h.audio(attachment, 5);
    await settle();
    expect(socket.audio()).toHaveLength(0);
    // No new segment of the interrupted reply starts after the stop.
    expect(socket.ofType("segment_start")).toHaveLength(0);
    h.vad().end();
    h.stt.last().final("hold on a second");
    await settle();
    expect(h.delivered[0].envelope).toContain(interruptedNote(""));
  });

  it("cut off before any sentence was heard: the stored message says nothing was heard, not that all of it was", async () => {
    const h = createHarness();
    h.state.turnRunning = true;
    const { attachment } = h.connect();
    await midReply(h);
    bargeIn(attachment, null, 0); // the gateway-first cut: no segment, nothing played
    await h.say(attachment, "hold on a second");
    h.event("session:completed", { result: "", error: null });
    await settle();
    expect(h.merges).toEqual([{ id: "assistant-1", patch: { voice: { spokenText: "", interrupted: true } } }]);
  });

  it("a stop when nothing is playing is not a barge-in", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    bargeIn(attachment, null, 0);
    await h.say(attachment, "hello");
    expect(h.delivered[0].envelope).not.toContain("interrupted");
  });

  it("with barge-in turned off the client's stop is ignored and the gateway does not stop playback", async () => {
    const h = createHarness({ config: { bargeIn: { enabled: false, minSpeechMs: 250, onsetThreshold: 0.02 } } });
    const { socket, attachment } = h.connect();
    await midReply(h);
    socket.clear();
    bargeIn(attachment, 1, 10);
    h.vad().start();
    expect(socket.ofType("stop_playback")).toHaveLength(0);
    (h as unknown as { release: () => void }).release();
    await settle();
    expect(socket.ofType("segment_start").length).toBeGreaterThan(0);
  });

  it("a second stop while one is pending does not cut again", async () => {
    const h = createHarness();
    const { attachment } = h.connect();
    await midReply(h);
    bargeIn(attachment, 2, 0);
    h.tts.gate = null;
    const calls = h.tts.calls.length;
    bargeIn(attachment, 2, 0);
    await settle();
    expect(h.tts.calls.length).toBe(calls);
  });
});

/** An engine with `work` running a long foreground call, which the hub must never kill. */
async function speakDuringWork(opts: {
  engine: FakeEngineOptions;
  work?: "long" | "young" | "none";
  autoBackground?: boolean;
  /** Whether a soft interrupt would background the running call (a Bash can be, an MCP call cannot). */
  backgroundable?: boolean;
}) {
  const h = createHarness({
    engine: opts.engine,
    config: { autoBackground: { enabled: opts.autoBackground ?? true, afterSeconds: 5 } },
  });
  h.state.turnRunning = true;
  if (opts.work !== "none") {
    h.engine.work = { tool: "Bash", startedAt: h.clock.now() - (opts.work === "young" ? 1_000 : 8_000), description: "sleep 60", backgroundable: opts.backgroundable ?? true };
  }
  const { socket, attachment } = h.connect();
  await h.say(attachment, "what is two plus two");
  return { h, socket, attachment };
}

describe("how a spoken message reaches a running turn (FR-013 to FR-018)", () => {
  it("no turn running: delivered as an ordinary message, with no soft interrupt and no kill", async () => {
    const h = createHarness({ engine: { soft: { preserves: true }, steerable: true } });
    const { attachment } = h.connect();
    await h.say(attachment, "hello");
    expect(h.delivered.map((d) => d.mode)).toEqual(["queue"]);
    expect(h.engine.softCalls).toEqual([]);
    expect(h.engine.kills).toEqual([]);
  });

  describe("long work, on every kind of engine, is never killed", () => {
    const engines: Array<[string, FakeEngineOptions, boolean, string]> = [
      ["soft interrupt, a Bash that can be backgrounded", { soft: { preserves: true } }, true, "queue"],
      ["soft interrupt and steerable, a Bash that can be backgrounded", { soft: { preserves: true }, steerable: true }, true, "queue"],
      ["soft interrupt and steerable, a call that cannot be backgrounded", { soft: { preserves: true }, steerable: true }, false, "steer"],
      ["soft interrupt only, a call that cannot be backgrounded", { soft: { preserves: true } }, false, "queue"],
      ["steerable only", { steerable: true }, true, "steer"],
      ["reports work but can do nothing about it", { reportsWork: true }, true, "queue"],
    ];
    it.each(engines)("%s", async (_name, engine, backgroundable, mode) => {
      const { h } = await speakDuringWork({ engine, backgroundable });
      expect(h.engine.kills).toEqual([]);
      expect(h.delivered).toHaveLength(1);
      expect(h.delivered[0].mode).toBe(mode);
      expect(h.delivered[0].mode).not.toBe("interrupt");
    });

    it("a call that cannot be backgrounded is never soft-interrupted, which would abort it", async () => {
      const { h, socket } = await speakDuringWork({ engine: { soft: { preserves: true }, steerable: true }, backgroundable: false });
      expect(h.engine.softCalls).toEqual([]);
      expect(socket.ofType("holding")).toHaveLength(1);
    });

    it("with backgrounding turned off, a soft interrupt engine is treated as one that cannot background", async () => {
      const { h } = await speakDuringWork({ engine: { soft: { preserves: true }, steerable: true }, autoBackground: false });
      expect(h.engine.softCalls).toEqual([]);
      expect(h.engine.kills).toEqual([]);
      expect(h.delivered[0].mode).toBe("steer");
    });
  });

  it("soft_then_turn: the turn ends softly, backgrounded work is announced and told to the session, the message waits its turn", async () => {
    const { h, socket } = await speakDuringWork({ engine: { soft: { preserves: true } }, work: "long" });
    // The engine moved the command to the background; the first speak call already ran. Do it again with an outcome.
    expect(h.engine.softCalls).toHaveLength(1);
    const h2 = createHarness({ engine: { soft: { preserves: true } } });
    h2.state.turnRunning = true;
    h2.engine.work = { tool: "Bash", startedAt: h2.clock.now() - 9_000, description: "sleep 60", backgroundable: true };
    h2.engine.softOutcome = { ended: true, backgrounded: [{ taskId: "bg-1", description: "sleep 60 && echo done" }] };
    const second = h2.connect();
    await h2.say(second.attachment, "what is two plus two");
    expect(second.socket.ofType("background")).toEqual([{ type: "background", taskId: "bg-1", description: "sleep 60 && echo done" }]);
    expect(h2.delivered[0].envelope).toContain("moved to the background");
    expect(h2.delivered[0].envelope).toContain("sleep 60 && echo done");
    expect(h2.delivered[0].mode).toBe("queue");
    expect(h2.engine.kills).toEqual([]);
    // A soft interrupt can take seconds: the holding line covers the wait.
    expect(socket.ofType("holding")).toHaveLength(1);
  });

  it("steer_with_holding speaks the holding line at once, then steers the message in", async () => {
    const { h, socket } = await speakDuringWork({ engine: { steerable: true }, work: "long" });
    expect(socket.ofType("holding")).toEqual([{ type: "holding", text: h.state.config!.holdingLine }]);
    expect(h.delivered[0].mode).toBe("steer");
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Still working on the last thing. I'll come to that as soon as it's done."]);
  });

  it("queue_with_holding speaks the holding line and queues behind the turn", async () => {
    const { h, socket } = await speakDuringWork({ engine: { reportsWork: true }, work: "long" });
    expect(socket.ofType("holding")).toHaveLength(1);
    expect(h.delivered[0].mode).toBe("queue");
    expect(h.engine.kills).toEqual([]);
  });

  it("no long work: a soft interrupt ends the turn without a kill; steer where it can; the existing send-now otherwise", async () => {
    const soft = await speakDuringWork({ engine: { soft: { preserves: true } }, work: "none" });
    expect(soft.h.engine.softCalls).toHaveLength(1);
    expect(soft.h.delivered[0].mode).toBe("queue");
    expect(soft.h.engine.kills).toEqual([]);
    const steer = await speakDuringWork({ engine: { steerable: true }, work: "none" });
    expect(steer.h.delivered[0].mode).toBe("steer");
    expect(steer.socket.ofType("holding")).toHaveLength(0);
    const plain = await speakDuringWork({ engine: { reportsWork: true }, work: "none" });
    expect(plain.h.delivered[0].mode).toBe("interrupt");
    expect(plain.socket.ofType("holding")).toHaveLength(0);
  });

  describe("an engine that cannot say what is running is taken to be running long work (it is never killed)", () => {
    it.each([
      ["not steerable", { reportsWork: false }, "queue"],
      ["steerable", { steerable: true, reportsWork: false }, "steer"],
    ] as const)("%s: held with a holding line, kill never called", async (_name, engine, mode) => {
      const { h, socket } = await speakDuringWork({ engine, work: "none" });
      expect(h.delivered.map((d) => d.mode)).toEqual([mode]);
      expect(socket.ofType("holding")).toHaveLength(1);
      expect(h.engine.kills).toEqual([]);
      expect(h.engine.softCalls).toEqual([]);
    });

    it("an engine that reports and reports nothing running is the only one asked to send-now", async () => {
      const { h } = await speakDuringWork({ engine: { reportsWork: true }, work: "none" });
      expect(h.delivered.map((d) => d.mode)).toEqual(["interrupt"]);
    });
  });

  describe("a call younger than the threshold is given until then (FR-013)", () => {
    it("finishing in time: the utterance becomes an ordinary message, with nothing moved", async () => {
      const { h } = await speakDuringWork({ engine: { soft: { preserves: true } }, work: "young" });
      expect(h.delivered).toHaveLength(0);
      h.engine.work = null;
      h.state.turnRunning = false;
      h.clock.advance(4_000);
      await settle();
      expect(h.delivered.map((d) => d.mode)).toEqual(["queue"]);
      expect(h.engine.softCalls).toEqual([]);
      expect(h.engine.kills).toEqual([]);
    });

    it("still running at the threshold: now it is long work, and is moved to the background", async () => {
      const { h } = await speakDuringWork({ engine: { soft: { preserves: true } }, work: "young" });
      h.clock.advance(3_900);
      await settle();
      expect(h.delivered).toHaveLength(0);
      h.clock.advance(200);
      await settle();
      expect(h.engine.softCalls).toHaveLength(1);
      expect(h.delivered.map((d) => d.mode)).toEqual(["queue"]);
      expect(h.engine.kills).toEqual([]);
    });

    it("a call that restarts as a new one each time is not waited on forever", async () => {
      const { h } = await speakDuringWork({ engine: { steerable: true }, work: "young" });
      for (let i = 0; i < 6; i += 1) {
        h.engine.work = { tool: "Bash", startedAt: h.clock.now() - 500, description: "next", backgroundable: true };
        h.clock.advance(4_600);
        await settle();
      }
      expect(h.delivered.map((d) => d.mode)).toEqual(["steer"]);
      expect(h.engine.kills).toEqual([]);
    });
  });

  describe("a soft interrupt that cannot end the turn", () => {
    it("no turn was running by then: the message is simply queued", async () => {
      const h = createHarness({ engine: { soft: { preserves: true } } });
      h.state.turnRunning = true;
      h.engine.softOutcome = { ended: false, reason: "no_turn" };
      const { attachment, socket } = h.connect();
      await h.say(attachment, "hello");
      expect(h.delivered.map((d) => d.mode)).toEqual(["queue"]);
      expect(socket.ofType("holding")).toHaveLength(0);
      expect(h.engine.kills).toEqual([]);
    });

    it("no acknowledgement came and nothing long runs: the decision is run again as if the engine had no soft interrupt", async () => {
      for (const [engine, mode] of [[{ soft: { preserves: true }, steerable: true }, "steer"], [{ soft: { preserves: true } }, "interrupt"]] as const) {
        const h = createHarness({ engine });
        h.state.turnRunning = true;
        h.engine.softOutcome = { ended: false, reason: "unsupported" };
        const { attachment, socket } = h.connect();
        await h.say(attachment, "hello");
        expect(h.engine.softCalls).toHaveLength(1);
        expect(h.delivered.map((d) => d.mode)).toEqual([mode]);
        expect(socket.ofType("holding")).toHaveLength(0);
        expect(h.engine.kills).toEqual([]);
      }
    });

    it("no acknowledgement for a long Bash (it is still running): steer or queue behind it with one holding line, never a kill", async () => {
      for (const [steerable, mode] of [[true, "steer"], [false, "queue"]] as const) {
        const { h, socket } = await (async () => {
          const h = createHarness({ engine: { soft: { preserves: true }, steerable } });
          h.state.turnRunning = true;
          h.engine.work = { tool: "Bash", startedAt: h.clock.now() - 9_000, description: "sleep 60", backgroundable: true };
          h.engine.softOutcome = { ended: false, reason: "unsupported" };
          const { socket, attachment } = h.connect();
          await h.say(attachment, "what is two plus two");
          return { h, socket };
        })();
        expect(h.engine.softCalls).toHaveLength(1);
        expect(h.delivered.map((d) => d.mode)).toEqual([mode]);
        expect(socket.ofType("holding")).toHaveLength(1);
        expect(h.engine.kills).toEqual([]);
      }
    });
  });
});

describe("the wait for a soft interrupt (it can take several seconds)", () => {
  it("the holding line is spoken at once, the turn stays `working`, and other frames are not held up", async () => {
    const h = createHarness({ engine: { soft: { preserves: true } } });
    h.state.turnRunning = true;
    h.engine.work = { tool: "Bash", startedAt: h.clock.now() - 9_000, description: "sleep 60", backgroundable: true };
    let finish!: () => void;
    (h.engine as unknown as { softInterrupt: unknown }).softInterrupt = () => new Promise((resolve) => {
      finish = () => resolve({ ended: true, backgrounded: [{ taskId: "bg-1", description: "sleep 60" }] });
    });
    const { socket, attachment } = h.connect();
    h.event("session:started");
    h.delta("tool_use", "", { toolName: "Bash" });
    await settle();
    socket.clear();
    await h.say(attachment, "what is two plus two");
    // Soft interrupt still pending: the line is out, nothing was delivered yet.
    expect(h.delivered).toHaveLength(0);
    expect(socket.ofType("holding")).toHaveLength(1);
    expect(socket.ofType("segment_start")).toHaveLength(1);
    expect(socket.ofType("turn").map((f) => f.state)).not.toContain("speaking");
    // Frames still flow while it waits.
    h.vad().start();
    h.audio(attachment, 3);
    expect(socket.ofType("vad").some((f) => f.speaking === true)).toBe(true);
    finish();
    await settle();
    expect(h.delivered.map((d) => d.mode)).toEqual(["queue"]);
  });

  it("an interrupted turn settles with its quiet-preemption error: nothing is reported and nothing is said", async () => {
    const h = createHarness({ engine: { soft: { preserves: true } } });
    h.state.turnRunning = true;
    const { socket, attachment } = h.connect();
    h.event("session:started");
    await h.say(attachment, "new question");
    socket.clear();
    h.event("session:completed", { result: null, error: "Interrupted: voice barge-in" });
    await settle();
    expect(socket.ofType("error")).toHaveLength(0);
    expect(socket.ofType("segment_start")).toHaveLength(0);
    expect(JSON.stringify(socket.frames())).not.toContain("Interrupted");
  });
});

describe("a message is not delivered to a session that voice has left", () => {
  async function youngBashThenSay(h: Harness, attachment: VoiceAttachment): Promise<void> {
    h.state.turnRunning = true;
    h.engine.work = { tool: "Bash", startedAt: h.clock.now() - 1_000, description: "sleep 60", backgroundable: true };
    await h.say(attachment, "hello there");
  }

  it("session stopped during the wait for a young call: nothing is soft-interrupted or delivered afterwards", async () => {
    const h = createHarness({ engine: { soft: { preserves: true }, steerable: true } });
    const { attachment } = h.connect();
    await youngBashThenSay(h, attachment);
    h.event("session:stopped");
    h.clock.advance(20_000);
    await settle();
    expect(h.delivered).toEqual([]);
    expect(h.engine.softCalls).toEqual([]);
  });

  it("bye during the wait: dropped too", async () => {
    const h = createHarness({ engine: { soft: { preserves: true }, steerable: true } });
    const { attachment } = h.connect();
    await youngBashThenSay(h, attachment);
    attachment.onText(JSON.stringify({ type: "bye" }));
    h.clock.advance(20_000);
    await settle();
    expect(h.delivered).toEqual([]);
  });

  it("access lost during the soft interrupt itself: the message is dropped when the interrupt returns", async () => {
    const h = createHarness({ engine: { soft: { preserves: true } } });
    h.state.turnRunning = true;
    h.engine.work = { tool: "Bash", startedAt: h.clock.now() - 9_000, description: "sleep 60", backgrounded: undefined, backgroundable: true } as never;
    let finish!: () => void;
    (h.engine as unknown as { softInterrupt: unknown }).softInterrupt = () => new Promise((resolve) => {
      finish = () => resolve({ ended: true, backgrounded: [] });
    });
    const { attachment } = h.connect();
    await h.say(attachment, "what is two plus two");
    h.hub.revoke(SESSION, OPERATOR);
    finish();
    await settle();
    expect(h.delivered).toEqual([]);
  });

  it("a live attachment still delivers after the same waits (the check is not a blanket drop)", async () => {
    const h = createHarness({ engine: { soft: { preserves: true }, steerable: true } });
    const { attachment } = h.connect();
    await youngBashThenSay(h, attachment);
    h.clock.advance(20_000);
    await settle();
    expect(h.delivered).toHaveLength(1);
  });
});

describe("a soft interrupt that would abort the call is never used", () => {
  it("an engine whose soft interrupt does not preserve foreground work is steered, not soft-interrupted, over a long Bash", async () => {
    const { h, socket } = await speakDuringWork({ engine: { soft: { preserves: false }, steerable: true } });
    expect(h.engine.softCalls).toEqual([]);
    expect(h.engine.kills).toEqual([]);
    expect(h.delivered.map((d) => d.mode)).toEqual(["steer"]);
    expect(socket.ofType("holding")).toHaveLength(1);
  });

  it("with no work running, any soft interrupt is still used to end the turn", async () => {
    const { h } = await speakDuringWork({ engine: { soft: { preserves: false } }, work: "none" });
    expect(h.engine.softCalls).toHaveLength(1);
    expect(h.delivered.map((d) => d.mode)).toEqual(["queue"]);
  });
});

describe("the old thread's tail is not spoken over the new answer", () => {
  it("after a send-now, text of the cut turn is dropped until a turn boundary, then the new reply is spoken", async () => {
    const h = createHarness({ engine: { reportsWork: true } });
    h.state.turnRunning = true;
    const { socket, attachment } = h.connect();
    h.event("session:started");
    await h.say(attachment, "new question");
    expect(h.delivered[0].mode).toBe("interrupt");
    h.delta("text", "Tail of the cut reply. ");
    await settle();
    expect(socket.ofType("segment_start")).toHaveLength(0);
    h.event("session:interrupted", { reason: "new message" });
    h.event("session:started");
    h.delta("text", "The fresh answer. ");
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["The fresh answer."]);
  });

  it("a steered message's turn is the same turn: its text after the hand-over is spoken", async () => {
    const h = createHarness({ engine: { steerable: true } });
    h.state.turnRunning = true;
    const { socket, attachment } = h.connect();
    h.event("session:started");
    await h.say(attachment, "also check the logs");
    expect(h.delivered[0].mode).toBe("steer");
    h.delta("text", "Checking the logs now. ");
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Checking the logs now."]);
  });

  it("a queued message waits behind the old turn: its tail is dropped, and the completion of that turn is the boundary", async () => {
    const h = createHarness({ engine: { reportsWork: true } });
    h.state.turnRunning = true;
    h.engine.work = { tool: "Bash", startedAt: h.clock.now() - 9_000, description: "tests", backgroundable: true };
    const { socket, attachment } = h.connect();
    h.event("session:started");
    await h.say(attachment, "what time is it");
    socket.clear();
    h.delta("text", "Old thread. ");
    h.event("session:completed", { result: "Old thread.", error: null });
    h.event("session:started");
    h.delta("text", "It is noon. ");
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["It is noon."]);
  });
});
