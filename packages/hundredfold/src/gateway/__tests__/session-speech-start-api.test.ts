import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig } from "../../shared/types.js";

/**
 * A spoken start: `POST /api/sessions` with `speech: true` and no prompt creates the session idle, for the
 * operator only. No message, no turn, no engine run; every other caller keeps the 400.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-speech-start-api-"));
process.env.HUNDREDFOLD_HOME = home;

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability } =
  await import("../../mcp/identity.js");

let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let awaiting: typeof import("../../sessions/awaiting-first-message.js");

const engineRun = vi.fn(() => new Promise(() => {}));
const engineStub = { name: "stub", run: engineRun, isAlive: () => false, kill: () => {}, killAll: () => {} };
const queueStub = {
  enqueue: async () => {}, clearCancelled: () => {}, clearQueue: () => {}, holdForCallbackDrain: () => {},
  releaseCallbackDrain: () => {}, hasInFlightItem: () => false, getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const config = {
  gateway: { port: 7798, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
  models: { claude: { default: "opus", models: [{ id: "opus" }] } },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
} as unknown as HundredfoldConfig;
const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  reloadOrg: () => {},
  sessionManager: { getEngine: () => engineStub, getEngines: () => new Map([["claude", engineStub]]), getQueue: () => queueStub },
} as unknown as import("../api.js").ApiContext;

async function post(body: unknown, opts: { caller?: string; auth?: boolean } = {}): Promise<{ status: number; body: any }> {
  let status = 200;
  let raw = "";
  const identity: Record<string, string> = opts.caller
    ? {
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: opts.caller,
        [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(opts.caller),
      }
    : {};
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST", url: "/api/sessions",
    headers: { host: "localhost", ...(opts.auth === false ? {} : { authorization: "Bearer test-token" }), "content-type": "application/json", ...identity },
  });
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, context);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

beforeAll(async () => {
  const dbModule = await import("../../shared/db.js");
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  awaiting = await import("../../sessions/awaiting-first-message.js");
  dbModule.initDb();
  const { setHundredfoldAttachGate } = await import("../../mcp/attachment.js");
  setHundredfoldAttachGate({ ok: true });
}, 60_000);

describe("POST /api/sessions without a prompt", () => {
  it("the operator's speech start creates an idle session: 201, no message, no turn", async () => {
    const created = await post({ speech: true, model: "opus" });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTruthy();
    expect(created.body.status).toBe("idle");
    expect(created.body.engine).toBe("claude");
    expect(registry.getMessages(created.body.id)).toEqual([]);
    expect(engineRun).not.toHaveBeenCalled();
    expect(awaiting.isEmptySpokenStart(created.body.id)).toBe(true);
  });

  it("the same selection checks as a prompted spawn: a bad model is still refused", async () => {
    const refused = await post({ speech: true, model: "not-a-model" });
    expect(refused.status).toBe(400);
  });

  it.each([
    ["without speech", { }],
    ["with speech false", { speech: false }],
    ["with speech as a string", { speech: "true" }],
    ["a blank prompt", { speech: true, prompt: "   " }],
  ])("%s keeps the 400", async (_name, body) => {
    const refused = await post(body);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/required|empty/);
  });

  it("a session caller keeps the 400", async () => {
    const caller = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:agent-caller", employee: null }).id;
    const refused = await post({ speech: true }, { caller });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/required/);
  });

  it("an unidentified tool call is refused", async () => {
    const refused = await post({ speech: true }, { caller: "no-such-session" });
    expect([400, 403]).toContain(refused.status);
  });

  it("an unauthenticated caller creates nothing", async () => {
    const before = registry.listSessions().length;
    const refused = await post({ speech: true }, { auth: false });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(registry.listSessions().length).toBe(before);
  });

  it("a prompted speech spawn is unchanged: message stored, turn started", async () => {
    const created = await post({ speech: true, prompt: "hello there" });
    expect(created.status).toBe(201);
    expect(registry.getMessages(created.body.id).map((m) => m.content)).toEqual(["hello there"]);
    expect(awaiting.isEmptySpokenStart(created.body.id)).toBe(false);
  });
});

describe("the first message names a spoken start", () => {
  it("sets the title and excerpt the way a prompt does, and clears the marker once", async () => {
    const created = await post({ speech: true });
    const session = registry.getSession(created.body.id)!;
    expect(session.title).toMatch(/^#\d+$/);
    awaiting.nameFromFirstMessage(session, "What is the status of the migration work?");
    const named = registry.getSession(session.id)!;
    expect(named.title).toMatch(/^#\d+ - What is the status of the migr\.\.\.$/);
    expect(named.promptExcerpt).toBe("What is the status of the migration work?");
    expect(awaiting.isAwaitingFirstMessage(named)).toBe(false);
    awaiting.nameFromFirstMessage(named, "something else");
    expect(registry.getSession(session.id)!.title).toBe(named.title);
  });

  it("a session with a message is never an empty spoken start", async () => {
    const created = await post({ speech: true });
    registry.insertMessage(created.body.id, "user", "hi");
    expect(awaiting.isEmptySpokenStart(created.body.id)).toBe(false);
  });

  it("a first message typed into a spoken start names it too, through the shared accept path", async () => {
    const created = await post({ speech: true });
    const { claimIncomingTurn } = await import("../../sessions/incoming-turn.js");
    const session = registry.getSession(created.body.id)!;
    claimIncomingTurn({
      sessionId: session.id, sessionKey: session.sessionKey || session.id, prompt: "typed with no voice attached",
      isNotification: false, role: "user", content: "typed with no voice attached",
    });
    const named = registry.getSession(session.id)!;
    expect(named.title).toMatch(/^#\d+ - typed with no voice attached$/);
    expect(named.promptExcerpt).toBe("typed with no voice attached");
    expect(awaiting.isAwaitingFirstMessage(named)).toBe(false);
  });
});
