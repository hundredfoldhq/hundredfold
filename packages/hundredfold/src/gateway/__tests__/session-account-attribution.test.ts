import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { GOOD_PASSWORD, ORG_HOME, startHarness, type Harness } from "../../accounts/__tests__/accounts-harness.js";
import { joinAsOwner, inviteAndAccept, type Joined } from "../../accounts/__tests__/flows-helpers.js";
import {
  authCookieName, authDeviceCookieName, createAuthSession, linkAuthSessionToUser,
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
 * Which signed-in account started a session. The harness is the account side (real sign-in, real device store); the
 * request handler is the real `handleApiRequest` over the real registry, with the engine turn stubbed.
 */

fs.mkdirSync(path.join(ORG_HOME, "org"), { recursive: true });
fs.writeFileSync(
  path.join(ORG_HOME, "org", "attr-worker.yaml"),
  ["name: attr-worker", "displayName: Attribution Worker", "department: platform", "rank: employee", "engine: codex", "model: gpt-5.5", "persona: Completes bounded work", ""].join("\n"),
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

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  (await import("../../shared/db.js")).initDb();
  (await import("../../mcp/attachment.js")).setHundredfoldAttachGate({ ok: true });
}, 60_000);

beforeEach(async () => { userHeader = undefined; h = await startHarness(); }, 60_000);
afterEach(() => { h.close(); });
afterAll(async () => {
  (await import("../../mcp/attachment.js")).setHundredfoldAttachGate(null);
  (await import("../../shared/db.js")).__closeDbForTest();
});

describe("POST /api/sessions: the account that started the chat", () => {
  it("stores the signed-in owner's id, and each of two owners gets their own", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const omar = await joinAsOwner(h, "omar@example.test");

    const first = await call("POST", "/api/sessions", { prompt: "olive's chat" }, asAccount(olive));
    const second = await call("POST", "/api/sessions", { prompt: "omar's chat" }, asAccount(omar));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(userIdColumn(first.body.id)).toBe(olive.userId);
    expect(userIdColumn(second.body.id)).toBe(omar.userId);
    expect(olive.userId).not.toBe(omar.userId);
  });

  it("stores nothing for the bearer token, a paired device, or an id cookie riding on another credential", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const deviceId = /(?:^|;\s*)[^=]*device[^=]*=([^;]+)/i.exec(olive.cookie)![1]!;
    const paired = createAuthSession(h.home, { headers: {}, socket: { remoteAddress: "10.0.0.5" } } as any, { kind: "remote" });
    const pairedCookie = `${authCookieName(h.home)}=${paired.secret}; ${authDeviceCookieName(h.home)}=${paired.device.id}`;

    const bearer = await call("POST", "/api/sessions", { prompt: "token" }, asBearer);
    const pairedReply = await call("POST", "/api/sessions", { prompt: "paired" }, { cookie: pairedCookie });
    const idOnly = await call("POST", "/api/sessions", { prompt: "id only" }, { ...asBearer, cookie: `${authDeviceCookieName(h.home)}=${deviceId}` });

    for (const reply of [bearer, pairedReply, idOnly]) {
      expect(reply.status).toBe(201);
      expect(userIdColumn(reply.body.id)).toBeNull();
    }
  });

  it("stores nothing for an owner who has since been disabled, or a link to an account that no longer exists", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(olive.userId);
    const disabled = await call("POST", "/api/sessions", { prompt: "disabled" }, asAccount(olive));
    expect(userIdColumn(disabled.body.id)).toBeNull();

    const paired = createAuthSession(h.home, { headers: {}, socket: { remoteAddress: "10.0.0.5" } } as any, { kind: "remote" });
    linkAuthSessionToUser(h.home, paired.device.id, "usr_gone");
    const gone = await call("POST", "/api/sessions", { prompt: "gone" }, { cookie: `${authCookieName(h.home)}=${paired.secret}; ${authDeviceCookieName(h.home)}=${paired.device.id}` });
    expect(userIdColumn(gone.body.id)).toBeNull();
  });

  it("keeps the proxy identity ahead of the account when gateway.userHeader is set, and uses the account when it is absent", async () => {
    userHeader = "X-Auth-Request-Email";
    const olive = await joinAsOwner(h, "olive@example.test");

    const proxied = await call("POST", "/api/sessions", { prompt: "proxied" }, { ...asAccount(olive), "x-auth-request-email": "sso@example.test" });
    expect(userIdColumn(proxied.body.id)).toBe("sso@example.test");

    const noHeader = await call("POST", "/api/sessions", { prompt: "no header" }, asAccount(olive));
    expect(userIdColumn(noHeader.body.id)).toBe(olive.userId);

    const proxyOnly = await call("POST", "/api/sessions", { prompt: "proxy only" }, { ...asBearer, "x-auth-request-email": "sso@example.test" });
    expect(userIdColumn(proxyOnly.body.id)).toBe("sso@example.test");
  });
});

