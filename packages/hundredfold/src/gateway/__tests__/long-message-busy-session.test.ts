import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { buildSessionTools } from "../../mcp/session-tools.js";
import { buildSearchTools } from "../../mcp/search-tools.js";
import { ensureSessionCapability } from "../../mcp/identity.js";
import type { HundredfoldMcpContext, HundredfoldMcpTool } from "../../mcp/toolkit.js";
import { sessionCommGuards } from "../session-comm-guards.js";
import { STRUCTURED_MESSAGE_BODY_MAX_CHARS } from "../../shared/types.js";

/**
 * A long message sent with send_to_session must reach its target whole, whether
 * the target is mid-turn or idle: the engine prompt carries every character, and
 * an agent that reads its own transcript (read_session, get_message_context)
 * gets the body rather than the web UI's short banner.
 *
 * Real routes, registry and MCP tools over a temp home; the engine is a stub
 * that records every prompt, and the queue holds turns until the test lets the
 * running one finish.
 */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-long-message-"));
const priorHome = process.env.HUNDREDFOLD_HOME;
process.env.HUNDREDFOLD_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "org", "lead-emp.yaml"),
  ["name: lead-emp", "department: qa", "rank: manager", "engine: codex", "model: gpt-5.5", "persona: Coordinator for route tests", ""].join("\n"),
);
fs.writeFileSync(
  path.join(tmpHome, "org", "worker-emp.yaml"),
  ["name: worker-emp", "department: qa", "rank: employee", "engine: codex", "model: gpt-5.5", "persona: Worker for route tests", ""].join("\n"),
);

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let reg: Reg;
const processFetch = globalThis.fetch;

/** Turns the engine was handed, in order. */
const enginePrompts: Array<{ sessionId: string; prompt: string }> = [];
/** Sessions whose (pretend) turn is still running. */
const turnsRunning = new Set<string>();
const engineStub = {
  name: "stub",
  run: async (opts: { sessionId: string; prompt: string }) => {
    enginePrompts.push({ sessionId: String(opts.sessionId), prompt: String(opts.prompt) });
    return { result: "ok" };
  },
  isAlive: (sessionId: string) => turnsRunning.has(sessionId),
  isTurnRunning: (sessionId: string) => turnsRunning.has(sessionId),
  kill: () => {},
  killAll: () => {},
};

/** A queue that holds every turn until `drain()`, like a session busy in a turn. */
let held: Array<() => Promise<void>> = [];
const queueStub = {
  enqueue: (_key: string, fn: () => Promise<void>) => new Promise<void>((resolve, reject) => {
    held.push(() => fn().then(resolve, reject));
  }),
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  isPaused: () => false,
  hasInFlightItem: () => false,
  holdForCallbackDrain: () => {},
  releaseCallbackDrain: () => {},
  getPendingCount: () => held.length,
  getRowlessWaitingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
async function drain(): Promise<void> {
  while (held.length > 0) {
    const next = held.shift()!;
    await next();
  }
}

const apiCtx = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    models: { codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] } },
    sessions: {},
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

/** A fetch that dispatches into handleApiRequest, headers forwarded (the MCP identity seam). */
function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? [Buffer.from(init.body)] : [];
    const headers: Record<string, string> = { host: url.host };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const req = Object.assign(Readable.from(body), { method: init?.method ?? "GET", url: url.pathname + url.search, headers });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

function ctxFor(callerSessionId: string): HundredfoldMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId,
    sessionCapability: ensureSessionCapability(callerSessionId),
  };
}

function tool(name: string): HundredfoldMcpTool {
  const found = [...buildSessionTools(), ...buildSearchTools()].find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function employeeSession(employee: string, suffix: string): string {
  return reg.createSession({
    engine: "codex",
    source: "web",
    sourceRef: `web:${employee}:${suffix}`,
    sessionKey: `web:${employee}:${suffix}`,
    connector: "web",
    employee,
    prompt: `${employee} session`,
    title: `${employee} session`,
  }).id;
}

/** A long, varied body: several paragraphs, newlines, no repetition a clip could hide behind. */
function longBody(chars: number): string {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const line = i % 7 === 6 ? "\n" : `Finding ${i}: keep section ${i} as written and re-run check ${i * 3}. `;
    parts.push(line);
    length += line.length;
  }
  return `${parts.join("").slice(0, chars - 4)}END.`;
}

/** The body between the relay header and its reply hint, as the engine reads it. */
function relayedBody(prompt: string): string {
  const start = prompt.indexOf(":\n\n") + 3;
  const end = prompt.lastIndexOf("\n\nTo reply: send_to_session");
  return prompt.slice(start, end);
}

beforeAll(async () => {
  globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => "{}" })) as unknown as typeof fetch;
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
}, 60_000);

