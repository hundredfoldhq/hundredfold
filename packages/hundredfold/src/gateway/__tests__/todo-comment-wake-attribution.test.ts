import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ORG_HOME, startHarness, type Harness } from "../../accounts/__tests__/accounts-harness.js";
import { joinAsOwner, type Joined } from "../../accounts/__tests__/flows-helpers.js";
import {
  authCookieName, authDeviceCookieName, createAuthSession,
} from "../auth.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability,
} from "../../mcp/identity.js";

// The duplicate route forks the engine's own transcript; there is no engine here, so the fork is a stub that succeeds.
vi.mock("../../sessions/fork.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/fork.js")>()),
  forkEngineSession: async () => ({ engineSessionId: "forked-engine-ref" }),
}));

/**
 * A session woken by a Todo comment is attributed to the account that wrote the comment. The harness is the account
 * side (real sign-in, real device store); the request handler is the real `handleApiRequest` with the real comment
 * routing installed over the real registry, with the engine turn stubbed.
 */

fs.mkdirSync(path.join(ORG_HOME, "org"), { recursive: true });
fs.writeFileSync(
  path.join(ORG_HOME, "org", "wake-worker.yaml"),
  ["name: wake-worker", "displayName: Wake Worker", "department: platform", "rank: employee", "engine: codex", "model: gpt-5.5", "persona: Completes bounded work", ""].join("\n"),
);

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let reg: Reg;
let h: Harness;
let userHeader: string | string[] | undefined;

const engineStub = {
  name: "stub",
  run: async () => ({ result: "ok" }),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};
const queueStub = {
  enqueue: async () => {},
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

function context(): import("../api.js").ApiContext {
  return {
    getConfig: () => ({
      gateway: { ...(userHeader ? { userHeader } : {}) },
      engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
      models: { codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] } },
      sessions: {},
      mcp: { gateway: { enabled: true } },
      portal: { portalName: "COO" },
    }),
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    hundredfoldHome: h.home,
    accounts: h.rt,
    emit: () => {},
    reloadOrg: () => {},
    sessionManager: { getEngines: () => new Map(), getEngine: () => engineStub, getQueue: () => queueStub },
  } as unknown as import("../api.js").ApiContext;
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader() { return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

async function call(method: string, url: string, body: unknown, headers: Record<string, string>) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, context());
  return { status: cap.status, body: cap.body };
}

const asBearer = { authorization: "Bearer test-token" };
const asAccount = (who: Joined) => ({ cookie: who.cookie });
const asTool = (sessionId: string) => ({
  [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
  [CALLER_SESSION_HEADER]: sessionId,
  [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
});

function userIdColumn(sessionId: string): string | null {
  return (reg.getSession(sessionId) as { userId: string | null }).userId;
}

let uninstall: (() => void) | undefined;
let todoSeq = 0;

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  (await import("../../shared/db.js")).initDb();
}, 60_000);

beforeEach(async () => {
  userHeader = undefined;
  h = await startHarness();
  uninstall = (await import("../todo-comment-routing.js")).installTodoCommentRouting(context());
}, 60_000);
afterEach(() => { uninstall?.(); h.close(); });
afterAll(async () => { (await import("../../shared/db.js")).__closeDbForTest(); });

/** A fresh Todo, so each case starts its own session rather than delivering into an earlier one. */
async function newTodo(): Promise<string> {
  const { createWorkItem } = await import("../../work-items/store.js");
  return createWorkItem({ title: `Wake attribution ${++todoSeq}`, source: "human" }).id;
}

/** Comment on the Todo as `headers` and return the session it woke the worker into. */
async function commentWakingWorker(todoId: string, headers: Record<string, string>): Promise<string> {
  const posted = await call("POST", `/api/work-items/${todoId}/comments`, { body: "@wake-worker please take a look" }, headers);
  expect(posted.status).toBe(201);
  const woken = reg.listSessionsByWorkItem(todoId).filter((session) => session.employee === "wake-worker");
  expect(woken).toHaveLength(1);
  return woken[0]!.id;
}

