import { describe, expect, it } from "vitest";
import { RESUME_WINDOW_MS } from "../hub.js";
import { createHarness, OPERATOR, SESSION, type Harness } from "./hub-harness.js";
import { settle } from "./fakes.js";

/** The client vanishes with no goodbye, as a locked phone's page does. */
function suspend(h: Harness, c: ReturnType<Harness["connect"]>): void {
  h.hub.socketClosed(c.attachment, c.socket, 1006);
}

describe("a client the device suspended (FR-033)", () => {
  it("keeps its replies: nothing is synthesised for nobody, the finished reply is announced and spoken on resume", async () => {
    const h = createHarness();
    const first = h.connect();
    h.state.replyMessage = "assistant-9";
    suspend(h, first);
    await h.reply("The deploy finished. Everything is green.");
    expect(h.tts.calls).toEqual([]);
    expect(first.socket.audio()).toHaveLength(0);

    const back = h.connect();
    expect(back.attachment).toBe(first.attachment);
    expect(back.socket.ofType("ready")).toHaveLength(1);
    back.attachment.onText(h.json({ type: "resume", suspendedMs: 90_000 }));
    await settle();
    expect(back.socket.ofType("missed")).toEqual([{ type: "missed", messageIds: ["assistant-9"] }]);
    expect(back.socket.ofType("segment_start").map((f) => f.text)).toEqual(["The deploy finished.", "Everything is green."]);
    expect(back.socket.audio().length).toBeGreaterThan(0);
  });

  it("a reply in flight when the device suspended is part of what was missed, whole", async () => {
    const h = createHarness();
    const first = h.connect();
    h.event("session:started");
    h.delta("text", "Half of it was heard. ");
    await settle();
    suspend(h, first);
    h.delta("text", "The rest came later. ");
    h.event("session:completed", { result: "", error: null });
    await settle();
    const back = h.connect();
    back.attachment.onText(h.json({ type: "resume", suspendedMs: 5_000 }));
    await settle();
    expect(back.socket.ofType("segment_start").map((f) => f.text)).toEqual(["Half of it was heard.", "The rest came later."]);
  });

  it("several missed replies are announced together and spoken in order; replies after resume are spoken live", async () => {
    const h = createHarness();
    const first = h.connect();
    suspend(h, first);
    h.state.replyMessage = "m-1";
    await h.reply("First missed.");
    h.state.replyMessage = "m-2";
    await h.reply("Second missed.");
    const back = h.connect();
    back.attachment.onText(h.json({ type: "resume", suspendedMs: 1 }));
    await settle();
    expect(back.socket.ofType("missed")[0].messageIds).toEqual(["m-1", "m-2"]);
    expect(back.socket.ofType("segment_start").map((f) => f.text)).toEqual(["First missed.", "Second missed."]);
    await h.reply("Live after resume.");
    expect(back.socket.ofType("segment_start").map((f) => f.text).slice(-1)).toEqual(["Live after resume."]);
  });

  it("nothing missed: resume says nothing", async () => {
    const h = createHarness();
    const first = h.connect();
    suspend(h, first);
    const back = h.connect();
    back.attachment.onText(h.json({ type: "resume", suspendedMs: 1 }));
    await settle();
    expect(back.socket.ofType("missed")).toHaveLength(0);
  });

  it("what was missed is announced once, not again by a second resume", async () => {
    const h = createHarness();
    const first = h.connect();
    suspend(h, first);
    await h.reply("Once only.");
    const back = h.connect();
    back.attachment.onText(h.json({ type: "resume", suspendedMs: 1 }));
    back.attachment.onText(h.json({ type: "resume", suspendedMs: 1 }));
    await settle();
    expect(back.socket.ofType("missed")).toHaveLength(1);
    expect(h.tts.calls).toEqual(["Once only."]);
  });

  it("after the ten-minute window a new socket starts clean, with nothing to be told of", async () => {
    const h = createHarness();
    const first = h.connect();
    suspend(h, first);
    await h.reply("Too late for this one.");
    h.clock.advance(RESUME_WINDOW_MS + 1);
    const fresh = h.connect();
    expect(fresh.attachment).not.toBe(first.attachment);
    fresh.attachment.onText(h.json({ type: "resume", suspendedMs: RESUME_WINDOW_MS }));
    await settle();
    expect(fresh.socket.ofType("missed")).toHaveLength(0);
    expect(h.tts.calls).toEqual([]);
  });

  it("the window is kept for the same principal and session only", async () => {
    const h = createHarness();
    const first = h.connect();
    suspend(h, first);
    const other = h.connect({ principal: { kind: "member", userId: "x", userSessionId: "u" } });
    expect(other.attachment).toBeNull();
    const elsewhere = h.connect({ sessionId: "s2" });
    expect(elsewhere.attachment).not.toBe(first.attachment);
    expect(h.hub.get(SESSION)).toBe(first.attachment);
  });

  it("a deleted session ends a suspended attachment, and the window timer is gone with it", async () => {
    const h = createHarness();
    const first = h.connect();
    suspend(h, first);
    h.event("session:deleted");
    expect(h.hub.size()).toBe(0);
    expect(h.clock.pending()).toBe(0);
  });

  it("listening resumes with a fresh VAD, and a barge-in pending at suspension does not linger", async () => {
    const h = createHarness();
    const first = h.connect();
    h.event("session:started");
    h.delta("text", "Speaking now. ");
    await settle();
    first.attachment.onText(h.json({ type: "barge_in", segmentId: 1, playedMs: 5 }));
    suspend(h, first);
    expect(h.vads[0].closed).toBe(true);
    const back = h.connect();
    expect(h.vads).toHaveLength(2);
    h.clock.advance(5_000);
    await settle();
    // The stale stop did not resume speech of a reply nobody is there to hear.
    expect(back.socket.ofType("segment_start")).toHaveLength(0);
    await h.say(back.attachment, "I am back");
    expect(h.delivered.map((d) => d.text)).toEqual(["I am back"]);
    expect(OPERATOR.kind).toBe("operator");
  });
});

