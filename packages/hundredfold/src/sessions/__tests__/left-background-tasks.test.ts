import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-left-background-"));
process.env.HUNDREDFOLD_HOME = home;

const gatewayConfig: { resumeInterruptedSessions?: boolean } = {};
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: gatewayConfig })),
}));
vi.mock("../callback-connection.js", () => ({
  internalGatewayConnection: () => ({ baseUrl: "http://left-background-fixture.invalid" }),
  internalGatewayHeaders: () => ({ "Content-Type": "application/json" }),
}));

type Registry = typeof import("../registry.js");
let registry: Registry;
let left: typeof import("../left-background-tasks.js");
let lost: typeof import("../lost-background-tasks.js");
let callbacks: typeof import("../callbacks.js");
let db: import("better-sqlite3").Database;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  registry = await import("../registry.js");
  left = await import("../left-background-tasks.js");
  lost = await import("../lost-background-tasks.js");
  callbacks = await import("../callbacks.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM callback_deliveries").run();
  db.prepare("DELETE FROM sessions").run();
  delete gatewayConfig.resumeInterruptedSessions;
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  callbacks.__resetCallbackRetrySweepForTest();
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const TEST_RUN = { id: "bk2tests1", kind: "process" as const, command: "npm test", description: "Run the tests", agentType: null };
const WATCH = { id: "bk2watch2", kind: "monitor" as const, command: "tail -f build.log", description: null, agentType: null };

function idleSession() {
  return registry.createSession({ engine: "claude", source: "web", sourceRef: `web:${Math.random()}` });
}

function owed(sessionId: string) {
  return left.readLeftBackgroundTasks(registry.getSession(sessionId)!);
}

describe("a session stopped under a background command", () => {
  it("is not woken, and keeps the task for its next explicit turn", () => {
    const session = idleSession();

    lost.handleLostBackgroundTasks(session.id, [TEST_RUN], "stopped");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get()).toEqual({ n: 0 });
    expect(owed(session.id)).toEqual([expect.objectContaining({ id: "bk2tests1", kind: "process", command: "npm test", reason: "stopped" })]);
  });

  it("names the task on that turn, ahead of the message, and stops being owed once carried", () => {
    const session = idleSession();
    lost.handleLostBackgroundTasks(session.id, [TEST_RUN], "stopped");

    const carried = left.withLeftBackgroundTasksNote(registry.getSession(session.id)!, "run the build now");

    expect(carried.carriedLeftBackgroundTaskIds).toEqual(["bk2tests1"]);
    expect(carried.promptToRun).toMatch(/^\[Gateway\] A background task this session started was still running when its engine process ended \(the session was stopped\)/);
    expect(carried.promptToRun).toContain("- bk2tests1 (background Bash): Run the tests: `npm test`");
    expect(carried.promptToRun.endsWith("\n\nrun the build now")).toBe(true);

    const cleared = left.withLeftBackgroundTasksCleared(registry.getSession(session.id)!.transportMeta, carried.carriedLeftBackgroundTaskIds);
    registry.updateSession(session.id, { transportMeta: cleared as never });
    expect(owed(session.id)).toEqual([]);
    // Nothing owed: the next prompt goes through as written, so the note is never repeated.
    expect(left.withLeftBackgroundTasksNote(registry.getSession(session.id)!, "and again")).toEqual({
      promptToRun: "and again", carriedLeftBackgroundTaskIds: [],
    });
  });

  it("keeps a task recorded after a turn composed its prompt when that turn's tasks are cleared", () => {
    const session = idleSession();
    left.recordLeftBackgroundTasks(session.id, [TEST_RUN], "stopped");
    const carried = left.withLeftBackgroundTasksNote(registry.getSession(session.id)!, "go");

    left.recordLeftBackgroundTasks(session.id, [WATCH], "stopped");
    const cleared = left.withLeftBackgroundTasksCleared(registry.getSession(session.id)!.transportMeta, carried.carriedLeftBackgroundTaskIds);

    expect(left.readLeftBackgroundTasks({ transportMeta: cleared as never }).map((entry) => entry.id)).toEqual(["bk2watch2"]);
  });

  it("records a task once however often it is reported, and caps what it keeps", () => {
    const session = idleSession();
    left.recordLeftBackgroundTasks(session.id, [TEST_RUN], "stopped");
    left.recordLeftBackgroundTasks(session.id, [TEST_RUN, WATCH], "stopped");
    expect(owed(session.id).map((entry) => entry.id)).toEqual(["bk2tests1", "bk2watch2"]);

    const many = Array.from({ length: 30 }, (_, index) => ({ ...TEST_RUN, id: `bulk-${index}` }));
    left.recordLeftBackgroundTasks(session.id, many, "stopped");
    const kept = owed(session.id).map((entry) => entry.id);
    expect(kept).toHaveLength(20);
    expect(kept.at(-1)).toBe("bulk-29");
  });

  it("records nothing for an unknown session or an empty list", () => {
    expect(left.recordLeftBackgroundTasks("no-such-session", [TEST_RUN], "stopped")).toBe(false);
    const session = idleSession();
    expect(left.recordLeftBackgroundTasks(session.id, [], "stopped")).toBe(false);
    expect(owed(session.id)).toEqual([]);
  });
});

