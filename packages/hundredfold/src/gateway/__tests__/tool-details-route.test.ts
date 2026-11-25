import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, describe, expect, it } from "vitest";
import type { HundredfoldConfig } from "../../shared/types.js";

/**
 * GET /api/sessions/:id/tool-details/:toolId answers a cut call's whole input and output, and the
 * session read hands the chat its thinking rows in order, which an agent's read leaves out.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-tool-details-route-"));
process.env.HUNDREDFOLD_HOME = home;

let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let store: typeof import("../../sessions/tool-details.js");

const config = {
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
  models: { claude: { default: "opus", models: [{ id: "opus" }] } },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
} as unknown as HundredfoldConfig;

const engineStub = { name: "stub", run: () => new Promise(() => {}), isAlive: () => false, kill: () => {}, killAll: () => {} };
const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => engineStub,
    getEngines: () => new Map([["claude", engineStub]]),
    getQueue: () => ({ getPendingCount: () => 0, getRowlessWaitingCount: () => 0, hasInFlightItem: () => false, getTransportState: (_k: string, s: string) => s }),
  },
} as unknown as import("../api.js").ApiContext;

async function get(url: string, authorization: string | undefined = "Bearer test-token"): Promise<{ status: number; body: any }> {
  let status = 200;
  let raw = "";
  const req = Object.assign(Readable.from([]), {
    method: "GET",
    url,
    headers: { host: "localhost", ...(authorization ? { authorization } : {}) },
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
  (await import("../../shared/db.js")).initDb();
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../sessions/tool-details.js");
});

describe("GET /api/sessions/:id/tool-details/:toolId", () => {
  it("answers the stored input and output, and says when the output kept is itself a head", async () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:td-1", prompt: "q" });
    store.saveToolDetail(session.id, "toolu_abc", { input: { command: "seq 1 5" }, output: "1\n2\n3\n4\n5\n", outputChars: 2_000_000, isError: true });
    const got = await get(`/api/sessions/${session.id}/tool-details/toolu_abc`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ input: { command: "seq 1 5" }, output: "1\n2\n3\n4\n5\n", outputChars: 2_000_000, isError: true });
  });

  it("omits what is not stored, and the cut lengths when nothing was cut", async () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:td-2", prompt: "q" });
    store.saveToolDetail(session.id, "call_9", { output: "only output" });
    expect((await get(`/api/sessions/${session.id}/tool-details/call_9`)).body).toEqual({ output: "only output" });
  });

  it("is a 404 for a call, a session or a call of another session with nothing stored", async () => {
    const one = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:td-3", prompt: "q" });
    const two = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:td-4", prompt: "q" });
    store.saveToolDetail(one.id, "toolu_x", { output: "x" });
    expect((await get(`/api/sessions/${one.id}/tool-details/toolu_missing`)).status).toBe(404);
    expect((await get(`/api/sessions/${two.id}/tool-details/toolu_x`)).status).toBe(404);
    expect((await get("/api/sessions/no-such-session/tool-details/toolu_x")).status).toBe(404);
  });

  it("is answered under the same rules as the session read: whoever it lets read the session reads this", async () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:td-5", prompt: "q" });
    store.saveToolDetail(session.id, "toolu_s", { output: "output" });
    for (const authorization of [undefined, "Bearer wrong"]) {
      const read = await get(`/api/sessions/${session.id}`, authorization);
      const details = await get(`/api/sessions/${session.id}/tool-details/toolu_s`, authorization);
      expect(details.status).toBe(read.status);
    }
  });
});

describe("thinking rows in the session read", () => {
  it("come in stream order for the chat, and an agent's read leaves them out", async () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:th-1", prompt: "q" });
    registry.insertMessage(session.id, "user", "q");
    registry.insertMessage(session.id, "thinking", "pondering");
    registry.insertMessage(session.id, "assistant", "answer");
    const chat = await get(`/api/sessions/${session.id}?last=50`);
    expect(chat.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "thinking", "assistant"]);
    const everything = await get(`/api/sessions/${session.id}`);
    expect(everything.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "thinking", "assistant"]);
    const agent = await get(`/api/sessions/${session.id}?last=50&thinking=0`);
    expect(agent.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    const agentAll = await get(`/api/sessions/${session.id}?last=0&thinking=0`);
    expect(agentAll.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
  });

  it("do not fill an agent's window of the last messages", async () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:th-2", prompt: "q" });
    registry.insertMessage(session.id, "user", "first");
    for (let i = 0; i < 6; i++) registry.insertMessage(session.id, "thinking", `t${i}`);
    registry.insertMessage(session.id, "assistant", "last");
    const agent = await get(`/api/sessions/${session.id}?last=2&thinking=0`);
    expect(agent.body.messages.map((m: { content: string }) => m.content)).toEqual(["first", "last"]);
  });
});

describe("what else reads the session's rows", () => {
  it("search, message context and the held-reply scan do not see thinking", () => {
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:th-3", prompt: "q" });
    registry.insertMessage(session.id, "user", "first");
    const anchor = registry.insertMessage(session.id, "assistant", "middle");
    registry.insertMessage(session.id, "thinking", "zebrafish secret musing");
    registry.insertMessage(session.id, "assistant", "last");
    expect(registry.searchMessages("zebrafish")).toEqual([]);
    expect(registry.searchSessions("zebrafish").map((s) => s.id)).not.toContain(session.id);
    const context = registry.getMessageContext(session.id, anchor, 3)!;
    expect(context.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
  });
});