describe("long work moved to the background (FR-015, FR-016)", () => {
  it("background tasks the engine reports are announced once each, while attached", async () => {
    const tasks = [{ id: "t1", description: "pnpm test", command: "pnpm test" }];
    const h = createHarness({
      decorate: (engine) => {
        (engine as unknown as { backgroundTasks: unknown }).backgroundTasks = () => ({ tasks });
      },
    });
    const { socket } = h.connect();
    h.event("session:background", { transportState: "running", backgroundActivity: null });
    h.event("session:background", { transportState: "running", backgroundActivity: null });
    tasks.push({ id: "t2", description: "", command: "tail -f log" } as never);
    (tasks[1] as { description: string | null }).description = null;
    h.event("session:background", { transportState: "running", backgroundActivity: null });
    expect(socket.ofType("background")).toEqual([
      { type: "background", taskId: "t1", description: "pnpm test" },
      { type: "background", taskId: "t2", description: "tail -f log" },
    ]);
  });

  it("a task the soft interrupt moved is announced once, not again when the engine lists it", async () => {
    const h = createHarness({
      engine: { soft: { preserves: true } },
      decorate: (engine) => {
        (engine as unknown as { backgroundTasks: unknown }).backgroundTasks = () => ({
          tasks: [{ id: "bg-1", description: "sleep 90", command: "sleep 90" }],
        });
      },
    });
    h.state.turnRunning = true;
    h.engine.work = { tool: "Bash", startedAt: h.clock.now() - 9_000, description: "sleep 90" };
    h.engine.softOutcome = { ended: true, backgrounded: [{ taskId: "bg-1", description: "sleep 90" }] };
    const { socket, attachment } = h.connect();
    await h.say(attachment, "two plus two");
    h.event("session:background", { transportState: "running", backgroundActivity: null });
    expect(socket.ofType("background")).toHaveLength(1);
  });

  it("when the command finishes the session wakes itself and its reply about it is spoken (FR-016)", async () => {
    const h = createHarness({ engine: { soft: { preserves: true } } });
    h.state.turnRunning = true;
    h.engine.work = { tool: "Bash", startedAt: h.clock.now() - 9_000, description: "sleep 90" };
    h.engine.softOutcome = { ended: true, backgrounded: [{ taskId: "bg-1", description: "sleep 90" }] };
    const { socket, attachment } = h.connect();
    await h.say(attachment, "two plus two");
    h.event("session:completed", { result: "", error: null });
    h.state.turnRunning = false;
    h.event("session:started");
    h.delta("text", "Two plus two is four. ");
    h.event("session:completed", { result: "", error: null });
    h.event("session:started");
    h.delta("text", "The command finished with done-marker. ");
    h.event("session:completed", { result: "", error: null });
    await settle();
    expect(socket.ofType("segment_start").map((f) => f.text)).toEqual(["Two plus two is four.", "The command finished with done-marker."]);
    expect(h.engine.kills).toEqual([]);
  });
});
