import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Real rows, real SessionQueue, and the same accept/claim/dispatch steps the
// message route takes: what is under test is the order a busy session's lane
// runs its rows in when one sender queues several messages and a child session
// keeps reporting back in between, with the gateway restarting along the way.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-queue-send-order-"));
process.env.HUNDREDFOLD_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;
let SessionQueue: typeof import("../queue.js").SessionQueue;
let turns: typeof import("../incoming-turn.js");

beforeAll(async () => {
  reg = await import("../registry.js");
  ({ SessionQueue } = await import("../queue.js"));
  turns = await import("../incoming-turn.js");
  (await import("../../shared/db.js")).initDb();
});

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

/** A parent session B with a sender A and a child C, and the lane B's turns run in. */
function scenario(tag: string) {
  let queue = new SessionQueue();
  const make = (name: string) => reg.createSession({ engine: "claude", source: "web", sourceRef: `web:${name}-${tag}` });
  const [sender, target, child, grandchild] = [make("A"), make("B"), make("C"), make("D")];
  const lane = target.sessionKey || target.sourceRef!;
  /** What each turn saw, in the order the turns started. */
  const started: string[] = [];
  /** Rows that started while a row queued before them was still waiting. */
  const overtaken: string[] = [];
  const queuedAt = new Map<string, number>();
  let finishers: Array<() => void> = [];
  let replies = 0;
  let drains = 0;
  let childRow: string | undefined;

  const dispatch = (id: string) => {
    if (!queuedAt.has(id)) queuedAt.set(id, queuedAt.size);
    void queue.enqueue(lane, async () => {
      started.push(reg.getQueueItem(id)!.prompt);
      const earlier = reg.listAllPendingQueueItems()
        .filter((row) => row.sessionId === target.id && (queuedAt.get(row.id) ?? Infinity) < queuedAt.get(id)!);
      overtaken.push(...earlier.map((row) => `${reg.getQueueItem(id)!.prompt} before ${row.prompt}`));
      await new Promise<void>((resolve) => finishers.push(resolve));
    }, id);
  };

  return {
    started, overtaken, lane, get queue() { return queue; },
    /** The sender queues a message to the target, as a send_to_session call does. */
    send(text: string) {
      const claim = turns.claimIncomingTurn({
        sessionId: target.id, sessionKey: lane, prompt: text, isNotification: true, role: "notification",
        content: text, dedupeKey: turns.lateralSendDedupeKey(sender.id, target.id, text),
      });
      if (!claim.deduplicated) dispatch(claim.queueItemId!);
    },
    /** The child's completion is accepted into the target's lane, as the message route does. */
    reply() {
      const n = ++replies;
      const { delivery } = reg.claimSessionDelivery({
        targetSessionId: target.id, sourceKind: "session", sourceId: child.id, sourceAttempt: `attempt-${n}`,
        sourceOutcome: "completed", sourceVersion: 1, deliveryKind: "parent-completion",
        payload: { message: `reply-${n}`, displayMessage: `reply-${n}` },
      });
      const accepted = reg.acceptSessionDelivery(delivery.id, target.id, lane);
      if (!accepted.accepted) return;
      const id = accepted.delivery.queueItemId!;
      if (reg.shouldHoldParentCompletionQueueDispatch(id)) queue.holdForCallbackDrain(lane, id);
      else queue.releaseCallbackDrain(lane, id);
      for (const held of reg.listReleasableParentCompletionQueuesForSource(child.id)) queue.releaseCallbackDrain(held.sessionKey, held.queueItemId);
      if (!queue.hasInFlightItem(id)) dispatch(id);
    },
    /** The child has completion work of its own queued, so its next report to the target is held. */
    childBusy() {
      if (childRow) return;
      const { delivery } = reg.claimSessionDelivery({
        targetSessionId: child.id, sourceKind: "session", sourceId: grandchild.id, sourceAttempt: `drain-${++drains}`,
        sourceOutcome: "completed", sourceVersion: 1, deliveryKind: "parent-completion",
        payload: { message: "grandchild-reply", displayMessage: "grandchild-reply" },
      });
      childRow = reg.acceptSessionDelivery(delivery.id, child.id, child.sessionKey || child.sourceRef!).delivery.queueItemId ?? undefined;
    },
    childDone() {
      if (!childRow) return;
      reg.markQueueItemCompleted(childRow);
      childRow = undefined;
      for (const held of reg.listReleasableParentCompletionQueuesForSource(child.id)) queue.releaseCallbackDrain(held.sessionKey, held.queueItemId);
    },
    /** The gateway restarts: the running turn is cut off, and the lane is rebuilt from the durable rows. */
    restart() {
      finishers = [];
      queue = new SessionQueue();
      reg.recoverStaleQueueItems();
      for (const row of reg.listAllPendingQueueItems().filter((item) => item.sessionId === target.id)) dispatch(row.id);
    },
    async finishTurn() {
      finishers.shift()?.();
      await flush();
    },
    async finishAll() {
      this.childDone();
      for (let i = 0; i < 60; i++) await this.finishTurn();
    },
  };
}

