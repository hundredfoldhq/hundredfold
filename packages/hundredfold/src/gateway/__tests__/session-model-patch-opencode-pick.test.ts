import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig } from "../../shared/types.js";
import type { ApiContext } from "../api.js";
import { readAccountPick } from "../../sessions/account-pick-meta.js";

// Isolate the registry before importing API/registry modules.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-session-model-pick-api-"));
process.env.HUNDREDFOLD_HOME = tmp;

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let reg: Reg;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  api = await import("../api.js");
  (await import("../../shared/db.js")).initDb();
}, 60_000);

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

function cfg(): HundredfoldConfig {
  return {
    gateway: { host: "127.0.0.1", port: 7795 },
    engines: {
      default: "opencode",
      claude: { bin: "claude", model: "opus" },
      opencode: {
        bin: "opencode", model: "opencode-go/glm-5",
        accounts: { "go-a": { provider: "opencode-go" }, "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY" } },
        fallback: [{ group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }] }],
      },
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", label: "Opus", supportsEffort: false, effortLevels: [] }, { id: "sonnet", label: "Sonnet", supportsEffort: false, effortLevels: [] }] },
      opencode: { default: "opencode-go/glm-5", models: ["opencode-go/glm-5", "opencode-go-b/glm-5"].map((id) => ({ id, label: id, supportsEffort: false, effortLevels: [] })) },
    },
    connectors: {},
  } as unknown as HundredfoldConfig;
}

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", authorization: "Bearer test-token" };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function ctx(transportState: "idle" | "queued" | "running" | "error" | "interrupted"): ApiContext {
  return {
    getConfig: cfg,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: vi.fn(),
    sessionManager: {
      getQueue: () => ({
        getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
        getTransportState: () => transportState,
      }),
      getEngines: () => new Map(),
    },
  } as unknown as ApiContext;
}


/** The balancer's record of a session pinned to the second member of a group. */
const PICK = {
  at: "2026-11-20T12:00:00.000Z", trigger: "start", source: "engine", groupIndex: 0, picked: "opencode/opencode-go-b", reason: "weighted",
  candidates: [
    { account: "opencode/opencode-go-b", label: "opencode · go-b", state: "fresh", weight: 60, sharePercent: 60, headroomPercent: 60 },
    { account: "opencode/opencode-go", label: "opencode · go-a", state: "fresh", weight: 40, sharePercent: 40, headroomPercent: 40 },
  ],
};

function pinned(engine: string, model: string) {
  const session = reg.createSession({ engine, source: "web", sourceRef: `web:pick-${Math.random().toString(16).slice(2)}`, model, transportMeta: { keep: "me", accountPick: PICK } as never });
  expect(readAccountPick(reg.getSession(session.id)!.transportMeta)).toMatchObject({ picked: "opencode/opencode-go-b" });
  return session;
}

async function patch(id: string, body: Record<string, unknown>) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq("PATCH", `/api/sessions/${id}`, body), cap.res, ctx("idle"));
  return cap;
}

const stored = (id: string) => reg.getSession(id)!;

describe("PATCH /api/sessions/:id with a model only, on a pinned opencode session", () => {
  it("clears the balancer's pick: a model the operator names is an account they chose", async () => {
    const session = pinned("opencode", "opencode-go-b/glm-5");
    const cap = await patch(session.id, { model: "opencode-go/glm-5" });
    expect(cap.status).toBe(200);
    expect(stored(session.id).model).toBe("opencode-go/glm-5");
    expect(stored(session.id).transportMeta).toEqual({ keep: "me" });
    expect(cap.body.transportMeta?.accountPick).toBeUndefined();
  });

  it("leaves the pick when the model stays what it was, and when only the effort level changes", async () => {
    const session = pinned("opencode", "opencode-go-b/glm-5");
    expect((await patch(session.id, { model: "opencode-go-b/glm-5" })).status).toBe(200);
    expect(readAccountPick(stored(session.id).transportMeta)).toMatchObject({ picked: "opencode/opencode-go-b" });
    expect((await patch(session.id, { title: "renamed" })).status).toBe(200);
    expect(readAccountPick(stored(session.id).transportMeta)).toMatchObject({ picked: "opencode/opencode-go-b" });
  });

  it("does not touch a pick on a session of another engine", async () => {
    const session = pinned("claude", "opus");
    expect((await patch(session.id, { model: "sonnet" })).status).toBe(200);
    expect(stored(session.id).model).toBe("sonnet");
    expect(readAccountPick(stored(session.id).transportMeta)).toMatchObject({ picked: "opencode/opencode-go-b" });
  });

  it("keeps a refused model's pick: nothing is written when the request is invalid", async () => {
    const session = pinned("opencode", "opencode-go-b/glm-5");
    expect((await patch(session.id, { model: "  " })).status).toBe(400);
    expect(readAccountPick(stored(session.id).transportMeta)).toMatchObject({ picked: "opencode/opencode-go-b" });
  });
});
