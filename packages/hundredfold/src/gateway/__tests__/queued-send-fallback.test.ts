import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptWithoutExecuting, api, createParent, dbModule, eventually, makeContext, queueModule, registry, resetCallbackState, type ApiContext,
} from "./helpers/callback-harness.js";
import { judgeTargetTurn, stalledSendPayload, sweepLateralSends } from "../lateral-send-watch.js";
import { clearSessionStopped, markSessionStopped } from "../../sessions/stopped-marker.js";
import { stopSession } from "../session-stop.js";
import { resumePendingQueueItem } from "../callback-queue-recovery.js";
import { LATERAL_STALL_DELIVERY_KIND } from "../../sessions/lateral-notice-staleness.js";
import { getQueueItem } from "../../sessions/queue-item-registry.js";
import { makeResponse, withRouteBackedFetch } from "./helpers/callback-requests.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability,
} from "../../mcp/identity.js";
import type { Engine, EngineRunOpts, Session, TurnProgress } from "../../shared/types.js";

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-profile-signin.js")>()),
  verifyLocalClaudeProfile: () => undefined,
}));
vi.mock("../../sessions/claude-auth-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/claude-auth-watch.js")>()),
  refuseClaudeLaunch: () => undefined,
  observeClaudeTurnOutcome: () => {},
}));

const DIR_A = path.join(os.tmpdir(), "queued-send-claude-a");
const DIR_B = path.join(os.tmpdir(), "queued-send-claude-b");
vi.mock("../org-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../org-registry.js")>()),
  orgRegistry: () => new Map([["worker-a", { name: "worker-a", displayName: "Worker A", department: "x", rank: "employee", persona: "Worker.", engine: "claude", claudeConfigDir: DIR_A, fallback: [{ engine: "claude", profile: "B", model: "sonnet" }] }]]),
}));
beforeEach(resetCallbackState);

async function post(context: ApiContext, sessionId: string, body: unknown, headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: `/api/sessions/${sessionId}/message`,
    headers: { host: "gateway.test", authorization: "Bearer test-token", "content-type": "application/json", ...headers },
  });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  return captured;
}

function toolHeaders(callerSessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: callerSessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(callerSessionId),
  };
}


/**
 * An agent's `send_to_session` message, accepted for a session that moves to
 * another Claude account on a usage limit, runs once, in order, on the account
 * it landed on, and a replacement sent meanwhile is the only one delivered. The
 * real route, queue, registry and rate-limit walk; only the engine is a stub.
 */
function setup(opts: { limit?: boolean; source?: string; progress?: () => TurnProgress | undefined } = {}) {
  const limit = opts.limit !== false;
  const calls: Array<{ text: string; account: string }> = [];
  const gates: Array<() => void> = [];
  const held = new Map<string, () => void>();
  const progressOf: { targetId?: string } = {};
  const engine: Engine & { turnProgress?: (sessionId: string) => TurnProgress | undefined } = {
    name: "claude",
    run: async (opts: EngineRunOpts) => {
      const account = opts.claudeProfile?.dir?.endsWith("claude-a") ? "A" : opts.claudeProfile?.dir?.endsWith("claude-b") ? "B" : "?";
      calls.push({ text: opts.prompt, account });
      // A turn the test holds open until it releases it by name: a sender busy in a turn of its own.
      if (opts.prompt.startsWith("hold:")) {
        await new Promise<void>((resolve) => held.set(opts.prompt, resolve));
        return { sessionId: `thread-${calls.length}`, result: "ok" };
      }
      if (limit && calls.length === 1) {
        // The first turn holds the lane, then the account is out of allowance.
        await new Promise<void>((resolve) => gates.push(resolve));
        return { sessionId: "", result: "", error: "429", rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } } as never;
      }
      return { sessionId: `thread-${calls.length}`, result: "ok" };
    },
    // An engine that reports how its turn is going, when the test gives it a reading.
    ...(opts.progress ? { turnProgress: (sessionId: string) => (sessionId === progressOf.targetId ? opts.progress!() : undefined) } : {}),
  };
  const queue = new queueModule.SessionQueue();
  const base = makeContext(engine, queue);
  const config = { gateway: {}, sessions: {}, mcp: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus", accounts: { A: { configDir: DIR_A }, B: { configDir: DIR_B } } } } };
  const context = { ...base, config, getConfig: () => config, sessionManager: { getEngine: () => engine, getEngines: () => new Map([["claude", engine]]), getQueue: () => queue } } as unknown as ApiContext;
  const target = registry.createSession({ engine: "claude", model: "opus", employee: "worker-a", source: opts.source ?? "web", sourceRef: "web:fb-target", sessionKey: "web:fb-target", connector: opts.source ?? "web", prompt: "x" });
  progressOf.targetId = target.id;
  const caller = createParent("fb-caller");
  return { calls, gates, held, queue, context, target, caller };
}