describe("a session whose process was lost without being stopped", () => {
  it("is woken with the continue turn, and has nothing further owed", async () => {
    const session = idleSession();

    lost.handleLostBackgroundTasks(session.id, [TEST_RUN], "ended");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).message).toContain("bk2tests1");
    expect(owed(session.id)).toEqual([]);
  });

  it("is not told again of a loss its nudge already reported", async () => {
    const session = idleSession();

    lost.handleLostBackgroundTasks(session.id, [TEST_RUN, WATCH], "ended");
    lost.handleLostBackgroundTasks(session.id, [WATCH, TEST_RUN], "ended");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(owed(session.id)).toEqual([]);
  });

  it("keeps the task for its next turn when the nudge is withheld by the rate limit", async () => {
    const session = idleSession();
    lost.handleLostBackgroundTasks(session.id, [TEST_RUN], "ended");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    lost.handleLostBackgroundTasks(session.id, [WATCH], "ended");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(owed(session.id)).toEqual([expect.objectContaining({ id: "bk2watch2", reason: "not-nudged" })]);
    expect(left.withLeftBackgroundTasksNote(registry.getSession(session.id)!, "hi").promptToRun)
      .toContain("- bk2watch2 (Monitor): `tail -f build.log`");
  });

  it("keeps the task for its next turn when resuming interrupted sessions is switched off", () => {
    gatewayConfig.resumeInterruptedSessions = false;
    const session = idleSession();

    lost.handleLostBackgroundTasks(session.id, [TEST_RUN], "ended");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(owed(session.id).map((entry) => entry.id)).toEqual(["bk2tests1"]);
  });
});

describe("a session moved to another account or engine under a background task", () => {
  it("is not woken, and keeps the task as moved", () => {
    const session = idleSession();

    lost.handleLostBackgroundTasks(session.id, [WATCH], "moved");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get()).toEqual({ n: 0 });
    expect(owed(session.id)).toEqual([expect.objectContaining({ id: "bk2watch2", kind: "monitor", reason: "moved" })]);
  });

  it("tells the session its process was replaced and to re-arm what it still needs", () => {
    const session = idleSession();
    lost.handleLostBackgroundTasks(session.id, [WATCH, TEST_RUN], "moved");

    const { promptToRun, carriedLeftBackgroundTaskIds } = left.withLeftBackgroundTasksNote(registry.getSession(session.id)!, "carry on");

    expect(carriedLeftBackgroundTaskIds).toEqual(["bk2watch2", "bk2tests1"]);
    expect(promptToRun).toMatch(/^\[Gateway\] 2 background tasks this session started were held by an engine process that was replaced when the session moved to another account or engine after a usage limit/);
    expect(promptToRun).toContain("- bk2watch2 (Monitor): `tail -f build.log`");
    expect(promptToRun).toContain("- bk2tests1 (background Bash): Run the tests: `npm test`");
    expect(promptToRun).toMatch(/Re-arm any Monitor you still need, and re-run background work that is still needed once you have checked/);
    expect(promptToRun.endsWith("\n\ncarry on")).toBe(true);
  });

  it("reads as moved only when every entry is, and as the generic note otherwise", () => {
    const session = idleSession();
    left.recordLeftBackgroundTasks(session.id, [TEST_RUN], "stopped");
    left.recordLeftBackgroundTasks(session.id, [WATCH], "moved");

    const note = left.leftBackgroundTasksNote(owed(session.id));

    expect(note).toMatch(/^\[Gateway\] 2 background tasks this session started were still running when its engine process ended/);
    expect(note).not.toContain("moved to another account or engine");
  });

  it("is stripped from a prompt read back from the engine's transcript, with or without a message after it", () => {
    const session = idleSession();
    lost.handleLostBackgroundTasks(session.id, [WATCH], "moved");
    const entries = owed(session.id);

    const note = left.leftBackgroundTasksNote(entries);
    expect(left.withoutLeftBackgroundNote(`${note}\n\nrun the build now`)).toBe("run the build now");
    expect(left.withoutLeftBackgroundNote(note)).toBe("");

    const many = left.leftBackgroundTasksNote([...entries, { ...entries[0]!, id: "other-2" }]);
    expect(left.withoutLeftBackgroundNote(`${many}\n\nhello`)).toBe("hello");
  });

  it("reads an entry with a reason it does not know as not nudged", () => {
    const session = idleSession();
    registry.updateSession(session.id, {
      transportMeta: { leftBackgroundTasks: [{ id: "x1", kind: "monitor", reason: "something-new", at: "" }] } as never,
    });
    expect(owed(session.id)).toEqual([expect.objectContaining({ id: "x1", reason: "not-nudged" })]);
  });
});
