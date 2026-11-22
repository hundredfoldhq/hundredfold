import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability } from "../../mcp/identity.js";

/** The voice routes through the real gateway API: who may reach them, and that voice off answers {enabled:false}. */

process.env.HUNDREDFOLD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-voice-routes-home-"));

type Api = typeof import("../api.js");
let api: Api;
let registry: typeof import("../../sessions/registry.js");
let voice: unknown;

function makeRes() {
  const chunks: Buffer[] = [];
  const cap = {
    status: 0,
    res: { writeHead(status: number) { cap.status = status; return cap.res; }, setHeader() { /* none */ }, end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); }, write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true; }, headersSent: false } as unknown as ServerResponse,
    get text() { return Buffer.concat(chunks).toString("utf-8"); },
  };
  return cap;
}

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: {} }, sessions: {}, voice }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  sessionManager: { getEngines: () => new Map(), getEngine: () => undefined, getQueue: () => ({}) },
} as unknown as import("../api.js").ApiContext;

async function request(method: string, url: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const req = Object.assign(Readable.from([]), { method, url, headers: { host: "gateway.test", ...headers } });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  let body: unknown = cap.text;
  try { body = JSON.parse(cap.text); } catch { /* not JSON */ }
  return { status: cap.status, body };
}

const operator = { authorization: "Bearer test-token" };
const asSession = (id: string) => ({
  "x-hundredfold-tool-call": "hundredfold-mcp",
  "x-hundredfold-caller-session": id,
  "x-hundredfold-session-capability": ensureSessionCapability(id)!,
});

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
}, 60_000);

describe("voice routes", () => {
  it("answers {enabled:false} to the operator while voice is off", async () => {
    voice = undefined;
    expect(await request("GET", "/api/voice/config", operator)).toEqual({ status: 200, body: { enabled: false } });
  });

  it("answers a session's read of the config too: it says nothing about any session", async () => {
    voice = { enabled: false };
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "voice-routes-reader" });
    expect(await request("GET", "/api/voice/config", asSession(session.id))).toEqual({ status: 200, body: { enabled: false } });
  });

  it("refuses starting the install to a capability-bound session, as operator-only control-plane authority", async () => {
    voice = { enabled: true };
    const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "voice-routes-install" });
    const refused = await request("POST", "/api/voice/install", asSession(session.id));
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toMatch(/operator.*control-plane/i);
  });

  it("answers the operator's install request with 409 while voice is off, and starts nothing", async () => {
    voice = { enabled: false };
    const answered = await request("POST", "/api/voice/install", operator);
    expect(answered.status).toBe(409);
    expect(answered.body.error).toMatch(/not enabled/);
  });
});
