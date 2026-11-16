import { randomUUID } from "node:crypto";
import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import { getSession, listChildSessions, listSessionsByWorkItem } from "../sessions/registry.js";
import { TODO_DISPATCHER_NAME } from "../gateway/system-employees.js";
import { isSessionInFlight } from "../work-items/open-delegations.js";
import { walkWillStart } from "../work-items/quiet-children.js";
import { employeeSessionsTable } from "../work-items/employee-sessions.js";
import { disarmHeartbeat } from "./store.js";
import { HEARTBEAT_NO_CHANGE_REPLY } from "./turn-origin.js";
import type { Heartbeat } from "./types.js";

/** Heartbeat `purpose` of the gateway-owned "check your children" wake. */
export const CHILD_WATCH_PURPOSE = "child-watch";
export const CHILD_WATCH_EVERY_SECONDS = 3600;
export const CHILD_WATCH_TTL_MS = 24 * 3600 * 1000;
export const CHILD_WATCH_DISARM_REASON = "children-settled";
export const CHILD_WATCH_MESSAGE =
  "Child check (armed by the gateway because you have open child work): run get_work_item_tree on " +
  "your Todo and read the child sessions you started; act on any child that has settled. " +
  `If nothing needs you, reply with just ${HEARTBEAT_NO_CHANGE_REPLY} and end your turn: that reply stays here, ` +
  "and the session you report to is not woken for it.";

/** The Todo Dispatcher hands its Todo on and is done with it, so it has no
 *  children to watch: an hourly wake would pull it back into a Todo that now
 *  belongs to the delegate and the operator. */
function isTodoDispatcher(sessionId: string): boolean {
  return getSession(sessionId)?.employee === TODO_DISPATCHER_NAME;
}

/**
 * Arm the session's child-watch heartbeat, or push the expiry of the one it
 * holds. One transaction, so two triggers racing cannot arm two (the partial
 * unique index backs this up). The gateway's own heartbeat is exempt from
 * `MAX_ARMED_PER_SESSION`. Never throws: a trigger route must not fail
 * because a convenience wake could not be armed.
 */