describe("a busy session's lane keeps send order across child callbacks", () => {
  it("delivers one sender's queued messages in order while the child reports in between", async () => {
    const s = scenario("incident");
    s.send("current work");
    await flush();
    s.send("first");
    s.reply();
    s.send("second");
    s.reply();
    s.send("third");
    s.reply();
    await s.finishAll();

    // Each report queued behind the messages sent before it, and ahead of those sent after it.
    expect(s.started.filter((text) => /^(first|second|third)$/.test(text))).toEqual(["first", "second", "third"]);
    expect(s.started).toEqual([
      "current work", "first", "reply-1", "second", "reply-2", "third", "reply-3",
    ]);
    expect(s.overtaken).toEqual([]);
  });

  it("lets reports that queued in a row share a turn without passing a message sent between them", async () => {
    const s = scenario("batch");
    s.send("current work");
    await flush();
    s.reply();
    s.reply();
    s.send("between");
    s.reply();
    await s.finishAll();

    expect(s.started).toHaveLength(4);
    expect(s.started[1]).toMatch(/reply-1[\s\S]*reply-2/);
    expect(s.started.slice(2)).toEqual(["between", "reply-3"]);
    expect(s.overtaken).toEqual([]);
  });

  it("keeps the lane in order while the child's report is held, and runs everything once it is released", async () => {
    const s = scenario("held");
    s.send("current work");
    await flush();
    s.childBusy();
    s.reply();
    s.send("first");
    s.send("second");
    await s.finishTurn();
    expect(s.queue.isCallbackDrainHeld(s.lane)).toBe(true);
    expect(s.started).toEqual(["current work"]);

    await s.finishAll();
    expect(s.started).toEqual(["current work", "reply-1", "first", "second"]);
    expect(s.overtaken).toEqual([]);
  });

  it("runs the turn a restart cut off before the messages that queued behind it", async () => {
    const s = scenario("restart");
    // A lane that has carried a deep queue: its running row holds a high position.
    for (const text of ["one", "two", "three"]) s.send(text);
    await flush();
    await s.finishTurn();
    await s.finishTurn();
    expect(s.started).toEqual(["one", "two", "three"]);
    // While "three" runs the lane's waiting rows are numbered afresh.
    s.send("first");
    s.reply();
    s.send("second");

    s.restart();
    await flush();
    await s.finishAll();

    expect(s.started.slice(3)).toEqual(["three", "first", "reply-1", "second"]);
    expect(s.overtaken).toEqual([]);
  });

  it("holds a seeded mix of sends, reports, held reports and restarts to the same order", async () => {
    for (let seed = 1; seed <= 150; seed++) {
      let state = seed;
      const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
      const s = scenario(`fuzz-${seed}`);
      const sent = ["m0"];
      s.send("m0");
      await flush();
      for (let step = 0; step < 14; step++) {
        const roll = random();
        if (roll < 0.35) { sent.push(`m${sent.length}`); s.send(sent.at(-1)!); }
        else if (roll < 0.55) s.reply();
        else if (roll < 0.62) s.restart();
        else if (roll < 0.7) s.childBusy();
        else if (roll < 0.76) s.childDone();
        else await s.finishTurn();
        await flush();
      }
      await s.finishAll();
      const seen = [...new Set(s.started.flatMap((text) => text.split("\n\n")).filter((text) => /^m\d+$/.test(text)))];
      expect(seen, `seed ${seed}: ${s.started.join(" | ")}`).toEqual(sent);
      expect(s.overtaken, `seed ${seed}: ${s.started.join(" | ")}`).toEqual([]);
    }
  }, 60_000);
});

describe("recoverStaleQueueItems", () => {
  const positions = (lane: string) => Object.fromEntries(
    reg.listAllPendingQueueItems().filter((row) => row.sessionKey === lane).map((row) => [row.prompt, row.position]),
  );
  const run = (id: string) => reg.markQueueItemRunning(id);

  it("puts the rows a restart cut off ahead of their lane's waiting rows and numbers the lane densely", () => {
    // Turns the scenarios above left running belong to their own lanes; start from a settled database.
    reg.recoverStaleQueueItems();
    const owner = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:recover-owner" });
    const lane = "web:recover-lane";
    // The lane drained a deep queue: the row that is running was numbered 3.
    const [a, b, ran] = ["a", "b", "ran"].map((prompt) => reg.enqueueQueueItem(owner.id, lane, prompt));
    for (const id of [a, b]) { run(id); reg.markQueueItemCompleted(id); }
    run(ran);
    // What queued while it ran was numbered from the rows still waiting.
    reg.enqueueQueueItem(owner.id, lane, "later-1");
    reg.enqueueQueueItem(owner.id, lane, "later-2");
    reg.enqueueQueueItem(owner.id, "web:recover-other-lane", "elsewhere");
    expect(positions(lane)).toEqual({ "later-1": 1, "later-2": 2 });

    expect(reg.recoverStaleQueueItems()).toBe(1);
    expect(positions(lane)).toEqual({ ran: 1, "later-1": 2, "later-2": 3 });
    expect(positions("web:recover-other-lane")).toEqual({ elsewhere: 1 });
    expect(reg.recoverStaleQueueItems()).toBe(0);
  });

  it("leaves a workflow session's running row alone", async () => {
    const workflow = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:recover-workflow" });
    (await import("../../shared/db.js")).initDb().prepare("UPDATE sessions SET workflow_kind = 'board-walk' WHERE id = ?").run(workflow.id);
    const id = reg.enqueueQueueItem(workflow.id, "web:recover-workflow", "phase");
    run(id);
    reg.recoverStaleQueueItems();
    expect(reg.getQueueItem(id)?.status).toBe("running");
  });
});
