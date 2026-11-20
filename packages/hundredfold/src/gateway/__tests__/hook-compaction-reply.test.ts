import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest, type ApiContext } from "../api.js";
import { HookRegistry } from "../hook-registry.js";
import { wireHeader, hookSessionIdKey } from "../../shared/wire-names.js";
import { BOARD_REMINDER_LABEL } from "../../sessions/turn/board-reminder.js";
import { rememberCompactionReminder, resetCompactionRemindersForTests } from "../../sessions/turn/compaction-reminder.js";

vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const SECRET = "relay-secret";
const SESSION = "session-under-test";

function post(hook: Record<string, unknown>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify({ [hookSessionIdKey()]: SESSION, hook }))]) as IncomingMessage;
  req.method = "POST";
  req.url = "/api/internal/hook";
  req.headers = { host: "127.0.0.1:7799", [wireHeader("hook-secret")]: SECRET };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return req;
}

async function relay(hook: Record<string, unknown>): Promise<{ status: number; body: any }> {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    setHeader() { return this; },
    writeHead(s: number) { status = s; return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.from(buf)); return this; },
  } as unknown as ServerResponse;
  const registry = new HookRegistry();
  const context = {
    hookRegistry: registry, hookSecret: SECRET, getConfig: () => ({ gateway: { host: "127.0.0.1" }, engines: { default: "claude" } }),
    connectors: new Map(), startTime: Date.now(),
  } as unknown as ApiContext;
  await handleApiRequest(post(hook), res, context);
  registry.dispose();
  return { status, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) };
}

beforeEach(resetCompactionRemindersForTests);

describe("POST /api/internal/hook after a compaction", () => {
  it("answers the SessionStart that follows a compaction with the reminder for the relay to print", async () => {
    rememberCompactionReminder(SESSION, "Board: one.");
    const reply = await relay({ hook_event_name: "SessionStart", source: "compact", session_id: "engine-1" });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      message: "ok",
      hookOutput: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${BOARD_REMINDER_LABEL} Board: one.` } },
    });
  });

  it.each([
    ["a fresh start", { hook_event_name: "SessionStart", source: "startup" }],
    ["a resume", { hook_event_name: "SessionStart", source: "resume" }],
    ["a Stop", { hook_event_name: "Stop" }],
    ["a PostCompact", { hook_event_name: "PostCompact", trigger: "auto" }],
  ])("answers %s with nothing to print", async (_name, hook) => {
    rememberCompactionReminder(SESSION, "Board: one.");
    const reply = await relay(hook);
    expect(reply.body).toEqual({ message: "ok" });
  });

  it("answers a compaction in a session with no reminder with nothing to print", async () => {
    const reply = await relay({ hook_event_name: "SessionStart", source: "compact" });
    expect(reply.body).toEqual({ message: "ok" });
  });
});