export function armChildWatch(sessionId: string, now = Date.now()): void {
  try {
    if (isTodoDispatcher(sessionId)) return;
    const db = initDb();
    db.transaction(() => {
      const expiresAt = now + CHILD_WATCH_TTL_MS;
      // The message too, so a watch armed by an older build says what this one does.
      const extended = db.prepare(`
        UPDATE heartbeats SET expires_at = ?, message = ?
        WHERE owner_session_id = ? AND purpose = ? AND status = 'armed'
      `).run(expiresAt, CHILD_WATCH_MESSAGE, sessionId, CHILD_WATCH_PURPOSE);
      if (extended.changes > 0) return;
      db.prepare(`
        INSERT INTO heartbeats (
          id, owner_session_id, message, every_seconds, next_fire_at,
          fire_count, max_fires, expires_at, status, created_at, purpose
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, 'armed', ?, ?)
      `).run(
        randomUUID(), sessionId, CHILD_WATCH_MESSAGE, CHILD_WATCH_EVERY_SECONDS,
        now + CHILD_WATCH_EVERY_SECONDS * 1000, expiresAt, new Date(now).toISOString(), CHILD_WATCH_PURPOSE,
      );
    })();
  } catch (error) {
    logger.warn(`[heartbeats] child-watch for session ${sessionId} not armed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface OpenChildren {
  /** Child Todos that are `executing`, or in `backlog` with a session in flight or a start coming. */
  todoIds: string[];
  /** Child sessions of the session that are still in flight. */
  sessionIds: string[];
}

interface ChildRow { id: string; status: string; assignee: string | null }

/** How far below a Todo the watcher works itself the watch looks for children. */
const OWN_WORK_MAX_DEPTH = 8;

function isOpenChild(child: ChildRow): boolean {
  if (child.status !== "backlog") return true;
  if (walkWillStart(child)) return true;
  return listSessionsByWorkItem(child.id).some(isSessionInFlight);
}

/**
 * An `executing` child the watching session is working itself: assigned to the
 * watcher's employee, and no other session has ever been linked to it. An
 * orchestrator that splits its work into a sub-Todo and moves it to `executing`
 * itself is that Todo's only worker, so an hourly wake "about" it is a wake
 * about its own work, which nothing but the session itself will move.
 */
function isWatchersOwnWork(child: ChildRow, watcherId: string, watcherEmployee: string | null | undefined): boolean {
  if (child.status !== "executing" || !watcherEmployee || child.assignee !== watcherEmployee) return false;
  const other = employeeSessionsTable().prepare(`
    SELECT 1 FROM sessions WHERE work_item_id = ? AND id <> ?
    UNION ALL
    SELECT 1 FROM work_item_employee_sessions WHERE work_item_id = ? AND session_id <> ?
    LIMIT 1
  `).get(child.id, watcherId, child.id, watcherId);
  return other === undefined;
}

/**
 * Open children of a session: Todos in `backlog`/`executing` whose parent is the
 * session's linked Todo, or that the session created with a parent (`sourceRef`
 * `session:<id>:` / `delegate:<id>:`), plus its in-flight child sessions. A
 * parked `backlog` child (one the board walk will not start: auto-start off, the
 * operator's, or held) with no session in flight is not open: nothing moves it without a person, so a wake
 * about it can do nothing. A settled child (`blocked`, on the operator or anyone
 * else, or `in_review`) is not open either: its settling already woke the parent.
 * A child the session is working itself ({@link isWatchersOwnWork}) is looked
 * through: its own children are judged in its place.
 */
export function openChildrenOf(sessionId: string): OpenChildren {
  const db = initDb();
  const watcher = db.prepare("SELECT work_item_id, employee FROM sessions WHERE id = ?").get(sessionId) as
    { work_item_id: string | null; employee: string | null } | undefined;
  const rows = db.prepare(`
    SELECT id, status, assignee FROM work_items
    WHERE status IN ('backlog', 'executing') AND parent_id IS NOT NULL
      AND (parent_id = ? OR substr(source_ref, 1, ?) = ? OR substr(source_ref, 1, ?) = ?)
    ORDER BY id
  `).all(
    watcher?.work_item_id ?? "",
    `session:${sessionId}:`.length, `session:${sessionId}:`,
    `delegate:${sessionId}:`.length, `delegate:${sessionId}:`,
  ) as ChildRow[];
  const childrenOf = db.prepare(`
    SELECT id, status, assignee FROM work_items
    WHERE parent_id = ? AND status IN ('backlog', 'executing') ORDER BY id
  `);
  const todoIds = new Set<string>();
  const seen = new Set<string>();
  const judge = (row: ChildRow, depth: number): void => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    if (isWatchersOwnWork(row, sessionId, watcher?.employee)) {
      if (depth < OWN_WORK_MAX_DEPTH) for (const child of childrenOf.all(row.id) as ChildRow[]) judge(child, depth + 1);
    } else if (isOpenChild(row)) {
      todoIds.add(row.id);
    }
  };
  for (const row of rows) judge(row, 0);
  const sessionIds = listChildSessions(sessionId).filter(isSessionInFlight).map((child) => child.id);
  return { todoIds: [...todoIds].sort(), sessionIds };
}

/** Why a due heartbeat is a child-watch with nothing left to watch, else null. */
export function childWatchSettledReason(heartbeat: Pick<Heartbeat, "purpose" | "ownerSessionId">): string | null {
  if (heartbeat.purpose !== CHILD_WATCH_PURPOSE) return null;
  // One armed before the Dispatcher stopped getting them is disarmed rather than delivered.
  if (isTodoDispatcher(heartbeat.ownerSessionId)) return CHILD_WATCH_DISARM_REASON;
  const { todoIds, sessionIds } = openChildrenOf(heartbeat.ownerSessionId);
  return todoIds.length === 0 && sessionIds.length === 0 ? CHILD_WATCH_DISARM_REASON : null;
}

/**
 * Disarm the session's child-watch heartbeat when it has no open children, so no
 * idle wake is ever sent. Returns whether it disarmed one. Never throws.
 */
export function releaseChildWatchIfSettled(sessionId: string, now = Date.now()): boolean {
  try {
    const { todoIds, sessionIds } = openChildrenOf(sessionId);
    if (todoIds.length > 0 || sessionIds.length > 0) return false;
    const ids = initDb().prepare(`
      SELECT id FROM heartbeats WHERE owner_session_id = ? AND purpose = ? AND status = 'armed'
    `).pluck().all(sessionId, CHILD_WATCH_PURPOSE) as string[];
    for (const id of ids) disarmHeartbeat(id, CHILD_WATCH_DISARM_REASON, now);
    return ids.length > 0;
  } catch (error) {
    logger.warn(`[heartbeats] child-watch release for session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
