import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  eventually,
  makeContext,
  queueModule,
  registry,
  resetCallbackState,
  type ApiContext,
} from "./helpers/callback-harness.js";
import { makeResponse, withRouteBackedFetch } from "./helpers/callback-requests.js";
import { ensureSessionCapability } from "../../mcp/identity.js";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";
import { isCompactCommand } from "../../shared/skill-commands.js";
import type { Engine, EngineRunOpts } from "../../shared/types.js";

/**
 * A compaction, once it has started, runs to completion. A message that arrives
 * while a session is compacting waits behind it: it never cuts the compaction
 * off, whether the operator typed `/compact`, the session asked for it with
 * `compact_session` (compaction turn, then resume turn), or the gateway started
 * it in front of a message. Real routes, SQLite and SessionQueue; only the
 * engine is fake, and its turns stay open until the test ends or kills them.
 * Both engines that can compact are covered: the route and the queue treat a
 * compaction by its `/compact` prompt, whichever engine then carries it out.
 * An explicit Stop still stops a compaction.
 */

beforeEach(resetCallbackState);

const GATEWAY = { host: "gateway.test", authorization: "Bearer test-token", "content-type": "application/json" };

async function call(context: ApiContext, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { ...GATEWAY, ...headers } });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  return captured;
}

/** An engine whose turns end only when released or killed. */
function holdingEngine() {
  const prompts: string[] = [];
  const kills: Array<string | undefined> = [];
  const releases: Array<() => void> = [];
  let alive = 0;
  const engine = {
    name: "stub",
    run: async (opts: EngineRunOpts) => {
      prompts.push(opts.prompt);
      alive++;
      await new Promise<void>((resolve) => { releases.push(resolve); });
      alive--;
      return { sessionId: "stub", result: "acknowledged" };
    },
    kill: (_id: string, reason?: string) => { kills.push(reason); releases.shift()?.(); },
    isAlive: () => alive > 0,
    killAll: () => {},
  } as unknown as Engine;
  return { engine, prompts, kills, finishTurn: () => releases.shift()?.() };
}

const COMPACT = "/compact keep the ids";
const quiet = () => new Promise((resolve) => setTimeout(resolve, 60));

async function sessionRunning(engineName: "claude" | "opencode", firstPrompt: string, config: Record<string, unknown> = {}) {
  const fake = holdingEngine();
  const queue = new queueModule.SessionQueue();
  const context = makeContext(fake.engine, queue, []);
  // opencode compacts only in server mode.
  Object.assign((context as unknown as { config: Record<string, unknown> }).config, { sessions: config, engines: { default: "stub", stub: {}, opencode: { mode: "server" } } });
  const session = registry.createSession({
    engine: engineName, source: "web", sourceRef: `web:compaction:${engineName}`, sessionKey: `web:compaction:${engineName}`, connector: "web", prompt: "work",
  });
  // A conversation to compact: without one the engine's compaction is declined.
  registry.updateSession(session.id, { engineSessionId: "conversation-1" });
  const first = await call(context, "POST", `/api/sessions/${session.id}/message`, { message: firstPrompt });
  expect(first.status).toBe(200);
  await eventually(() => expect(fake.prompts).toEqual([firstPrompt]));
  const pendingPrompts = () => registry.listPendingQueueItemIdsForSession(session.id).map((id) => registry.getQueueItem(id)!.prompt);
  const send = (message: string, extra: Record<string, unknown> = {}) => call(context, "POST", `/api/sessions/${session.id}/message`, { message, ...extra });
  const idle = () => eventually(() => expect(queue.isRunning(session.sessionKey)).toBe(false));
  return { ...fake, context, queue, session, pendingPrompts, send, idle };
}

