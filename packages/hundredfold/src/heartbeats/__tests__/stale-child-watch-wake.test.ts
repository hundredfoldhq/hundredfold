import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, HundredfoldConfig } from "../../shared/types.js";

/**
 * A session that cannot run for hours (engine out of usage, gateway down) while
 * its hourly child-watch heartbeat keeps firing. Temp home, the real scheduler,
 * outbox, session route, queue rows and dispatch, with a stub engine that counts
 * the turns it is asked to run.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-stale-child-watch-"));
process.env.HUNDREDFOLD_HOME = home;
const OUTSIDE = process.env.HUNDREDFOLD_VITEST_SYSTEM_TEMP_ROOT ?? "/tmp";
const OWN_CONFIG = fs.mkdtempSync(path.join(OUTSIDE, "stale-child-watch-own-"));
process.env.CLAUDE_CONFIG_DIR = OWN_CONFIG;
fs.writeFileSync(path.join(OWN_CONFIG, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "t", expiresAt: 4_102_444_800_000 } }));

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-profile-signin.js")>()),
  verifyLocalClaudeProfile: () => undefined,
}));

let api: typeof import("../../gateway/api.js");
let registry: typeof import("../../sessions/registry.js");
let callbacks: typeof import("../../sessions/callbacks.js");
let dispatch: typeof import("../../gateway/web-session-dispatch.js");
let recovery: typeof import("../../gateway/callback-queue-recovery.js");
let watch: typeof import("../child-watch.js");
let store: typeof import("../store.js");
let scheduler: typeof import("../scheduler.js");
let db: typeof import("../../shared/db.js");

const config = {
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: process.execPath, model: "opus" } },
  models: { claude: { default: "opus", models: [{ id: "opus" }] } },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  sessions: {},
  mcp: {},
  portal: { setupComplete: true },
} as unknown as HundredfoldConfig;

let turns = 0;
const engine = {
  name: "claude",
  async run(opts: { resumeSessionId?: string }) {
    turns += 1;
    return { sessionId: opts.resumeSessionId ?? `thread-${turns}`, result: "NO_CHANGE", numTurns: 1 };
  },
  isAlive: () => true,
  isTurnRunning: () => false,
  kill: () => {},
  killAll: () => {},
} as unknown as Engine;
const engines = new Map<string, Engine>([["claude", engine]]);

const noQueue = {
  enqueue: async () => {}, clearCancelled: () => {}, clearQueue: () => {}, pauseQueue: () => {}, resumeQueue: () => {},
  holdForCallbackDrain: () => {}, releaseCallbackDrain: () => {}, hasInFlightItem: () => false, getPendingCount: () => 0,
  getRowlessWaitingCount: () => 0, getTransportState: (_key: string, status: string) => status,
};
const running: Promise<unknown>[] = [];
const runningQueue = { ...noQueue, enqueue: async (_key: string, fn: () => Promise<unknown>) => { const turn = fn(); running.push(turn); await turn; } };
const makeContext = (queue: unknown) => ({
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  gatewayBootId: "boot-1",
  emit: () => {},
  sessionManager: { getEngines: () => engines, getEngine: (name: string) => engines.get(name), getQueue: () => queue },
}) as unknown as import("../../gateway/api.js").ApiContext;
/** The session cannot run: its messages park on their queue rows and nothing starts them. */
const parkContext = makeContext(noQueue);
/** The session is back: each row is run the way the queue would. */
const runContext = makeContext(runningQueue);

async function request(method: string, url: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  let status = 200;
  let raw = "";
  const body = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))];
  const req = Object.assign(Readable.from(body), { method, url, headers: { host: "gw.test", "content-type": "application/json", ...opts.headers } });
  const res = {
    writeHead(next: number) { status = next; return this; }, setHeader() { return this; }, getHeader() { return undefined; },
    end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); }, write(chunk: Buffer | string) { raw += chunk.toString(); return true; },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as unknown as IncomingMessage, res, parkContext);
  return { status, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} };
}

beforeAll(async () => {
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  callbacks = await import("../../sessions/callbacks.js");
  dispatch = await import("../../gateway/web-session-dispatch.js");
  recovery = await import("../../gateway/callback-queue-recovery.js");
  watch = await import("../child-watch.js");
  store = await import("../store.js");
  scheduler = await import("../scheduler.js");
  db = await import("../../shared/db.js");
  db.initDb();
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const out = await request(init?.method ?? "GET", url.pathname + url.search, {
      headers: { authorization: "Bearer test-token" },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(out.body), { status: out.status });
  });
}, 60_000);

afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(() => {
  running.length = 0;
  turns = 0;
  db.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM callback_deliveries; DELETE FROM heartbeats; DELETE FROM sessions;");
});

const HOUR_MS = 3_600_000;
/** The heartbeat's clock starts now: the delivery-time check reads the real clock for expiry. */
const T0 = Date.now();
let counter = 0;

/** An orchestrator whose one child session is still working, so there is something to watch. */
function watcher() {
  counter += 1;
  const parent = registry.createSession({ engine: "claude", source: "web", sourceRef: `cw-parent-${counter}`, model: "opus", employee: "lead" });
  const child = registry.createSession({
    engine: "claude", source: "web", sourceRef: `cw-child-${counter}`, model: "opus", employee: "worker", parentSessionId: parent.id,
  });
  registry.updateSession(parent.id, { status: "idle" });
  registry.updateSession(child.id, { status: "running" });
  watch.armChildWatch(parent.id, T0);
  return { parent: parent.id, child: child.id };
}