// A message is delivered when it runs as its own turn. A prompt rebuilt for the account the session moved to may also carry it as
// conversation context, which is not a delivery.
const delivered = (calls: Array<{ text: string }>, word: string) => calls.filter((call) => call.text.startsWith("📨 Message from session") && call.text.includes(word));
const statuses = (id: string) => (dbModule.initDb().prepare("SELECT status FROM queue_items WHERE session_id = ? ORDER BY position ASC").all(id) as Array<{ status: string }>).map((row) => row.status);

describe("a queued send across an account move", () => {
  it("delivers a message queued before the move, once, on the account the session moved to", async () => {
    const { calls, gates, queue, context, target, caller } = setup();
    await post(context, target.id, { message: "start" });
    await eventually(() => expect(gates).toHaveLength(1));
    await post(context, target.id, { message: "plan A" }, toolHeaders(caller.id));
    gates[0]();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(delivered(calls, "plan A")).toHaveLength(1);
    });
    expect(calls.map((call) => call.account)).toEqual(["A", "B", "B"]);
    expect(statuses(target.id)).toEqual(["completed", "completed"]);
  }, 20000);

  it("leaves exactly one message, the new one, when a superseding send crosses the move", async () => {
    const { calls, gates, queue, context, target, caller } = setup();
    await post(context, target.id, { message: "start" });
    await eventually(() => expect(gates).toHaveLength(1));
    const first = await post(context, target.id, { message: "plan A" }, toolHeaders(caller.id));
    const second = await post(context, target.id, { message: "plan B", supersedes: first.body.queueItemId }, toolHeaders(caller.id));
    expect(second.body.superseded).toBe("withdrawn");
    gates[0]();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(delivered(calls, "plan B")).toHaveLength(1);
    });
    expect(delivered(calls, "plan A")).toHaveLength(0);
    expect(statuses(target.id)).toEqual(["completed", "cancelled", "completed"]);
  }, 20000);
});

