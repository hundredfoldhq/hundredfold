import { initDb } from "../shared/db.js";
import { isCompactCommand } from "../shared/skill-commands.js";
import { isAutoCompacting } from "./auto-compaction.js";

/**
 * The prompts of the turns a session is running or has accepted and not yet
 * started, with the running ones first. Internal rows count: a compaction a
 * session asked for itself (`compact_session`) is queued as a notification.
 */
function openTurnPrompts(sessionId: string, statuses: readonly ("running" | "pending")[]): string[] {
  const db = initDb();
  const marks = statuses.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT prompt FROM queue_items WHERE session_id = ? AND status IN (${marks})`)
    .all(sessionId, ...statuses) as Array<{ prompt: string }>;
  return rows.map((row) => row.prompt);
}

/** Whether the session is compacting right now: an automatic compaction in front of its message, or a running `/compact` turn. */
export function compactionRunning(sessionId: string): boolean {
  return isAutoCompacting(sessionId) || openTurnPrompts(sessionId, ["running"]).some(isCompactCommand);
}

/**
 * Whether a compaction is under way for the session, or next in line for it: an
 * automatic one in front of its message, or an operator's or the session's own
 * `/compact` turn, running or queued. A compaction runs to completion, so a new
 * message waits behind it rather than cutting it off (a running one would be
 * thrown away half-done and never shrink the context) or jumping ahead of it
 * (a queued one would be folded into or run behind the message). A stop still stops it.
 */
export function compactionInFlight(sessionId: string): boolean {
  return isAutoCompacting(sessionId) || openTurnPrompts(sessionId, ["running", "pending"]).some(isCompactCommand);
}