describe("children inherit the account of the session above them", () => {
  it("a spawn from a person's chat, and a spawn from that child, carry the person", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const chat = (await call("POST", "/api/sessions", { prompt: "olive's chat" }, asAccount(olive))).body.id as string;

    const child = await call("POST", "/api/sessions", { prompt: "child work" }, asTool(chat));
    const grandchild = await call("POST", "/api/sessions", { prompt: "grandchild work" }, asTool(child.body.id));

    expect(child.status).toBe(201);
    expect(reg.getSession(child.body.id)!.parentSessionId).toBe(chat);
    expect(userIdColumn(child.body.id)).toBe(olive.userId);
    expect(userIdColumn(grandchild.body.id)).toBe(olive.userId);
  });

  it("a delegation from a person's chat carries the person, and the tree under another's chat carries theirs", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const omar = await joinAsOwner(h, "omar@example.test");
    const oliveChat = (await call("POST", "/api/sessions", { prompt: "olive" }, asAccount(olive))).body.id as string;
    const omarChat = (await call("POST", "/api/sessions", { prompt: "omar" }, asAccount(omar))).body.id as string;

    const fromOlive = await call("POST", "/api/delegations", { employee: "attr-worker", task: "Do the thing", title: "Thing" }, asTool(oliveChat));
    const fromOmar = await call("POST", "/api/delegations", { employee: "attr-worker", task: "Do the other thing", title: "Other" }, asTool(omarChat));

    expect(fromOlive.status).toBe(201);
    expect(fromOmar.status).toBe(201);
    expect(userIdColumn(fromOlive.body.sessionId)).toBe(olive.userId);
    expect(userIdColumn(fromOmar.body.sessionId)).toBe(omar.userId);
  });

  it("a delegation asked for from the dashboard carries the signed-in account, a bearer one carries none", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const web = await call("POST", "/api/delegations", { employee: "attr-worker", task: "From the UI", title: "UI" }, asAccount(olive));
    const bare = await call("POST", "/api/delegations", { employee: "attr-worker", task: "From a script", title: "Script" }, asBearer);
    expect(web.status).toBe(201);
    expect(userIdColumn(web.body.sessionId)).toBe(olive.userId);
    expect(userIdColumn(bare.body.sessionId)).toBeNull();
  });

  it("a child with its own proxy identity keeps it, and a child of an unattributed parent stays unattributed", async () => {
    userHeader = "X-Auth-Request-Email";
    const olive = await joinAsOwner(h, "olive@example.test");
    const chat = (await call("POST", "/api/sessions", { prompt: "olive" }, asAccount(olive))).body.id as string;
    const own = await call("POST", "/api/sessions", { prompt: "own identity" }, { ...asTool(chat), "x-auth-request-email": "sso@example.test" });
    expect(userIdColumn(own.body.id)).toBe("sso@example.test");

    const root = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:unattributed-root" });
    const orphan = await call("POST", "/api/sessions", { prompt: "no account above" }, asTool(root.id));
    expect(reg.getSession(orphan.body.id)!.parentSessionId).toBe(root.id);
    expect(userIdColumn(orphan.body.id)).toBeNull();
  });

  it("the registry gives a child its parent's account only when it has none of its own", () => {
    const parent = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:inherit-parent", userId: "usr_parent" });
    const inherited = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:inherit-a", parentSessionId: parent.id });
    const own = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:inherit-b", parentSessionId: parent.id, userId: "usr_own" });
    const missing = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:inherit-c", parentSessionId: "no-such-parent" });
    expect(inherited.userId).toBe("usr_parent");
    expect(reg.getSession(inherited.id)!.userId).toBe("usr_parent");
    expect(own.userId).toBe("usr_own");
    expect(missing.userId).toBeNull();
  });
});

