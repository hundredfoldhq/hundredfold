import { randomUUID } from "node:crypto";
import { initDb } from "../../shared/db.js";
import { createSession } from "../registry.js";
import { createWorkItem, linkSession } from "../../work-items/store.js";
import { transition } from "../../work-items/transitions.js";
import { closeWorkItemRun, listWorkItemRuns, openWorkItemRun } from "../../work-items/runs.js";
import type { JsonObject } from "../../shared/types.js";

/** A real session row, optionally with transport meta. */
export function newSession(transportMeta?: JsonObject): string {
  return createSession({
    engine: "claude",
    source: "web",
    sourceRef: `pause-notice-${randomUUID()}`,
    ...(transportMeta ? { transportMeta } : {}),
  }).id;
}

/** A Todo this session is working: executing, with an open run on the session. */
export async function workedTodo(sessionId: string): Promise<string> {
  const item = createWorkItem({ title: `todo ${randomUUID()}` });
  transition(item.id, "executing", `session:${sessionId}`);
  openWorkItemRun({ workItemId: item.id, sessionId });
  return item.id;
}

/**
 * A Todo this session executes, linked as its executor, whose first run has
 * already closed: the shape of any session past its first settled turn, since
 * later turns open no run.
 */
export async function linkedTodoRunClosed(sessionId: string, role: "execute" | "review" | "consult" = "execute"): Promise<string> {
  const item = createWorkItem({ title: `todo ${randomUUID()}` });
  linkSession(item.id, sessionId, null, role);
  transition(item.id, "executing", `session:${sessionId}`);
  openWorkItemRun({ workItemId: item.id, sessionId });
  closeRun(sessionId, item.id);
  return item.id;
}

/** Move a Todo as `actor`, optionally stamping the employee behind a session actor. */
export function move(todoId: string, to: Parameters<typeof transition>[1], actor: string, detail?: Record<string, unknown>): void {
  transition(todoId, to, actor, { ...(detail ? { detail } : {}), ...(actor === "operator" ? { human: true } : {}) });
}

/** Record the newest status event on a Todo as an escalation, the way a block loop's stop is written. */
export function markLastStatusEventEscalated(todoId: string): void {
  initDb().prepare(
    `UPDATE work_item_events SET kind = 'escalated'
      WHERE rowid = (SELECT rowid FROM work_item_events WHERE work_item_id = ? AND kind = 'status_change' ORDER BY created_at DESC, rowid DESC LIMIT 1)`,
  ).run(todoId);
}

export function closeRun(sessionId: string, todoId: string): void {
  const run = listWorkItemRuns(todoId).find((candidate) => candidate.sessionId === sessionId && candidate.endedAt === null);
  if (run) closeWorkItemRun(run.id, { outcome: "abandoned" });
}

export function metaOf(sessionId: string): Record<string, unknown> {
  const row = initDb().prepare("SELECT transport_meta FROM sessions WHERE id = ?").get(sessionId) as { transport_meta: string | null };
  return row.transport_meta ? JSON.parse(row.transport_meta) as Record<string, unknown> : {};
}

export function stampOf(sessionId: string): { at: string; kind: string } | undefined {
  return metaOf(sessionId).pausedAt as { at: string; kind: string } | undefined;
}

/** Wait out the clock's millisecond so events either side of a stamp order strictly. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 3));
}