describe("a Todo comment that wakes an employee", () => {
  it("attributes the new session to the signed-in owner who wrote it, on the row and on the session API", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const omar = await joinAsOwner(h, "omar@example.test");

    const oliveSession = await commentWakingWorker(await newTodo(), asAccount(olive));
    const omarSession = await commentWakingWorker(await newTodo(), asAccount(omar));

    expect(userIdColumn(oliveSession)).toBe(olive.userId);
    expect(userIdColumn(omarSession)).toBe(omar.userId);
    const read = await call("GET", `/api/sessions/${oliveSession}?messages=0`, undefined, asBearer);
    expect(read.status).toBe(200);
    expect(read.body.userId).toBe(olive.userId);
  });

  it("carries the owner to whatever the woken session spawns, however deep", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const woken = await commentWakingWorker(await newTodo(), asAccount(olive));

    const child = await call("POST", "/api/sessions", { prompt: "child work" }, asTool(woken));
    const grandchild = await call("POST", "/api/sessions", { prompt: "grandchild work" }, asTool(child.body.id));

    expect(userIdColumn(child.body.id)).toBe(olive.userId);
    expect(userIdColumn(grandchild.body.id)).toBe(olive.userId);
  });

  it("takes the account of the session that wrote the comment, not the owner of anything else", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const chat = (await call("POST", "/api/sessions", { prompt: "olive's chat" }, asAccount(olive))).body.id as string;
    const bareChat = (await call("POST", "/api/sessions", { prompt: "token chat" }, asBearer)).body.id as string;

    const fromChat = await commentWakingWorker(await newTodo(), asTool(chat));
    const fromBare = await commentWakingWorker(await newTodo(), asTool(bareChat));

    expect(userIdColumn(fromChat)).toBe(olive.userId);
    expect(userIdColumn(fromBare)).toBeNull();
  });

  it("leaves the session unattributed when the comment was made with the bearer token", async () => {
    const woken = await commentWakingWorker(await newTodo(), asBearer);

    expect(userIdColumn(woken)).toBeNull();
    const read = await call("GET", `/api/sessions/${woken}?messages=0`, undefined, asBearer);
    expect(read.body.userId ?? null).toBeNull();
  });

  it("names no account for a paired device, a disabled owner or an id cookie alone", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const deviceId = /(?:^|;\s*)[^=]*device[^=]*=([^;]+)/i.exec(olive.cookie)![1]!;
    const paired = createAuthSession(h.home, { headers: {}, socket: { remoteAddress: "10.0.0.5" } } as any, { kind: "remote" });
    const pairedCookie = `${authCookieName(h.home)}=${paired.secret}; ${authDeviceCookieName(h.home)}=${paired.device.id}`;

    const viaPaired = await commentWakingWorker(await newTodo(), { ...asBearer, cookie: pairedCookie });
    const viaIdOnly = await commentWakingWorker(await newTodo(), { ...asBearer, cookie: `${authDeviceCookieName(h.home)}=${deviceId}` });
    h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(olive.userId);
    const viaDisabled = await commentWakingWorker(await newTodo(), asAccount(olive));

    for (const id of [viaPaired, viaIdOnly, viaDisabled]) expect(userIdColumn(id)).toBeNull();
  });

  it("attributes a consult woken by a mention in a thread reply", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const todoId = await newTodo();
    const root = await call("POST", `/api/work-items/${todoId}/comments`, { body: "first thoughts" }, asAccount(olive));
    const reply = await call("POST", `/api/work-items/${todoId}/comments`, { body: "@wake-worker thread mention", parentCommentId: root.body.comment.id }, asAccount(olive));
    expect(reply.status).toBe(201);

    const woken = reg.listSessionsByWorkItem(todoId).filter((session) => session.employee === "wake-worker");
    expect(woken).toHaveLength(1);
    expect(userIdColumn(woken[0]!.id)).toBe(olive.userId);
  });

  it("does not expose the commenting account on the comment itself", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const todoId = await newTodo();
    const posted = await call("POST", `/api/work-items/${todoId}/comments`, { body: "plain note" }, asAccount(olive));
    const listed = await call("GET", `/api/work-items/${todoId}/comments`, undefined, asBearer);

    expect(JSON.stringify(posted.body)).not.toContain(olive.userId);
    expect(JSON.stringify(listed.body)).not.toContain(olive.userId);
  });

  it("keeps the proxy identity ahead of the account, as every session-starting route does", async () => {
    userHeader = "X-Auth-Request-Email";
    const olive = await joinAsOwner(h, "olive@example.test");

    const proxied = await commentWakingWorker(await newTodo(), { ...asAccount(olive), "x-auth-request-email": "sso@example.test" });
    expect(userIdColumn(proxied)).toBe("sso@example.test");
  });
});

describe("the comment-meta table made before accounts were recorded", () => {
  it("gains the column in place and keeps its old rows readable", async () => {
    const { recordCommentMeta, commentAccountId, withCommentMeta } = await import("../../work-items/comment-meta.js");
    const { Database } = { Database: (await import("better-sqlite3")).default };
    const old = new Database(":memory:");
    old.exec(`CREATE TABLE work_item_comments (id TEXT PRIMARY KEY);
      CREATE TABLE work_item_comment_meta (comment_id TEXT PRIMARY KEY REFERENCES work_item_comments(id) ON DELETE CASCADE, session_id TEXT, replied_to_id TEXT);
      INSERT INTO work_item_comments (id) VALUES ('wic_old'), ('wic_new');
      INSERT INTO work_item_comment_meta (comment_id, session_id) VALUES ('wic_old', 'sess-old');`);
    recordCommentMeta(old, "wic_new", { userId: "usr_x" });

    expect(commentAccountId(old, "wic_new")).toBe("usr_x");
    expect(commentAccountId(old, "wic_old")).toBeUndefined();
    expect(withCommentMeta(old, [{ id: "wic_old" }])[0]).toMatchObject({ sessionId: "sess-old" });
  });
});
