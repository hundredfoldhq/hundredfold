import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";
import { getWorkItem } from "../work-items/store.js";
import { parseMetaColumn } from "./message-row.js";
import { asksOrReportsBlocker } from "./stop-nudge.js";

/**
 * A session whose Todo is over is still the parent of the sessions it spawned,
 * and those get reused: another session sends them work, and one of them may
 * report to the spawner after all. The spawner then wakes for a report about a
 * task that is not its own, and ends its turn with "nothing for me". Relaying
 * that to the session above it wakes that one too, to read that nothing happened.
 *
 * So the reply of such a turn stays in the session's own chat. It is a filter
 * that errs toward relaying: the Todo must be over, every message the turn
 * answers must be a child's report, and a reply that asks something or reports
 * a blocker always goes out.
 */

/** How far back a settled turn looks for the messages that prompted it. */
const PROMPT_SCAN_ROWS = 50;

/** Todo states in which the session's own task is finished. */
const FINISHED_STATUSES = new Set(["in_review", "done", "cancelled"]);

/** Whether `child`'s task is finished and the turn that just settled only
 *  answered reports from its own children, and said nothing that needs acting on. */
export function isSettledSessionReplyToChildReports(child: Pick<Session, "id" | "workItemId">, reply: string | null | undefined): boolean {
  const text = reply?.trim();
  if (!text || !child.workItemId || asksOrReportsBlocker(text)) return false;
  try {
    const status = getWorkItem(child.workItemId)?.status;
    return !!status && FINISHED_STATUSES.has(status) && turnAnswersOnlyChildReports(child.id);
  } catch (error) {
    // Fail-safe: any doubt relays, which only costs the parent a wake.
    logger.warn(`[callbacks] Could not judge whether session ${child.id}'s reply answers only its children's reports; relaying it: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** The messages after the session's previous reply (its settled reply is
 *  already stored, so the walk skips its own rows first) are all child reports. */
function turnAnswersOnlyChildReports(sessionId: string): boolean {
  const rows = initDb()
    .prepare("SELECT role, meta FROM messages WHERE session_id = ? ORDER BY timestamp DESC, COALESCE(seq, 0) DESC, rowid DESC LIMIT ?")
    .all(sessionId, PROMPT_SCAN_ROWS) as Array<{ role: string; meta: unknown }>;
  let inPrompts = false;
  for (const row of rows) {
    const inbound = row.role === "user" || row.role === "notification";
    if (!inbound && inPrompts) return true;
    if (!inbound) continue;
    inPrompts = true;
    if (parseMetaColumn(row.meta)?.kind !== "child-reply") return false;
  }
  return inPrompts;
}
