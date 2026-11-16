import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from HUNDREDFOLD_HOME at module load). Keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-wi-pause-in-flight-"));
process.env.HUNDREDFOLD_HOME = tmp;

vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: {} })),
}));

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Runs = typeof import("../runs.js");
type Reconcile = typeof import("../reconcile.js");
type Registry = typeof import("../../sessions/registry.js");
type Stopped = typeof import("../../sessions/stopped-marker.js");
type Window = typeof import("../../sessions/restart-resume-window.js");
type OwedTurns = typeof import("../../sessions/owed-turns.js");

let store: Store;
let transitions: Transitions;
let runs: Runs;
let reconcile: Reconcile;
let registry: Registry;
let stopped: Stopped;
let resumeWindow: Window;
let owedTurns: OwedTurns;
let db: import("better-sqlite3").Database;

const T0 = Date.parse("2026-11-16T09:00:00.000Z");

beforeAll(async () => {
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  runs = await import("../runs.js");
  reconcile = await import("../reconcile.js");
  registry = await import("../../sessions/registry.js");
  stopped = await import("../../sessions/stopped-marker.js");
  resumeWindow = await import("../../sessions/restart-resume-window.js");
  owedTurns = await import("../../sessions/owed-turns.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  // One scenario at a time: earlier tests' rows must not keep a later session owed a turn.
  db.prepare("UPDATE queue_items SET status = 'completed'").run();
  db.prepare("UPDATE callback_deliveries SET status = 'accepted'").run();
});

afterEach(() => {
  vi.useRealTimers();
});

interface Subject {
  todoId: string;
  sessionId: string;
  runId: string;
}

let counter = 0;

/** An `executing` Todo and the idle session that works it, with its run open. */
function executingTodo(): Subject {
  const tag = `pause-${++counter}`;
  const item = store.createWorkItem({ title: `todo ${tag}`, status: "executing", source: "delegation" });
  const sessionId = `s-${tag}`;
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, session_key, status, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'web', ?, ?, 'idle', ?, '2026-11-16T08:59:00.000Z', '2026-11-16T08:59:00.000Z')`,
  ).run(sessionId, `delegation:${item.id}:${sessionId}`, `web:${sessionId}`, item.id);
  const run = runs.openWorkItemRun({ workItemId: item.id, sessionId });
  return { todoId: item.id, sessionId, runId: run.id };
}

/** The turn that just ended settled with this receipt. */
function settle(subject: Subject, outcome: "succeeded" | "failed" | "interrupted"): void {
  const status = outcome === "succeeded" ? "idle" : outcome === "failed" ? "error" : "interrupted";
  vi.setSystemTime(Date.now() + 1_000);
  registry.updateSession(subject.sessionId, {
    status,
    attemptOutcome: outcome,
    lastActivity: new Date().toISOString(),
    lastError: outcome === "succeeded" ? null : "the turn ended badly",
  });
}

/** The next turn starts: a new attempt, session `running`. */
function turnStarts(subject: Subject): void {
  vi.setSystemTime(Date.now() + 1_000);
  registry.beginSessionAttempt(subject.sessionId, { lastActivity: new Date().toISOString() });
}

function queueRow(subject: Subject, status: "pending" | "running" | "completed"): string {
  const id = registry.enqueueQueueItem(subject.sessionId, `web:${subject.sessionId}`, "the resume turn");
  if (status !== "pending") db.prepare("UPDATE queue_items SET status = ? WHERE id = ?").run(status, id);
  return id;
}

function resumeDelivery(subject: Subject, status: "pending" | "accepted" = "pending"): string {
  const { delivery } = registry.claimSessionDelivery({
    targetSessionId: subject.sessionId,
    sourceKind: "session",
    sourceId: subject.sessionId,
    sourceAttempt: `self-compaction:${++counter}`,
    sourceOutcome: "compaction-requested",
    sourceVersion: 1,
    deliveryKind: "self-compaction-resume",
    payload: { message: "carry on", displayMessage: "carry on" },
  });
  if (status === "accepted") db.prepare("UPDATE callback_deliveries SET status = 'accepted' WHERE id = ?").run(delivery.id);
  return delivery.id;
}

/** One tick of the periodic reconciler. */
function sweep(): void {
  reconcile.reconcileActiveWorkItems();
  runs.closeRunsForSettledSessions();
}

function statusOf(subject: Subject): string | undefined {
  return store.getWorkItem(subject.todoId)?.status;
}

function eventKinds(subject: Subject): string[] {
  return (db.prepare("SELECT kind FROM work_item_events WHERE work_item_id = ? ORDER BY created_at, rowid").all(subject.todoId) as { kind: string }[])
    .map((row) => row.kind);
}

function blockedMoves(subject: Subject): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM work_item_events WHERE work_item_id = ? AND to_status = 'blocked'").get(subject.todoId) as { n: number }).n;
}

function blockRow(subject: Subject): { kind: string; recurrences: number } | undefined {
  return db.prepare("SELECT kind, recurrences FROM work_item_blocks WHERE work_item_id = ?").get(subject.todoId) as
    { kind: string; recurrences: number } | undefined;
}

function runOutcome(subject: Subject): { endedAt: string | null; outcome: string | null } {
  const [run] = runs.listWorkItemRuns(subject.todoId);
  return { endedAt: run.endedAt, outcome: run.outcome };
}

describe("a self-compaction pause", () => {
  it("stays executing while the /compact turn has failed and the resume is queued", () => {
    const s = executingTodo();
    settle(s, "failed");
    queueRow(s, "pending");

    sweep();

    expect(statusOf(s)).toBe("executing");
    expect(runOutcome(s)).toMatchObject({ endedAt: null, outcome: null });
    expect(eventKinds(s)).not.toContain("escalated");
  });

  it("stays executing while the resume row is running and the session row still shows the failed receipt", () => {
    const s = executingTodo();
    settle(s, "failed");
    queueRow(s, "running");

    sweep();

    expect(statusOf(s)).toBe("executing");
    expect(runOutcome(s).endedAt).toBeNull();
  });

  it("stays executing while only the outbox still holds the resume delivery", () => {
    const s = executingTodo();
    settle(s, "failed");
    resumeDelivery(s, "pending");

    sweep();

    expect(statusOf(s)).toBe("executing");
    expect(runOutcome(s).endedAt).toBeNull();
  });

  it("stays executing once the rows are done and the resume settled cleanly", () => {
    const s = executingTodo();
    settle(s, "failed");
    queueRow(s, "pending");
    sweep();

    turnStarts(s);
    db.prepare("UPDATE queue_items SET status = 'completed'").run();
    settle(s, "succeeded");
    sweep();

    expect(statusOf(s)).toBe("executing");
    expect(runOutcome(s)).toMatchObject({ outcome: "completed" });
  });

  it("leaves the run of a cancelled Todo open for the run-ledger sweep while the resume is owed, then closes it", () => {
    const s = executingTodo();
    transitions.transition(s.todoId, "cancelled", "operator");
    settle(s, "failed");
    const row = queueRow(s, "pending");

    expect(statusOf(s)).toBe("cancelled");
    expect(runs.closeRunsForSettledSessions()).toBe(0);
    expect(runOutcome(s).endedAt).toBeNull();

    db.prepare("UPDATE queue_items SET status = 'completed' WHERE id = ?").run(row);
    expect(runs.closeRunsForSettledSessions()).toBe(1);
    expect(runOutcome(s)).toMatchObject({ outcome: "blocked" });
  });

  it("still blocks when the rows are done and the newest receipt is a genuine failure", () => {
    const s = executingTodo();
    settle(s, "failed");
    queueRow(s, "completed");
    resumeDelivery(s, "accepted");

    sweep();

    expect(statusOf(s)).toBe("blocked");
    expect(runOutcome(s)).toMatchObject({ outcome: "blocked" });
  });

  it("blocks a session whose owed turn belongs to some other session", () => {
    const s = executingTodo();
    const other = executingTodo();
    settle(s, "failed");
    queueRow(other, "pending");
    resumeDelivery(other, "pending");

    sweep();

    expect(statusOf(s)).toBe("blocked");
  });
});

describe("a gateway or engine restart", () => {
  it("stays executing for an interrupted turn whose queue row is back to pending, with no restart window", () => {
    const s = executingTodo();
    settle(s, "interrupted");
    queueRow(s, "pending");

    const session = registry.getSession(s.sessionId)!;
    // Nothing in the restart window speaks for this turn, so the old reading settles it.
    expect(resumeWindow.settledAttemptOutcome(session)).toBe("interrupted");

    sweep();

    expect(statusOf(s)).toBe("executing");
    expect(runOutcome(s).endedAt).toBeNull();
  });

  it("stays executing when the restart nudge's grace has expired but the row is pending", () => {
    const s = executingTodo();
    settle(s, "interrupted");
    registry.updateSession(s.sessionId, { transportMeta: {} });
    resumeWindow.stampRestartResumeDue(s.sessionId, new Date(T0 - 10 * 60_000).toISOString());
    queueRow(s, "pending");

    const session = registry.getSession(s.sessionId)!;
    expect(resumeWindow.awaitsRestartResume(session)).toBe(false);

    sweep();

    expect(statusOf(s)).toBe("executing");
  });

  it("still blocks an interrupted turn with nothing queued once the window is gone", () => {
    const s = executingTodo();
    settle(s, "interrupted");

    sweep();

    expect(statusOf(s)).toBe("blocked");
    expect(runOutcome(s)).toMatchObject({ outcome: "abandoned" });
  });
});

describe("a usage-limit pause", () => {
  it("keeps a waiting session executing", () => {
    const s = executingTodo();
    registry.updateSession(s.sessionId, { status: "waiting", lastActivity: new Date(T0 + 1_000).toISOString() });

    sweep();

    expect(statusOf(s)).toBe("executing");
  });

  it("keeps executing when a restart interrupted the waiting session and its row is back to pending", () => {
    const s = executingTodo();
    registry.updateSession(s.sessionId, { status: "waiting", lastActivity: new Date(T0 + 1_000).toISOString() });
    sweep();
    settle(s, "interrupted");
    queueRow(s, "pending");

    sweep();

    expect(statusOf(s)).toBe("executing");
  });

  it("blocks when the restart interrupted the waiting session and nothing is owed", () => {
    const s = executingTodo();
    registry.updateSession(s.sessionId, { status: "waiting", lastActivity: new Date(T0 + 1_000).toISOString() });
    sweep();
    settle(s, "interrupted");

    sweep();

    expect(statusOf(s)).toBe("blocked");
  });
});

describe("a session the operator stopped", () => {
  it("blocks even while a callback delivery to it is pending", () => {
    const s = executingTodo();
    settle(s, "interrupted");
    stopped.markSessionStopped(s.sessionId);
    resumeDelivery(s, "pending");

    expect(owedTurns.gatewayOwesTurn(s.sessionId)).toBe(false);
    sweep();

    expect(statusOf(s)).toBe("blocked");
    expect(runOutcome(s)).toMatchObject({ outcome: "abandoned" });
  });

  it("blocks even while a queue row is pending", () => {
    const s = executingTodo();
    settle(s, "interrupted");
    stopped.markSessionStopped(s.sessionId);
    queueRow(s, "pending");

    sweep();

    expect(statusOf(s)).toBe("blocked");
  });

  it("owes a turn again once someone starts the session on purpose", () => {
    const s = executingTodo();
    stopped.markSessionStopped(s.sessionId);
    stopped.clearSessionStopped(s.sessionId);
    resumeDelivery(s, "pending");

    expect(owedTurns.gatewayOwesTurn(s.sessionId)).toBe(true);
  });
});

describe("the block-loop breaker", () => {
  function pauseCycle(s: Subject): void {
    settle(s, "failed");
    const row = queueRow(s, "pending");
    sweep();
    expect(statusOf(s)).toBe("executing");
    turnStarts(s);
    sweep();
    db.prepare("UPDATE queue_items SET status = 'completed' WHERE id = ?").run(row);
    settle(s, "succeeded");
    sweep();
    expect(statusOf(s)).toBe("executing");
  }

  it("never counts three consecutive pauses", () => {
    const s = executingTodo();

    pauseCycle(s);
    pauseCycle(s);
    pauseCycle(s);

    expect(blockRow(s)).toBeUndefined();
    expect(eventKinds(s)).not.toContain("escalated");
    expect(blockedMoves(s)).toBe(0);
    expect(statusOf(s)).toBe("executing");
  });

  it("leaves the recurrence count of an earlier genuine block unchanged", () => {
    const s = executingTodo();
    settle(s, "failed");
    sweep();
    expect(statusOf(s)).toBe("blocked");
    const before = blockRow(s);
    expect(before).toMatchObject({ kind: "transient" });

    // The retry runs and succeeds, which releases the block.
    turnStarts(s);
    settle(s, "succeeded");
    sweep();
    expect(statusOf(s)).toBe("executing");

    pauseCycle(s);
    pauseCycle(s);
    pauseCycle(s);

    expect(blockRow(s)).toEqual(before);
    expect(eventKinds(s)).not.toContain("escalated");
  });

  it("still escalates genuine repeated failures", () => {
    const s = executingTodo();
    for (let i = 0; i < 3; i++) {
      settle(s, "failed");
      sweep();
      expect(statusOf(s)).toBe("blocked");
      turnStarts(s);
      settle(s, "succeeded");
      sweep();
    }

    expect(eventKinds(s)).toContain("escalated");
  });
});
