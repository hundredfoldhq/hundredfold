import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig, StreamDelta } from "../../shared/types.js";

/**
 * A view opened while a turn streams joins the read's text to the live deltas that
 * follow. The turn's writer stamps every text delta with its block and offset, and
 * the read reports the block being streamed from the writer itself, in the same tick
 * as the stored rows, rather than from the stored row that trails it by one flush.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-live-stream-read-"));
process.env.HUNDREDFOLD_HOME = home;

let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let partial: typeof import("../../sessions/partial-stream.js");

const config = {
  gateway: { port: 7798, host: "127.0.0.1" },
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

async function read(sessionId: string): Promise<{ status: number; body: any }> {
  let status = 200;
  let raw = "";
  const req = Object.assign(Readable.from([]), {
    method: "GET",
    url: `/api/sessions/${sessionId}?last=50`,
    headers: { host: "localhost", authorization: "Bearer test-token" },
  });
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, context);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

function runningSession(attemptToken: string): string {
  const session = registry.createSession({ engine: "claude", source: "web", sourceRef: `web:${attemptToken}`, prompt: "q" });
  registry.insertMessage(session.id, "user", "q");
  registry.updateSession(session.id, { status: "running", attemptToken });
  return session.id;
}

const text = (content: string): StreamDelta => ({ type: "text", content });

beforeAll(async () => {
  (await import("../../shared/db.js")).initDb();
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  partial = await import("../../sessions/partial-stream.js");
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

describe("the partial writer stamps where each delta sits", () => {
  it("numbers text by its block and offset, and a main tool call ends the block it names", () => {
    const sessionId = runningSession("stamp-1");
    const writer = partial.createPartialStreamWriter(sessionId, "stamp-1");
    const first = writer.persist(text("Let me "));
    const second = writer.persist(text("check."));
    expect(second).toMatchObject({ streamBlock: first.streamBlock, offset: 7 });
    expect(first.offset).toBe(0);

    const sidechain = writer.persist({ type: "tool_use", content: "", toolName: "Read", sidechain: true });
    expect(sidechain.streamBlock).toBeUndefined();
    expect(writer.persist(text(" More")).offset).toBe(13);

    const tool = writer.persist({ type: "tool_use", content: "", toolName: "Bash" });
    expect(tool.streamBlock).toBe(first.streamBlock);
    const next = writer.persist(text("Next"));
    expect(next.streamBlock).toBeGreaterThan(first.streamBlock!);
    expect(next.offset).toBe(0);

    const snapshot = writer.persist({ type: "text_snapshot", content: "Rewritten" });
    expect(snapshot).toMatchObject({ streamBlock: next.streamBlock, offset: 0 });
    expect(writer.persist(text("!")).offset).toBe("Rewritten".length);
    writer.finish();
  });

  it("ends the block at a block delta, and leaves other deltas unstamped", () => {
    const sessionId = runningSession("stamp-2");
    const writer = partial.createPartialStreamWriter(sessionId, "stamp-2");
    const first = writer.persist(text("Before"));
    expect(writer.persist({ type: "status", content: "thinking" }).streamBlock).toBeUndefined();
    const block = writer.persist({
      type: "block",
      content: "card",
      block: {
        op: "put",
        block: { id: "plan-1", type: "task-list", version: 1, sourceEngine: "hermes", payload: { items: [{ id: "a", text: "card", status: "done" }] } },
      } as never,
    });
    expect(block.streamBlock).toBe(first.streamBlock);
    expect(writer.persist(text("After")).offset).toBe(0);
    writer.finish();
  });
});

describe("the live writer registry", () => {
  it("keeps a newer attempt's writer when an older one finishes after it started", () => {
    const sessionId = runningSession("overlap-new");
    const older = partial.createPartialStreamWriter(sessionId, "overlap-old");
    older.persist(text("old"));
    const newer = partial.createPartialStreamWriter(sessionId, "overlap-new");
    newer.persist(text("new"));
    older.finish();
    expect(partial.getLiveStreamBlock(sessionId, "overlap-new")).toMatchObject({ text: "new" });
    newer.finish();
    expect(partial.getLiveStreamBlock(sessionId, "overlap-new")).toBeNull();
  });
});

describe("GET /api/sessions/:id while a turn streams", () => {
  it("serves the block's whole text ahead of the debounced stored row, with the row's id", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sessionId = runningSession("read-1");
    const writer = partial.createPartialStreamWriter(sessionId, "read-1");
    const first = writer.persist(text("Let me check the fi"));
    vi.advanceTimersByTime(600);
    writer.persist(text("le first."));

    const { status, body } = await read(sessionId);
    expect(status).toBe(200);
    const stored = body.messages.find((m: { partial?: boolean }) => m.partial);
    expect(body.liveStream).toEqual({ block: first.streamBlock, text: "Let me check the file first.", messageId: stored.id });
    // The stored row reads as the live text, not the flush it trails.
    expect(stored.content).toBe("Let me check the file first.");
    writer.finish();
  });

  it("reports the block before its first flush, with no stored row yet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sessionId = runningSession("read-2");
    const writer = partial.createPartialStreamWriter(sessionId, "read-2");
    const first = writer.persist(text("Let me"));

    const { body } = await read(sessionId);
    expect(body.liveStream).toEqual({ block: first.streamBlock, text: "Let me", messageId: null });
    expect(body.messages.some((m: { partial?: boolean }) => m.partial)).toBe(false);
    writer.finish();
  });

  it("reports nothing once the engine run is over, or for a writer of an earlier attempt", async () => {
    const sessionId = runningSession("read-3");
    const writer = partial.createPartialStreamWriter(sessionId, "read-3");
    writer.persist(text("Finished text"));
    writer.finish();
    expect((await read(sessionId)).body.liveStream).toBeUndefined();

    // A stray delta after the run re-registers that writer, but the session has moved on.
    writer.persist(text(" late"));
    registry.updateSession(sessionId, { attemptToken: "read-3-next" });
    expect((await read(sessionId)).body.liveStream).toBeUndefined();
    expect(partial.getLiveStreamBlock(sessionId, "read-3")).not.toBeNull();
    writer.finish();
  });

  it("reports nothing for a session that is not running", async () => {
    const sessionId = runningSession("read-4");
    const writer = partial.createPartialStreamWriter(sessionId, "read-4");
    writer.persist(text("Some text"));
    registry.updateSession(sessionId, { status: "idle" });
    expect((await read(sessionId)).body.liveStream).toBeUndefined();
    writer.finish();
  });
});
