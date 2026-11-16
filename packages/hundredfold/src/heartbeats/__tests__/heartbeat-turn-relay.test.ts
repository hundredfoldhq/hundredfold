import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, HundredfoldConfig } from "../../shared/types.js";

/**
 * A heartbeat tick, end to end through the scheduler, the outbox, the session
 * route, the queue row, dispatch and the turn's settle (temp home, a stub engine
 * that replies with whatever the test says): a child's tick that found nothing
 * stays in the child's chat, and one that found something still wakes the parent.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-heartbeat-turn-relay-"));
process.env.HUNDREDFOLD_HOME = home;
const OUTSIDE = process.env.HUNDREDFOLD_VITEST_SYSTEM_TEMP_ROOT ?? "/tmp";
const OWN_CONFIG = fs.mkdtempSync(path.join(OUTSIDE, "heartbeat-relay-own-"));
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
let dispatch: typeof import("../../gateway/web-session-dispatch.js");
let store: typeof import("../store.js");
let scheduler: typeof import("../scheduler.js");
let db: typeof import("../../shared/db.js");

const config = {
  gateway: { port: 7798, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: process.execPath, model: "opus" } },
  models: { claude: { default: "opus", models: [{ id: "opus" }] } },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  sessions: {},
  mcp: {},
  portal: { setupComplete: true },
} as unknown as HundredfoldConfig;

let reply = "";
let threads = 0;
const engine = {
  name: "claude",
  async run(opts: { resumeSessionId?: string }) {
    threads += 1;
    return { sessionId: opts.resumeSessionId ?? `thread-${threads}`, result: reply, numTurns: 1 };
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
/** Messages park on their queue row; the test runs each row itself, as the queue would. */
const parkContext = makeContext(noQueue);
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
  dispatch = await import("../../gateway/web-session-dispatch.js");
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
  db.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM callback_deliveries; DELETE FROM heartbeats; DELETE FROM sessions;");
});

let counter = 0;
function pair() {
  counter += 1;
  const parent = registry.createSession({ engine: "claude", source: "web", sourceRef: `hb-parent-${counter}`, model: "opus", employee: "lead" });
  const child = registry.createSession({
    engine: "claude", source: "web", sourceRef: `hb-child-${counter}`, model: "opus", employee: "worker", parentSessionId: parent.id,
  });
  registry.updateSession(parent.id, { status: "idle" });
  registry.updateSession(child.id, { status: "idle" });
  return { parent: parent.id, child: child.id };
}

const pendingRows = (id: string) => db.initDb()
  .prepare("SELECT id, prompt FROM queue_items WHERE session_id = ? AND status = 'pending' ORDER BY position ASC, created_at ASC")
  .all(id) as Array<{ id: string; prompt: string }>;

const deliveriesTo = (id: string) => db.initDb()
  .prepare("SELECT delivery_kind AS kind FROM callback_deliveries WHERE target_session_id = ?")
  .all(id) as Array<{ kind: string }>;

/** Run the session's next queued turn through dispatch and let it settle, then close its row as the queue would. */
async function runNext(id: string): Promise<void> {
  const [row] = pendingRows(id);
  if (!row) throw new Error(`nothing queued for ${id}`);
  const before = running.length;
  dispatch.dispatchWebSessionRun(registry.getSession(id)!, row.prompt, engine, runContext, { queueItemId: row.id });
  await vi.waitFor(() => expect(running.length).toBeGreaterThan(before));
  await Promise.all(running);
  await new Promise((resolve) => setTimeout(resolve, 30));
  registry.markQueueItemCompleted(row.id);
}

/** Fire one tick of a heartbeat the child armed, and run the turn it queues. */
async function tick(child: string, answer: string): Promise<void> {
  store.armHeartbeat({ ownerSessionId: child, message: "Check on CI.", everySeconds: 60 }, 0);
  expect(scheduler.sweepOnce({ now: () => 60_001 })).toBe(1);
  await vi.waitFor(() => expect(pendingRows(child)).toHaveLength(1));
  reply = answer;
  await runNext(child);
}

describe("a heartbeat turn in a child session", () => {
  it("keeps a no-change reply in the child's chat and does not queue a turn for the parent", async () => {
    const { parent, child } = pair();
    await tick(child, "NO_CHANGE");

    expect(registry.getSession(child)!.status).toBe("idle");
    expect(deliveriesTo(parent)).toEqual([]);
    expect(pendingRows(parent)).toEqual([]);
  });

  it("still wakes the parent when the tick found something", async () => {
    const { parent, child } = pair();
    await tick(child, "CI went green, so I opened the PR for review.");

    expect(deliveriesTo(parent)).toEqual([{ kind: "parent-completion" }]);
  });

  it("relays the same token on the child's next turn, which no heartbeat started", async () => {
    const { parent, child } = pair();
    await tick(child, "NO_CHANGE");
    const res = await request("POST", `/api/sessions/${child}/message`, {
      headers: { authorization: "Bearer test-token" },
      body: { message: "Anything to report?", role: "notification" },
    });
    expect(res.status).toBeLessThan(300);
    reply = "NO_CHANGE";
    await runNext(child);

    expect(deliveriesTo(parent)).toEqual([{ kind: "parent-completion" }]);
  });
});