afterAll(() => {
  globalThis.fetch = processFetch;
  if (priorHome === undefined) delete process.env.HUNDREDFOLD_HOME;
  else process.env.HUNDREDFOLD_HOME = priorHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  enginePrompts.length = 0;
  turnsRunning.clear();
  held = [];
  sessionCommGuards.reset();
});

describe("a long send_to_session message reaches its target whole", () => {
  it("to a session mid-turn: queued, then handed to the engine with every character", async () => {
    const senderId = employeeSession("lead-emp", "busy-sender");
    const targetId = employeeSession("worker-emp", "busy-target");
    reg.updateSession(targetId, { status: "running" });
    turnsRunning.add(targetId);
    const message = longBody(6_000);

    const sent = (await tool("send_to_session").handler({ sessionId: targetId, message }, ctxFor(senderId))) as { hint: string };
    expect(sent.hint).toMatch(/mid-turn/);
    // The running turn is not cut off and nothing new has reached the engine yet.
    expect(enginePrompts).toHaveLength(0);

    // The running turn ends; the queued message runs next.
    turnsRunning.delete(targetId);
    reg.updateSession(targetId, { status: "idle" });
    await drain();

    const delivered = enginePrompts.filter((run) => run.sessionId === targetId);
    expect(delivered).toHaveLength(1);
    expect(relayedBody(delivered[0]!.prompt)).toBe(message);
  });

  it("to an idle session: handed to the engine with every character", async () => {
    const senderId = employeeSession("lead-emp", "idle-sender");
    const targetId = employeeSession("worker-emp", "idle-target");
    const message = longBody(9_000);

    await tool("send_to_session").handler({ sessionId: targetId, message }, ctxFor(senderId));
    await drain();

    const delivered = enginePrompts.filter((run) => run.sessionId === targetId);
    expect(delivered).toHaveLength(1);
    expect(relayedBody(delivered[0]!.prompt)).toBe(message);
  });

  it("an agent reading its transcript mid-turn gets the body, not the banner", async () => {
    const senderId = employeeSession("lead-emp", "read-sender");
    const targetId = employeeSession("worker-emp", "read-target");
    reg.updateSession(targetId, { status: "running" });
    turnsRunning.add(targetId);
    const message = longBody(4_000);

    await tool("send_to_session").handler({ sessionId: targetId, message }, ctxFor(senderId));

    // The web UI still gets its one-line banner.
    const stored = reg.getMessages(targetId).filter((m) => m.role === "notification").at(-1)!;
    expect(stored.content.length).toBeLessThan(300);
    expect(stored.content.endsWith("…")).toBe(true);

    // The target, still in its turn, reads its own session.
    const read = (await tool("read_session").handler({ sessionId: targetId, last: 5 }, ctxFor(targetId))) as {
      messages: Array<{ role: string; content: string }>;
    };
    const relayed = read.messages.filter((m) => m.role === "notification").at(-1)!;
    expect(relayed.content).toBe(`📨 Message from session ${senderId} (lead-emp):\n\n${message}`);

    // get_message_context around it says the same.
    const context = (await tool("get_message_context").handler(
      { sessionId: targetId, messageId: stored.id, radius: 1 },
      ctxFor(targetId),
    )) as { messages: Array<{ id: string; content: string }> };
    expect(context.messages.find((m) => m.id === stored.id)!.content).toBe(relayed.content);
  });

  it("a body past the stored copy's cap still reaches the engine whole, and a reader is told the copy is clipped", async () => {
    const senderId = employeeSession("lead-emp", "huge-sender");
    const targetId = employeeSession("worker-emp", "huge-target");
    reg.updateSession(targetId, { status: "running" });
    turnsRunning.add(targetId);
    const message = longBody(STRUCTURED_MESSAGE_BODY_MAX_CHARS + 5_000);

    await tool("send_to_session").handler({ sessionId: targetId, message }, ctxFor(senderId));

    const read = (await tool("read_session").handler({ sessionId: targetId, last: 5 }, ctxFor(targetId))) as {
      messages: Array<{ role: string; content: string }>;
    };
    const relayed = read.messages.filter((m) => m.role === "notification").at(-1)!.content;
    expect(relayed).toContain(message.slice(0, STRUCTURED_MESSAGE_BODY_MAX_CHARS));
    expect(relayed).toContain(
      `[This stored copy holds the first 16,000 of ${message.length.toLocaleString("en-US")} characters. `
      + "The whole message goes to the receiving session's engine; only this copy is kept to read back.]",
    );

    turnsRunning.delete(targetId);
    reg.updateSession(targetId, { status: "idle" });
    await drain();
    const delivered = enginePrompts.filter((run) => run.sessionId === targetId);
    expect(delivered).toHaveLength(1);
    expect(relayedBody(delivered[0]!.prompt)).toBe(message);
  });
});