describe("an accepted message that has not run", () => {
  it("is dispatched again when nothing owns it, and delivered", async () => {
    const { calls, queue, context, target, caller } = setup({ limit: false });
    // The process that accepted it lost the dispatch: the row is durable, the slot is not.
    const lost = { ...context, sessionManager: { ...context.sessionManager, getQueue: () => acceptWithoutExecuting() } } as unknown as ApiContext;
    const sent = await post(lost, target.id, { message: "plan A" }, toolHeaders(caller.id));
    expect(sent.body.status).toBe("queued");
    expect(calls).toHaveLength(0);

    expect(sweepLateralSends(context, { afterMs: 10_000 })).toEqual({ rearmed: [], reported: [] });
    const swept = sweepLateralSends(context, { afterMs: 0, now: Date.now() + 1000 });
    expect(swept).toEqual({ rearmed: [sent.body.queueItemId], reported: [] });
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(delivered(calls, "plan A")).toHaveLength(1);
    });
    expect(sweepLateralSends(context, { afterMs: 0, now: Date.now() + 1000 })).toEqual({ rearmed: [], reported: [] });
  }, 20000);

  /** Hold the target in a turn and queue three messages to it from the caller, the first sent `spreadMinutes` before the last. */
  async function queueThreeBehindATurn(opts: { progress?: () => TurnProgress | undefined } = {}) {
    const fixture = setup({ progress: opts.progress });
    const { gates, context, target, caller } = fixture;
    await post(context, target.id, { message: "start" });
    await eventually(() => expect(gates).toHaveLength(1));
    const ids: string[] = [];
    for (const word of ["plan A", "plan B", "plan C"]) {
      const sent = await post(context, target.id, { message: word }, toolHeaders(caller.id));
      expect(sent.body.status).toBe("queued");
      ids.push(sent.body.queueItemId as string);
    }
    // Sent a minute apart.
    const base = Date.now();
    ids.forEach((id, index) => dbModule.initDb().prepare("UPDATE queue_items SET created_at = ? WHERE id = ?").run(new Date(base + (index - 2) * 60_000).toISOString(), id));
    return { ...fixture, ids, base };
  }
  const undeliveredTurns = (calls: Array<{ text: string }>) => calls.filter((call) => call.text.includes("not been delivered after"));
  const notices = (sessionId: string) => registry.getMessages(sessionId).filter((message) => message.role === "notification");

  it("tells the sender nothing while the target's turn keeps making progress, however long it runs", async () => {
    let clock = Date.now();
    const { calls, gates, queue, context, target, caller, base } = await queueThreeBehindATurn({
      progress: () => ({ lastProgressAt: clock - 30_000, awaitingSubmit: false, activeTools: 0, activeUpstream: false }),
    });
    await withRouteBackedFetch(context, {}, async () => {
      for (const minutes of [6, 11, 16, 30, 45]) {
        clock = base + minutes * 60_000;
        expect(sweepLateralSends(context, { now: clock })).toEqual({ rearmed: [], reported: [] });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(notices(caller.id)).toHaveLength(0);
      expect(undeliveredTurns(calls)).toHaveLength(0);
    });
    gates[0]();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(delivered(calls, "plan C")).toHaveLength(1);
    });
  }, 20000);

  it("tells the sender once, naming every waiting message, when the target's turn goes silent", async () => {
    // No progress report from the engine: the turn's own output clock (its start, here) is the evidence.
    const { calls, gates, queue, context, target, caller, ids, base } = await queueThreeBehindATurn();
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: base + 6 * 60_000 })).toEqual({ rearmed: [], reported: [] });
      expect(sweepLateralSends(context, { now: base + 16 * 60_000 })).toEqual({ rearmed: [], reported: ids });
      expect(sweepLateralSends(context, { now: base + 17 * 60_000 })).toEqual({ rearmed: [], reported: [] });
      expect(sweepLateralSends(context, { now: base + 40 * 60_000 })).toEqual({ rearmed: [], reported: [] });
      await eventually(() => expect(undeliveredTurns(calls)).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(undeliveredTurns(calls)).toHaveLength(1);
      expect(notices(caller.id)).toHaveLength(1);
    });
    const notice = undeliveredTurns(calls)[0].text;
    for (const id of ids) expect(notice).toContain(id);
    expect(notice).toContain("no progress for 16 minutes");
    expect(notice).toContain("still queued");
    gates[0]();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(delivered(calls, "plan C")).toHaveLength(1);
    });
  }, 20000);

  it("tells the sender again only when the target's state changes", async () => {
    const { calls, gates, queue, context, target, caller, ids, base } = await queueThreeBehindATurn();
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: base + 16 * 60_000 }).reported).toEqual(ids);
      await eventually(() => expect(notices(caller.id)).toHaveLength(1));
      // A fourth message behind the same silent turn is no news.
      const fourth = await post(context, target.id, { message: "plan D" }, toolHeaders(caller.id));
      dbModule.initDb().prepare("UPDATE queue_items SET created_at = ? WHERE id = ?").run(new Date(base).toISOString(), fourth.body.queueItemId);
      expect(sweepLateralSends(context, { now: base + 20 * 60_000 }).reported).toEqual([]);
      // The turn now waits out a usage limit: that is news.
      registry.updateSession(target.id, { status: "waiting" });
      expect(sweepLateralSends(context, { now: base + 21 * 60_000 }).reported).toEqual([...ids, fourth.body.queueItemId]);
      expect(sweepLateralSends(context, { now: base + 22 * 60_000 }).reported).toEqual([]);
      await eventually(() => expect(notices(caller.id)).toHaveLength(2));
      // And then errors out of the wait: same kind of trouble, new state.
      registry.updateSession(target.id, { status: "error", lastError: "usage limit wait gave up" });
      expect(sweepLateralSends(context, { now: base + 23 * 60_000 }).reported).toHaveLength(4);
      expect(sweepLateralSends(context, { now: base + 24 * 60_000 }).reported).toEqual([]);
      await eventually(() => expect(notices(caller.id)).toHaveLength(3));
    });
    expect(undeliveredTurns(calls)[1].text).toContain("status waiting");
    expect(undeliveredTurns(calls)[2].text).toContain("usage limit wait gave up");
    registry.updateSession(target.id, { status: "running", lastError: null });
    gates[0]();
    await eventually(() => expect(queue.isRunning(target.sessionKey)).toBe(false));
  }, 20000);

  /** Put the caller in a turn of its own, so a notice to it waits behind that turn. */
  async function holdCaller(fixture: { held: Map<string, () => void>; context: ApiContext; caller: { id: string } }) {
    await post(fixture.context, fixture.caller.id, { message: "hold: own work" });
    await eventually(() => expect(fixture.held.has("hold: own work")).toBe(true));
    return () => fixture.held.get("hold: own work")!();
  }

  /** The fixture's context, with every emitted event recorded; and the message ids the views were told to drop. */
  function recordEvents(base: ApiContext) {
    const events: Array<{ event: string; data: unknown }> = [];
    const context = { ...base, emit: (event: string, data: unknown) => events.push({ event, data }) } as unknown as ApiContext;
    const told = () => events.flatMap((entry) => (entry.data as { withdrawnMessageIds?: string[] }).withdrawnMessageIds ?? []);
    return { context, told };
  }

  it("drops a notice whose messages were all delivered while it waited behind the sender's own turn", async () => {
    const fixture = await queueThreeBehindATurn();
    const { calls, gates, queue, context, target, caller, ids, base } = fixture;
    const releaseCaller = await holdCaller(fixture);
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: base + 16 * 60_000 }).reported).toEqual(ids);
      await eventually(() => expect(notices(caller.id)).toHaveLength(1));
      // The target gets going after all, and every message runs before the sender reads the notice.
      gates[0]();
      await eventually(() => {
        expect(queue.isRunning(target.sessionKey)).toBe(false);
        expect(delivered(calls, "plan C")).toHaveLength(1);
      });
      releaseCaller();
      await eventually(() => expect(queue.isRunning(caller.sessionKey!)).toBe(false));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(undeliveredTurns(calls)).toHaveLength(0);
  }, 20000);

  it("drops a notice whose message its sender withdrew while it waited, and still reports the replacement stuck behind the same turn", async () => {
    const fixture = setup({ limit: false });
    const recorded = recordEvents(fixture.context);
    const context = recorded.context;
    const { calls, held, queue, target, caller } = fixture;
    await post(context, target.id, { message: "hold: target's long turn" });
    await eventually(() => expect(held.has("hold: target's long turn")).toBe(true));
    const sent = await post(context, target.id, { message: "plan A" }, toolHeaders(caller.id));
    const releaseCaller = await holdCaller(fixture);
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: Date.now() + 16 * 60_000 }).reported).toEqual([sent.body.queueItemId]);
      await eventually(() => expect(notices(caller.id)).toHaveLength(1));
      const replaced = await post(context, target.id, { message: "plan B", supersedes: sent.body.queueItemId }, toolHeaders(caller.id));
      expect(replaced.body.superseded).toBe("withdrawn");
      releaseCaller();
      await eventually(() => expect(queue.isRunning(caller.sessionKey!)).toBe(false));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(undeliveredTurns(calls)).toHaveLength(0);
      // The dropped notice never ran, so it is not left in the transcript to read as given, and every view is told.
      expect(notices(caller.id)).toHaveLength(0);
      expect(recorded.told()).toHaveLength(1);
      // The target is as silent as it was. The replacement is stuck behind the very state the dropped notice
      // reported, and its sender must still hear about it: the dropped notice's claim does not hold that state.
      expect(sweepLateralSends(context, { now: Date.now() + 30 * 60_000 }).reported).toEqual([replaced.body.queueItemId]);
      expect(sweepLateralSends(context, { now: Date.now() + 60 * 60_000 }).reported).toEqual([]);
      await eventually(() => expect(undeliveredTurns(calls)).toHaveLength(1));
      expect(undeliveredTurns(calls)[0].text).toContain(replaced.body.queueItemId);
      expect(undeliveredTurns(calls)[0].text).not.toContain(sent.body.queueItemId);
      // One banner, the delivered one.
      expect(notices(caller.id)).toHaveLength(1);
    });
    held.get("hold: target's long turn")!();
    await eventually(() => expect(delivered(calls, "plan B")).toHaveLength(1));
  }, 20000);

  it("drops a stale notice found on restart, and still reports the replacement stuck behind the same turn", async () => {
    const fixture = setup({ limit: false });
    const recorded = recordEvents(fixture.context);
    const context = recorded.context;
    const { calls, held, target, caller } = fixture;
    await post(context, target.id, { message: "hold: target's long turn" });
    await eventually(() => expect(held.has("hold: target's long turn")).toBe(true));
    const sent = await post(context, target.id, { message: "plan A" }, toolHeaders(caller.id));
    const releaseCaller = await holdCaller(fixture);
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: Date.now() + 16 * 60_000 }).reported).toEqual([sent.body.queueItemId]);
      await eventually(() => expect(notices(caller.id)).toHaveLength(1));
      const replaced = await post(context, target.id, { message: "plan B", supersedes: sent.body.queueItemId }, toolHeaders(caller.id));
      expect(replaced.body.superseded).toBe("withdrawn");
      // The gateway restarts with the notice still pending: a fresh queue owns nothing, so replay judges it.
      const noticeRow = dbModule.initDb().prepare("SELECT queue_item_id FROM callback_deliveries WHERE delivery_kind = ?").pluck().get(LATERAL_STALL_DELIVERY_KIND) as string;
      const restarted = { ...context, sessionManager: { ...context.sessionManager, getQueue: () => new queueModule.SessionQueue() } } as unknown as ApiContext;
      expect(resumePendingQueueItem(getQueueItem(noticeRow)!, restarted)).toBe(false);
      expect(getQueueItem(noticeRow)?.status).toBe("cancelled");
      expect(notices(caller.id)).toHaveLength(0);
      expect(recorded.told()).toHaveLength(1);
      // Its claim went with it: the replacement behind the same silent turn is reported.
      expect(sweepLateralSends(context, { now: Date.now() + 30 * 60_000 }).reported).toEqual([replaced.body.queueItemId]);
      releaseCaller();
      await eventually(() => expect(undeliveredTurns(calls)).toHaveLength(1));
      expect(undeliveredTurns(calls)[0].text).toContain(replaced.body.queueItemId);
      expect(undeliveredTurns(calls)[0].text).not.toContain(sent.body.queueItemId);
    });
    held.get("hold: target's long turn")!();
    await eventually(() => expect(delivered(calls, "plan B")).toHaveLength(1));
  }, 20000);

  /**
   * The target is held in a silent turn, the caller queues A, a sweep reports it (the notice waits behind the
   * caller's own turn), and then `close` closes the notice without it running. The caller sends B in place of A
   * behind the very same silent turn, and a sweep 30 minutes on must report B.
   */
  async function reportCloseThenResend(close: (f: ReturnType<typeof setup> & { sentId: string; noticeRow: string; events: Array<{ event: string; data: unknown }> }) => Promise<void> | void) {
    const events: Array<{ event: string; data: unknown }> = [];
    const fixture = setup({ limit: false });
    const context = { ...fixture.context, emit: (event: string, data: unknown) => events.push({ event, data }) } as unknown as ApiContext;
    const { held, target, caller } = fixture;
    await post(context, target.id, { message: "hold: target's long turn" });
    await eventually(() => expect(held.has("hold: target's long turn")).toBe(true));
    const sent = await post(context, target.id, { message: "plan A" }, toolHeaders(caller.id));
    await holdCaller({ ...fixture, context });
    const noticeRowOf = () => dbModule.initDb().prepare("SELECT queue_item_id FROM callback_deliveries WHERE delivery_kind = ? ORDER BY created_at DESC, rowid DESC").pluck().get(LATERAL_STALL_DELIVERY_KIND) as string;
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: Date.now() + 16 * 60_000 }).reported).toEqual([sent.body.queueItemId]);
      await eventually(() => expect(notices(caller.id)).toHaveLength(1));
      await close({ ...fixture, context, sentId: sent.body.queueItemId as string, noticeRow: noticeRowOf(), events });
      // The caller is running again, and sends B in place of A, behind the same silent turn.
      clearSessionStopped(caller.id);
      const replaced = await post(context, target.id, { message: "plan B", supersedes: sent.body.queueItemId }, toolHeaders(caller.id));
      expect(replaced.body.superseded).toBe("withdrawn");
      expect(sweepLateralSends(context, { now: Date.now() + 30 * 60_000 }).reported).toEqual([replaced.body.queueItemId]);
      // And only once.
      expect(sweepLateralSends(context, { now: Date.now() + 31 * 60_000 }).reported).toEqual([]);
      const claimed = dbModule.initDb().prepare("SELECT payload FROM callback_deliveries WHERE delivery_kind = ? ORDER BY created_at DESC, rowid DESC").pluck().get(LATERAL_STALL_DELIVERY_KIND) as string;
      expect(claimed).toContain(replaced.body.queueItemId);
      expect(claimed).not.toContain(sent.body.queueItemId);
      // A closed notice is retired once: the sweeps that followed did not append to its key again.
      const keys = dbModule.initDb().prepare("SELECT source_attempt FROM callback_deliveries WHERE delivery_kind = ?").pluck().all(LATERAL_STALL_DELIVERY_KIND) as string[];
      expect(keys.filter((key) => key.includes(":retired:"))).toHaveLength(1);
      expect(keys.every((key) => key.split(":retired:").length <= 2)).toBe(true);
    });
    held.get("hold: target's long turn")!();
    held.get("hold: own work")?.();
    return { events, caller };
  }

  it("reports a later message behind the same state once the sender was stopped and its notice withdrawn", async () => {
    const { events, caller } = await reportCloseThenResend(({ context, caller, noticeRow }) => {
      stopSession(context, registry.getSession(caller.id)!, "running");
      expect(getQueueItem(noticeRow)?.status).toBe("cancelled");
    });
    // The notice never ran, so its bubble is gone from the transcript and every view was told.
    const gone = events.flatMap((entry) => (entry.data as { withdrawnMessageIds?: string[] }).withdrawnMessageIds ?? []);
    expect(gone).toHaveLength(1);
    expect(notices(caller.id).map((message) => message.id)).not.toContain(gone[0]);
  }, 20000);

  it("reports a later message behind the same state once the notice's row could not be replayed on restart", async () => {
    const { events } = await reportCloseThenResend(({ context, caller, noticeRow }) => {
      // Stopped while the row was parked, and the gateway restarted before the stop reached it.
      markSessionStopped(caller.id);
      const restarted = { ...context, sessionManager: { ...context.sessionManager, getQueue: () => new queueModule.SessionQueue() } } as unknown as ApiContext;
      expect(resumePendingQueueItem(getQueueItem(noticeRow)!, restarted)).toBe(false);
      expect(getQueueItem(noticeRow)?.status).toBe("cancelled");
      expect(notices(caller.id)).toHaveLength(0);
    });
    // Every view was told the bubble is gone.
    expect(events.flatMap((entry) => (entry.data as { withdrawnMessageIds?: string[] }).withdrawnMessageIds ?? [])).toHaveLength(1);
  }, 20000);

  /** The target held in a silent turn, A queued to it, and a sweep that claims a notice no gateway takes: it stays pending. */
  async function claimUndeliveredNotice() {
    const fixture = setup({ limit: false });
    const { context, held, target, caller } = fixture;
    await post(context, target.id, { message: "hold: target's long turn" });
    await eventually(() => expect(held.has("hold: target's long turn")).toBe(true));
    const sent = await post(context, target.id, { message: "plan A" }, toolHeaders(caller.id));
    const now = Date.now();
    expect(sweepLateralSends(context, { now: now + 16 * 60_000 }).reported).toEqual([sent.body.queueItemId]);
    const deliveryId = dbModule.initDb().prepare("SELECT id FROM callback_deliveries WHERE delivery_kind = ?").pluck().get(LATERAL_STALL_DELIVERY_KIND) as string;
    return { ...fixture, sent, now, deliveryId };
  }

  it("reports a later message behind the same state once the notice was dead-lettered by a stopped sender", async () => {
    const { context, held, target, caller, sent, now, deliveryId } = await claimUndeliveredNotice();
    markSessionStopped(caller.id);
    const refused = await post(context, caller.id, { callbackDeliveryId: deliveryId });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(registry.getSessionDelivery(deliveryId)?.status).toBe("dead_letter");
    clearSessionStopped(caller.id);
    const replaced = await post(context, target.id, { message: "plan B", supersedes: sent.body.queueItemId }, toolHeaders(caller.id));
    expect(replaced.body.superseded).toBe("withdrawn");
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: now + 30 * 60_000 }).reported).toEqual([replaced.body.queueItemId]);
      expect(sweepLateralSends(context, { now: now + 31 * 60_000 }).reported).toEqual([]);
    });
    held.get("hold: target's long turn")!();
  }, 20000);

  it("reports a later message behind the same state once the notice exhausted its delivery attempts", async () => {
    const { context, held, target, caller, sent, now, deliveryId } = await claimUndeliveredNotice();
    const failed = registry.recordSessionDeliveryFailure(deliveryId, "sender unreachable", { now: Date.now(), nextAttemptAt: Date.now() + 1000, maxAttempts: 0 });
    expect(failed?.status).toBe("dead_letter");
    const replaced = await post(context, target.id, { message: "plan B", supersedes: sent.body.queueItemId }, toolHeaders(caller.id));
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: now + 30 * 60_000 }).reported).toEqual([replaced.body.queueItemId]);
    });
    held.get("hold: target's long turn")!();
  }, 20000);

  it("does not hand a sender that keeps refusing its notices a new one on every sweep", async () => {
    const { held, context, target, caller, sent, now, deliveryId } = await claimUndeliveredNotice();
    // The notice runs out of delivery attempts, and the sender is not stopped: nothing about the state has changed.
    expect(registry.recordSessionDeliveryFailure(deliveryId, "sender unreachable", { now: Date.now(), nextAttemptAt: Date.now() + 1000, maxAttempts: 0 })?.status).toBe("dead_letter");
    const notices = () => dbModule.initDb().prepare("SELECT COUNT(*) FROM callback_deliveries WHERE delivery_kind = ?").pluck().get(LATERAL_STALL_DELIVERY_KIND);
    await withRouteBackedFetch(context, {}, async () => {
      // A sweep every 16 minutes for four hours: one notice, not one per sweep.
      for (let minutes = 32; minutes <= 240; minutes += 16) expect(sweepLateralSends(context, { now: now + minutes * 60_000 }).reported).toEqual([]);
      expect(notices()).toBe(1);
      // A message it was never told about is news, and is reported once.
      const later = await post(context, target.id, { message: "plan C" }, toolHeaders(caller.id));
      expect(sweepLateralSends(context, { now: now + 250 * 60_000 }).reported).toEqual([sent.body.queueItemId, later.body.queueItemId]);
      expect(sweepLateralSends(context, { now: now + 266 * 60_000 }).reported).toEqual([]);
    });
    held.get("hold: target's long turn")!();
  }, 20000);

  it("tells a sender stopped on purpose nothing about its messages", async () => {
    const { held, context, caller, now, deliveryId } = await claimUndeliveredNotice();
    markSessionStopped(caller.id);
    await post(context, caller.id, { callbackDeliveryId: deliveryId });
    expect(registry.getSessionDelivery(deliveryId)?.status).toBe("dead_letter");
    for (const minutes of [20, 30, 40, 50]) expect(sweepLateralSends(context, { now: now + minutes * 60_000 }).reported).toEqual([]);
    expect(dbModule.initDb().prepare("SELECT COUNT(*) FROM callback_deliveries WHERE delivery_kind = ?").pluck().get(LATERAL_STALL_DELIVERY_KIND)).toBe(1);
    held.get("hold: target's long turn")!();
  }, 20000);

  it("claims no notice for a sender stopped on purpose before the first sweep", async () => {
    const fixture = setup({ limit: false });
    const { context, held, target, caller } = fixture;
    await post(context, target.id, { message: "hold: target's long turn" });
    await eventually(() => expect(held.has("hold: target's long turn")).toBe(true));
    await post(context, target.id, { message: "plan A" }, toolHeaders(caller.id));
    markSessionStopped(caller.id);
    const now = Date.now();
    for (const minutes of [16, 30, 60]) expect(sweepLateralSends(context, { now: now + minutes * 60_000 }).reported).toEqual([]);
    expect(dbModule.initDb().prepare("SELECT COUNT(*) FROM callback_deliveries WHERE delivery_kind = ?").pluck().get(LATERAL_STALL_DELIVERY_KIND)).toBe(0);
    held.get("hold: target's long turn")!();
  }, 20000);

  it("tells the sender again when a later turn of the target goes silent", async () => {
    const { gates, queue, context, target, caller, ids, base } = await queueThreeBehindATurn();
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: base + 16 * 60_000 }).reported).toEqual(ids);
      expect(sweepLateralSends(context, { now: base + 17 * 60_000 }).reported).toEqual([]);
      // Another attempt of the same session, silent in its turn: a new state.
      dbModule.initDb().prepare("UPDATE sessions SET attempt_token = ? WHERE id = ?").run("a-later-attempt", target.id);
      expect(sweepLateralSends(context, { now: base + 18 * 60_000 }).reported).toEqual(ids);
      await eventually(() => expect(notices(caller.id)).toHaveLength(2));
    });
    gates[0]();
    await eventually(() => expect(queue.isRunning(target.sessionKey)).toBe(false));
  }, 20000);

  it("says the target is still making progress when a message it cannot run forces a notice", () => {
    const payload = stalledSendPayload({
      targetSessionId: "target-session", waitedMinutes: 7, targetStatus: "running",
      turn: { kind: "working" }, sends: { queued: [], unowned: ["row-1"], dropped: [] },
    });
    expect(payload.message).toContain("still making progress (status running)");
    expect(payload.message).not.toContain("no turn running");
    expect(payload.meta).toMatchObject({ queueItemIds: ["row-1"], waitingQueueItemIds: ["row-1"], state: "unowned" });
  });

  it("shows a message still waiting behind a turn as queued in the session read, and not once it is delivered", async () => {
    const { calls, gates, queue, context, target, ids } = await queueThreeBehindATurn();
    const read = async () => {
      const captured = makeResponse();
      const req = Object.assign(Readable.from([]), {
        method: "GET", url: `/api/sessions/${target.id}?last=20&thinking=0`, headers: { host: "gateway.test", authorization: "Bearer test-token" },
      });
      await api.handleApiRequest(req as never, captured.res, context);
      return captured.body.messages as Array<{ role: string; content: string; queued?: boolean }>;
    };
    const before = await read();
    const queuedRows = before.filter((message) => message.queued);
    expect(queuedRows).toHaveLength(ids.length);
    expect(queuedRows.every((message) => message.role === "notification")).toBe(true);
    expect(before.find((message) => message.content.includes("start"))?.queued).toBeUndefined();
    gates[0]();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(delivered(calls, "plan C")).toHaveLength(1);
    });
    expect((await read()).filter((message) => message.queued)).toHaveLength(0);
  }, 20000);

  it("gives a turn with a tool or model request in flight the longer window before calling it silent", () => {
    const now = Date.now();
    const target = { id: "t", engine: "claude", status: "running", sessionKey: "k" } as Session;
    const reading = (activeTools: number): TurnProgress => ({ lastProgressAt: now - 30 * 60_000, awaitingSubmit: false, activeTools, activeUpstream: false });
    const contextWith = (progress: TurnProgress) => ({
      sessionManager: { getQueue: () => ({ isRunning: () => true }), getEngine: () => ({ name: "claude", run: async () => ({}), turnProgress: () => progress }) },
    }) as unknown as ApiContext;
    expect(judgeTargetTurn(target, "k", contextWith(reading(1)), now, now - 40 * 60_000)).toEqual({ kind: "working" });
    expect(judgeTargetTurn(target, "k", contextWith(reading(0)), now, now - 40 * 60_000)).toEqual({ kind: "silent", silentMinutes: 30 });
    expect(judgeTargetTurn(target, "k", contextWith({ ...reading(1), lastProgressAt: now - 61 * 60_000 }), now, now)).toEqual({ kind: "silent", silentMinutes: 61 });
    expect(judgeTargetTurn({ ...target, status: "waiting" }, "k", contextWith(reading(1)), now, now)).toEqual({ kind: "other", laneRunning: true });
    // Waiting behind a turn typed in the terminal gets the long window, timed from when the wait began, not forever.
    const terminalWait = (sinceMinutes: number): TurnProgress => ({ ...reading(0), lastProgressAt: now - sinceMinutes * 60_000, waitingForTerminalTurn: true });
    expect(judgeTargetTurn(target, "k", contextWith(terminalWait(30)), now, now)).toEqual({ kind: "working" });
    expect(judgeTargetTurn(target, "k", contextWith(terminalWait(61)), now, now)).toEqual({ kind: "silent", silentMinutes: 61 });
  });
  /** Lose the dispatch of one agent message to `target`, then sweep long after it was sent. */
  async function sweepLost(opts: { stop?: boolean; noEngine?: boolean; source?: string }) {
    const { calls, context, target, caller } = setup({ limit: false, source: opts.source });
    const lost = { ...context, sessionManager: { ...context.sessionManager, getQueue: () => acceptWithoutExecuting() } } as unknown as ApiContext;
    const sent = await post(lost, target.id, { message: "plan A" }, toolHeaders(caller.id));
    expect(sent.body.status).toBe("queued");
    if (opts.stop) markSessionStopped(target.id);
    const sweepContext = opts.noEngine ? { ...context, sessionManager: { ...context.sessionManager, getEngine: () => undefined } } as unknown as ApiContext : context;
    let result: ReturnType<typeof sweepLateralSends> | undefined;
    await withRouteBackedFetch(context, {}, async () => {
      result = sweepLateralSends(sweepContext, { now: Date.now() + 6 * 60_000 });
      // The sender is woken with the full notice; its engine sees the whole text.
      await eventually(() => expect(calls.filter((call) => call.text.includes("has not been delivered after"))).toHaveLength(1));
    });
    const notice = calls.find((call) => call.text.includes("has not been delivered after"))!.text;
    return { calls, result: result!, notice, id: sent.body.queueItemId as string, target };
  }

  it("tells the sender a message was dropped, not that it is still queued, when the target was stopped", async () => {
    const { calls, result, notice, id, target } = await sweepLost({ stop: true });
    expect(result).toEqual({ rearmed: [], reported: [id] });
    expect(statuses(target.id)).toEqual(["cancelled"]);
    expect(delivered(calls, "plan A")).toHaveLength(0);
    expect(notice).toContain("dropped");
    expect(notice).not.toContain("still queued");
  }, 20000);

  it("tells the sender a message was dropped when the target's engine is unavailable", async () => {
    const { result, notice, id, target } = await sweepLost({ noEngine: true });
    expect(result).toEqual({ rearmed: [], reported: [id] });
    expect(statuses(target.id)).toEqual(["cancelled"]);
    expect(notice).toContain("dropped");
    expect(notice).not.toContain("still queued");
  }, 20000);

  it("reports a second message left unowned on the same target, not only the first", async () => {
    const { calls, context, target, caller } = setup({ limit: false, source: "telegram" });
    const lost = { ...context, sessionManager: { ...context.sessionManager, getQueue: () => acceptWithoutExecuting() } } as unknown as ApiContext;
    const first = await post(lost, target.id, { message: "plan A" }, toolHeaders(caller.id));
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: Date.now() + 6 * 60_000 }).reported).toEqual([first.body.queueItemId]);
      const second = await post(lost, target.id, { message: "plan B" }, toolHeaders(caller.id));
      expect(sweepLateralSends(context, { now: Date.now() + 60 * 60_000 }).reported).toEqual([first.body.queueItemId, second.body.queueItemId]);
      expect(sweepLateralSends(context, { now: Date.now() + 61 * 60_000 }).reported).toEqual([]);
      await eventually(() => expect(undeliveredTurns(calls)).toHaveLength(2));
      expect(undeliveredTurns(calls)[1].text).toContain(second.body.queueItemId);
    });
  }, 20000);

  it("does not promise a run for a message to a connector-owned session nothing here can dispatch", async () => {
    const { calls, result, notice, id, target } = await sweepLost({ source: "telegram" });
    expect(result).toEqual({ rearmed: [], reported: [id] });
    expect(statuses(target.id)).toEqual(["pending"]);
    expect(delivered(calls, "plan A")).toHaveLength(0);
    expect(notice).toContain("will not run by itself");
    expect(notice).not.toContain("still queued");
  }, 20000);
});