describe("POST /api/work-items/:id/dispatch: the Dispatcher session", () => {
  it("is attributed to whoever pressed Dispatch, and its delegate to the same person", async () => {
    const { createWorkItem } = await import("../../work-items/store.js");
    const olive = await joinAsOwner(h, "olive@example.test");
    const item = createWorkItem({ title: "Attribute the dispatcher", source: "human" });
    const pressed = await call("POST", `/api/work-items/${item.id}/dispatch`, {}, asAccount(olive));
    expect(pressed.status).toBe(201);
    expect(userIdColumn(pressed.body.sessionId)).toBe(olive.userId);

    const delegated = await call("POST", "/api/delegations", { workItemId: item.id, employee: "attr-worker", task: "Take it" }, asTool(pressed.body.sessionId));
    expect(delegated.status).toBe(201);
    expect(userIdColumn(delegated.body.sessionId)).toBe(olive.userId);
  });

  it("carries no account for the bearer token, and the pressing session's own when a session presses it", async () => {
    const { createWorkItem } = await import("../../work-items/store.js");
    const olive = await joinAsOwner(h, "olive@example.test");
    const bare = createWorkItem({ title: "Bearer dispatch", source: "human" });
    const viaBearer = await call("POST", `/api/work-items/${bare.id}/dispatch`, {}, asBearer);
    expect(viaBearer.status).toBe(201);
    expect(userIdColumn(viaBearer.body.sessionId)).toBeNull();

    const chat = (await call("POST", "/api/sessions", { prompt: "olive" }, asAccount(olive))).body.id as string;
    const mine = createWorkItem({ title: "Session dispatch", source: "session", sourceRef: `session:${chat}` });
    const viaSession = await call("POST", `/api/work-items/${mine.id}/dispatch`, {}, asTool(chat));
    expect(viaSession.status).toBe(201);
    expect(userIdColumn(viaSession.body.sessionId)).toBe(olive.userId);
  });
});

describe("POST /api/sessions/:id/duplicate", () => {
  function source(owner: string | null) {
    const created = reg.createSession({ engine: "codex", source: "web", sourceRef: `web:dup-${Math.random()}`, ...(owner ? { userId: owner } : {}) });
    reg.updateSession(created.id, { engineSessionId: "engine-ref" } as never);
    return created.id;
  }

  it("attributes the copy to the account that asked for it, never to the original's owner", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const omar = await joinAsOwner(h, "omar@example.test");
    const src = source(omar.userId);

    const byOlive = await call("POST", `/api/sessions/${src}/duplicate`, undefined, asAccount(olive));
    expect(byOlive.status).toBe(200);
    expect(byOlive.body.id).not.toBe(src);
    expect(userIdColumn(byOlive.body.id)).toBe(olive.userId);

    const byBearer = await call("POST", `/api/sessions/${src}/duplicate`, undefined, asBearer);
    expect(byBearer.status).toBe(200);
    expect(userIdColumn(byBearer.body.id)).toBeNull();
  });

  it("takes the proxy identity ahead of the account, as the chat route does", async () => {
    userHeader = "X-Auth-Request-Email";
    const olive = await joinAsOwner(h, "olive@example.test");
    const copy = await call("POST", `/api/sessions/${source(null)}/duplicate`, undefined, { ...asAccount(olive), "x-auth-request-email": "sso@example.test" });
    expect(userIdColumn(copy.body.id)).toBe("sso@example.test");
  });
});