const rowsOf = (id: string, status: string) => db.initDb()
  .prepare("SELECT id, prompt FROM queue_items WHERE session_id = ? AND status = ? ORDER BY position ASC, created_at ASC")
  .all(id, status) as Array<{ id: string; prompt: string }>;
const pendingRows = (id: string) => rowsOf(id, "pending");

/** `n` hourly sweeps while the session cannot run; each delivery reaches the session's queue before the next. */
async function hoursPass(sessionId: string, n: number): Promise<void> {
  for (let hour = 1; hour <= n; hour++) {
    scheduler.sweepOnce({ now: () => T0 + hour * HOUR_MS + 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  void sessionId;
}

/** Hand every parked row to dispatch, oldest first, as the session's queue would once it can run. */
async function resume(id: string): Promise<void> {
  for (const row of pendingRows(id)) {
    const before = running.length;
    dispatch.dispatchWebSessionRun(registry.getSession(id)!, row.prompt, engine, runContext, { queueItemId: row.id });
    await vi.waitFor(() => expect(running.length).toBeGreaterThan(before));
    await Promise.all(running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    registry.markQueueItemCompleted(row.id);
  }
}

describe("child-watch wakes while the session cannot run", () => {
  it("keeps one wake waiting however many intervals pass, and the fires still count", async () => {
    const { parent } = watcher();
    await hoursPass(parent, 6);

    expect(pendingRows(parent)).toHaveLength(1);
    expect(store.listHeartbeatsForSession(parent)[0]?.fireCount).toBe(6);
    expect(db.initDb().prepare("SELECT COUNT(*) FROM callback_deliveries WHERE target_session_id = ? AND delivery_kind = 'heartbeat'").pluck().get(parent)).toBe(1);
  });

  it("runs that one wake when the session resumes with a child still open", async () => {
    const { parent } = watcher();
    await hoursPass(parent, 4);
    await resume(parent);

    expect(turns).toBe(1);
  });

  it("runs no turn when the session resumes after the children settled", async () => {
    const { parent, child } = watcher();
    await hoursPass(parent, 4);
    registry.updateSession(child, { status: "idle" });
    await resume(parent);

    expect(turns).toBe(0);
    expect(rowsOf(parent, "completed")).toHaveLength(1);
    expect(registry.getSession(parent)!.status).toBe("idle");
  });

  it("runs no turn for a wake whose heartbeat was disarmed while it waited", async () => {
    const { parent } = watcher();
    await hoursPass(parent, 2);
    const [heartbeat] = store.listHeartbeatsForSession(parent);
    store.disarmHeartbeat(heartbeat!.id, "expired", T0 + 3 * HOUR_MS);
    await resume(parent);

    expect(turns).toBe(0);
  });

  it("answers a backlog an older build queued with at most one turn, or none when nothing is open", async () => {
    const { parent, child } = watcher();
    const [heartbeat] = store.listHeartbeatsForSession(parent);
    // Seven wakes already parked, as the instance that reported this had: each is its own delivery and queue row.
    for (let fire = 1; fire <= 7; fire++) {
      const { delivery } = registry.claimSessionDelivery({
        targetSessionId: parent, sourceKind: "heartbeat", sourceId: heartbeat!.id, sourceAttempt: `fire-${fire}`,
        sourceOutcome: "fired", sourceVersion: 1, deliveryKind: "heartbeat",
        payload: { message: watch.CHILD_WATCH_MESSAGE, displayMessage: "⏰ Child check" },
      });
      await callbacks.deliverClaimedSessionDelivery(delivery.id);
    }
    expect(pendingRows(parent)).toHaveLength(7);

    await resume(parent);
    expect(turns).toBe(1); // only the newest, of seven

    // The same backlog once the children are done.
    turns = 0;
    registry.updateSession(child, { status: "idle" });
    for (let fire = 8; fire <= 12; fire++) {
      const { delivery } = registry.claimSessionDelivery({
        targetSessionId: parent, sourceKind: "heartbeat", sourceId: heartbeat!.id, sourceAttempt: `fire-${fire}`,
        sourceOutcome: "fired", sourceVersion: 1, deliveryKind: "heartbeat",
        payload: { message: watch.CHILD_WATCH_MESSAGE, displayMessage: "⏰ Child check" },
      });
      await callbacks.deliverClaimedSessionDelivery(delivery.id);
    }
    await resume(parent);
    expect(turns).toBe(0);
  });

  it("drops a stale wake on replay after a restart without marking the session running", async () => {
    const { parent, child } = watcher();
    await hoursPass(parent, 3);
    registry.updateSession(child, { status: "idle" });
    registry.updateSession(parent, { status: "idle" });
    recovery.resumePendingWebQueueItems(runContext);

    expect(pendingRows(parent)).toHaveLength(0);
    expect(rowsOf(parent, "cancelled")).toHaveLength(1);
    expect(registry.getSession(parent)!.status).toBe("idle");
    expect(turns).toBe(0);
  });

  it("leaves another heartbeat's tick alone", async () => {
    counter += 1;
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: `cw-manual-${counter}`, model: "opus", employee: "lead" });
    registry.updateSession(session.id, { status: "idle" });
    const manual = store.armHeartbeat({ ownerSessionId: session.id, message: "Check on CI.", everySeconds: 60, maxFires: 1 }, T0);
    expect(scheduler.sweepOnce({ now: () => T0 + 60_001 })).toBe(1);
    await vi.waitFor(() => expect(pendingRows(session.id)).toHaveLength(1));
    expect(store.getHeartbeat(manual.id)!.status).toBe("disarmed"); // its last fire disarmed it, and its tick still runs
    await resume(session.id);

    expect(turns).toBe(1);
  });
});
