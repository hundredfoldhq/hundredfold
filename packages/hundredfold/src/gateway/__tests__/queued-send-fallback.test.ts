import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptWithoutExecuting, api, createParent, dbModule, eventually, makeContext, queueModule, registry, resetCallbackState, type ApiContext,
} from "./helpers/callback-harness.js";
import { sweepLateralSends } from "../lateral-send-watch.js";
import { markSessionStopped } from "../../sessions/stopped-marker.js";
import { makeResponse, withRouteBackedFetch } from "./helpers/callback-requests.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability,
} from "../../mcp/identity.js";
import type { Engine, EngineRunOpts } from "../../shared/types.js";

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
function setup(opts: { limit?: boolean; source?: string } = {}) {
  const limit = opts.limit !== false;
  const calls: Array<{ text: string; account: string }> = [];
  const gates: Array<() => void> = [];
  const engine: Engine = {
    name: "claude",
    run: async (opts: EngineRunOpts) => {
      const account = opts.claudeProfile?.dir?.endsWith("claude-a") ? "A" : opts.claudeProfile?.dir?.endsWith("claude-b") ? "B" : "?";
      calls.push({ text: opts.prompt, account });
      if (limit && calls.length === 1) {
        // The first turn holds the lane, then the account is out of allowance.
        await new Promise<void>((resolve) => gates.push(resolve));
        return { sessionId: "", result: "", error: "429", rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } } as never;
      }
      return { sessionId: `thread-${calls.length}`, result: "ok" };
    },
  };
  const queue = new queueModule.SessionQueue();
  const base = makeContext(engine, queue);
  const config = { gateway: {}, sessions: {}, mcp: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus", accounts: { A: { configDir: DIR_A }, B: { configDir: DIR_B } } } } };
  const context = { ...base, config, getConfig: () => config, sessionManager: { getEngine: () => engine, getEngines: () => new Map([["claude", engine]]), getQueue: () => queue } } as unknown as ApiContext;
  const target = registry.createSession({ engine: "claude", model: "opus", employee: "worker-a", source: opts.source ?? "web", sourceRef: "web:fb-target", sessionKey: "web:fb-target", connector: opts.source ?? "web", prompt: "x" });
  const caller = createParent("fb-caller");
  return { calls, gates, queue, context, target, caller };
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

  it("is reported to its sender, once, when the lane has not reached it", async () => {
    const { calls, gates, queue, context, target, caller } = setup();
    await post(context, target.id, { message: "start" });
    await eventually(() => expect(gates).toHaveLength(1));
    const sent = await post(context, target.id, { message: "plan A" }, toolHeaders(caller.id));

    const later = Date.now() + 6 * 60_000;
    await withRouteBackedFetch(context, {}, async () => {
      expect(sweepLateralSends(context, { now: later })).toEqual({ rearmed: [], reported: [sent.body.queueItemId] });
      expect(sweepLateralSends(context, { now: later + 60_000 })).toEqual({ rearmed: [], reported: [] });
      await eventually(() => {
        const notices = registry.getMessages(caller.id).filter((message) => message.role === "notification");
        expect(notices).toHaveLength(1);
        expect(notices[0].content).toContain("undelivered");
      });
    });
    gates[0]();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(delivered(calls, "plan A")).toHaveLength(1);
    });
  }, 20000);
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

  it("does not promise a run for a message to a connector-owned session nothing here can dispatch", async () => {
    const { calls, result, notice, id, target } = await sweepLost({ source: "telegram" });
    expect(result).toEqual({ rearmed: [], reported: [id] });
    expect(statuses(target.id)).toEqual(["pending"]);
    expect(delivered(calls, "plan A")).toHaveLength(0);
    expect(notice).toContain("will not run by itself");
    expect(notice).not.toContain("still queued");
  }, 20000);
});