describe.each(["claude", "opencode"] as const)("a message sent while a %s session is compacting", (engineName) => {
  it.each([
    ["by default", {}],
    ["with the per-message send-now choice", { delivery: "now" }],
    ["with the legacy interrupt flag", { interrupt: true }],
  ])("waits behind an operator's /compact, %s, and is answered after it", async (_label, extra) => {
    const t = await sessionRunning(engineName, COMPACT);
    expect((await t.send("also, what is the status?", extra)).status).toBe(200);
    await quiet();

    expect(t.kills).toEqual([]);
    expect(t.prompts).toEqual([COMPACT]);
    expect(t.pendingPrompts()).toEqual(["also, what is the status?"]);
    expect(registry.getSession(t.session.id)?.transportMeta?.supersededRunningTurnAt).toBeUndefined();

    t.finishTurn();
    await eventually(() => expect(t.prompts).toEqual([COMPACT, "also, what is the status?"]));
    t.finishTurn();
    await t.idle();
    expect(t.kills).toEqual([]);
  });

  it("does not cut a compact_session compaction off, and the message follows the resume turn", async () => {
    const t = await sessionRunning(engineName, "long task, about to ask for a compaction");
    const handoff = { goal: "finish the migration", done: "schema written", next: "run the backfill" };
    const asked = await withRouteBackedFetch(t.context, {}, () => call(t.context, "POST", "/api/compactions", handoff, {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: t.session.id,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(t.session.id),
    }));
    expect(asked.status).toBe(202);

    // The asking turn ends; the compaction turn starts and runs.
    t.finishTurn();
    await eventually(() => expect(t.prompts).toHaveLength(2));
    expect(isCompactCommand(t.prompts[1])).toBe(true);

    expect((await t.send("how is it going?")).status).toBe(200);
    await quiet();
    expect(t.kills).toEqual([]);
    expect(t.prompts).toHaveLength(2);

    t.finishTurn();
    await eventually(() => expect(t.prompts).toHaveLength(3));
    expect(t.prompts[2]).toContain("[Self-compaction resume]");
    t.finishTurn();
    await eventually(() => expect(t.prompts).toEqual([t.prompts[0], t.prompts[1], t.prompts[2], "how is it going?"]));
    t.finishTurn();
    await t.idle();
    expect(t.kills).toEqual([]);
  });

  it("is not folded into a /compact parked behind the turn that is running, nor does it cut that turn off", async () => {
    const t = await sessionRunning(engineName, "a long turn");
    await t.send(COMPACT);
    expect((await t.send("and then tell me the result")).status).toBe(200);
    await quiet();
    expect(t.kills).toEqual([]);
    expect(t.pendingPrompts()).toEqual([COMPACT, "and then tell me the result"]);

    t.finishTurn();
    await eventually(() => expect(t.prompts).toEqual(["a long turn", COMPACT]));
    t.finishTurn();
    await eventually(() => expect(t.prompts).toEqual(["a long turn", COMPACT, "and then tell me the result"]));
    t.finishTurn();
    await t.idle();
  });

  it("still interrupts an ordinary running turn, so the fix is only about compactions", async () => {
    const t = await sessionRunning(engineName, "an ordinary long turn");
    await t.send("stop that, do this instead");
    await eventually(() => expect(t.kills).toHaveLength(1));
    await eventually(() => expect(t.prompts).toHaveLength(2));
    expect(t.prompts[1]).toContain("stop that, do this instead");
    t.finishTurn();
    await t.idle();
  });

  it("is promoted by send-now without cutting the running compaction off, and runs right after it", async () => {
    const t = await sessionRunning(engineName, COMPACT);
    await t.send("first parked", { delivery: "queue" });
    await t.send("second parked", { delivery: "queue" });
    const [, second] = registry.listPendingQueueItemIdsForSession(t.session.id);

    expect((await call(t.context, "POST", `/api/sessions/${t.session.id}/queue/${second}/send-now`)).status).toBe(200);
    expect((await call(t.context, "POST", `/api/sessions/${t.session.id}/queue/send-now`)).status).toBe(200);
    await quiet();
    expect(t.kills).toEqual([]);
    expect(t.prompts).toEqual([COMPACT]);

    t.finishTurn();
    await eventually(() => expect(t.prompts).toHaveLength(2));
    expect(t.prompts[1]).toContain("second parked");
    t.finishTurn();
    await eventually(() => expect(t.queue.isRunning(t.session.sessionKey)).toBe(false));
  });

  it("is kept out of a parked /compact by send-now, which leaves the compaction's own text alone", async () => {
    const t = await sessionRunning(engineName, "a long turn");
    await t.send(COMPACT, { delivery: "queue" });
    await t.send("one", { delivery: "queue" });
    await t.send("two", { delivery: "queue" });
    expect((await call(t.context, "POST", `/api/sessions/${t.session.id}/queue/send-now`)).status).toBe(200);
    await eventually(() => expect(t.kills).toHaveLength(1));
    // The compaction stays a bare /compact and the two messages are read together.
    await eventually(() => expect(t.prompts.length).toBeGreaterThanOrEqual(2));
    const rest = [...t.prompts.slice(1), ...t.pendingPrompts()];
    expect(rest.filter(isCompactCommand)).toEqual([COMPACT]);
    expect(rest.some((prompt) => !isCompactCommand(prompt) && prompt.includes("one") && prompt.includes("two"))).toBe(true);
    for (let i = 0; i < 4; i++) t.finishTurn();
  });

  it("does not outlast a Stop: stopping the session ends the compaction", async () => {
    const t = await sessionRunning(engineName, COMPACT);
    await t.send("queued behind the compaction");
    const stopped = await call(t.context, "POST", `/api/sessions/${t.session.id}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ status: "stopped", wasRunning: true });
    await eventually(() => expect(t.kills).toHaveLength(1));
    await t.idle();
    expect(t.prompts).toEqual([COMPACT]);
  });
});