describe("the proxy identity wins on every route that starts a session", () => {
  it("a delegation from the dashboard and a Dispatch both store the forwarded identity", async () => {
    userHeader = "X-Auth-Request-Email";
    const { createWorkItem } = await import("../../work-items/store.js");
    const olive = await joinAsOwner(h, "olive@example.test");
    const proxied = { ...asAccount(olive), "x-auth-request-email": "sso@example.test" };

    const delegated = await call("POST", "/api/delegations", { employee: "attr-worker", task: "Proxied", title: "Proxied" }, proxied);
    expect(delegated.status).toBe(201);
    expect(userIdColumn(delegated.body.sessionId)).toBe("sso@example.test");

    const item = createWorkItem({ title: "Proxied dispatch", source: "human" });
    const pressed = await call("POST", `/api/work-items/${item.id}/dispatch`, {}, proxied);
    expect(pressed.status).toBe(201);
    expect(userIdColumn(pressed.body.sessionId)).toBe("sso@example.test");

    const plain = await call("POST", "/api/delegations", { employee: "attr-worker", task: "No header", title: "Plain" }, asAccount(olive));
    expect(userIdColumn(plain.body.sessionId)).toBe(olive.userId);
  });
});

describe("POST /api/todo-captures: the Shaper session", () => {
  it("is attributed to the account that captured, and to nobody for the bearer token", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const mine = await call("POST", "/api/todo-captures", { text: "capture something" }, asAccount(olive));
    expect(mine.status).toBe(201);
    expect(userIdColumn(mine.body.sessionId)).toBe(olive.userId);

    const bare = await call("POST", "/api/todo-captures", { text: "capture from a script" }, asBearer);
    expect(bare.status).toBe(201);
    expect(userIdColumn(bare.body.sessionId)).toBeNull();
  });
});

describe("GET /api/sessions/:id?messages=0: who the session is attributed to", () => {
  it("returns userId and userEmail to the instance token, null for both when unset, with parentSessionId and source", async () => {
    const olive = await joinAsOwner(h, "Olive@Example.test");
    const chat = (await call("POST", "/api/sessions", { prompt: "olive" }, asAccount(olive))).body.id as string;
    const child = (await call("POST", "/api/sessions", { prompt: "child" }, asTool(chat))).body.id as string;
    const bare = (await call("POST", "/api/sessions", { prompt: "bare" }, asBearer)).body.id as string;

    const root = await call("GET", `/api/sessions/${chat}?messages=0`, undefined, asBearer);
    expect(root.status).toBe(200);
    expect(root.body).toMatchObject({ id: chat, userId: olive.userId, userEmail: "olive@example.test", parentSessionId: null, source: "web" });

    const kid = await call("GET", `/api/sessions/${child}?messages=0`, undefined, asBearer);
    expect(kid.body).toMatchObject({ userId: olive.userId, userEmail: "olive@example.test", parentSessionId: chat, source: "web" });

    const none = await call("GET", `/api/sessions/${bare}?messages=0`, undefined, asBearer);
    expect(none.body).toMatchObject({ userId: null, userEmail: null });
  });

  it("returns a null email for a forwarded proxy identity that is not an account", async () => {
    const proxied = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:proxied-read", userId: "sso@example.test" });
    const read = await call("GET", `/api/sessions/${proxied.id}?messages=0`, undefined, asBearer);
    expect(read.body).toMatchObject({ userId: "sso@example.test", userEmail: null });
  });

  it("leaves the email out for a session caller and for a member, who read through their own routes", async () => {
    const olive = await joinAsOwner(h, "olive@example.test");
    const chat = (await call("POST", "/api/sessions", { prompt: "olive" }, asAccount(olive))).body.id as string;
    const peer = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:peer-reader", employee: "attr-worker" });

    const viaTool = await call("GET", `/api/sessions/${chat}?messages=0`, undefined, asTool(peer.id));
    expect(viaTool.body).not.toHaveProperty("userEmail");

    const member = await inviteAndAccept(h, "pat@example.test", { password: GOOD_PASSWORD });
    const viaMember = await call("GET", `/api/sessions/${chat}?messages=0`, undefined, { cookie: member.cookie });
    expect(viaMember.body).not.toHaveProperty("userEmail");
  });
});
