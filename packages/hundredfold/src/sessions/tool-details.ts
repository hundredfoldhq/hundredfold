import { initDb } from "../shared/db.js";
import type { JsonObject } from "../shared/types.js";
import type { ToolFull } from "../shared/tool-detail.js";

/**
 * The whole input and output of the tool calls whose chat card was cut. The card keeps a few
 * thousand characters (`meta.tool` on the call's row); this keeps the rest, redacted, for the card
 * to load on request. A row is written as the call goes (its input at the start, its output at the
 * end) and goes with its session.
 */

interface ToolDetailRow {
  input: string | null;
  input_chars: number | null;
  output: string | null;
  output_chars: number | null;
  is_error: number;
}

export interface StoredToolDetail {
  input?: JsonObject;
  /** The input's length before it was cut to fit the store; absent when it all fit. */
  inputChars?: number;
  output?: string;
  /** The output's length before it was cut to fit the store; absent when it all fit. */
  outputChars?: number;
  isError?: boolean;
}

/** Keep what a call has shown so far: a later write adds to a row rather than replacing it. */
export function saveToolDetail(sessionId: string, toolId: string, full: ToolFull): void {
  if (!toolId) return;
  const db = initDb();
  db.prepare(`
    INSERT INTO tool_details (session_id, tool_id, input, input_chars, output, output_chars, is_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id, tool_id) DO UPDATE SET
      input = COALESCE(excluded.input, input),
      input_chars = CASE WHEN excluded.input IS NULL THEN input_chars ELSE excluded.input_chars END,
      output = COALESCE(excluded.output, output),
      output_chars = CASE WHEN excluded.output IS NULL THEN output_chars ELSE excluded.output_chars END,
      is_error = MAX(is_error, excluded.is_error)
  `).run(
    sessionId,
    toolId,
    full.input ? JSON.stringify(full.input) : null,
    full.input ? full.inputChars ?? null : null,
    full.output ?? null,
    full.output !== undefined ? full.outputChars ?? null : null,
    full.isError ? 1 : 0,
    Date.now(),
  );
}

/** What is stored for one call of a session, or undefined when nothing is. */
export function getToolDetail(sessionId: string, toolId: string): StoredToolDetail | undefined {
  const row = initDb()
    .prepare("SELECT input, input_chars, output, output_chars, is_error FROM tool_details WHERE session_id = ? AND tool_id = ?")
    .get(sessionId, toolId) as ToolDetailRow | undefined;
  if (!row) return undefined;
  return {
    ...(row.input !== null ? { input: JSON.parse(row.input) as JsonObject } : {}),
    ...(row.input !== null && row.input_chars !== null ? { inputChars: row.input_chars } : {}),
    ...(row.output !== null ? { output: row.output } : {}),
    ...(row.output !== null && row.output_chars !== null ? { outputChars: row.output_chars } : {}),
    ...(row.is_error ? { isError: true } : {}),
  };
}

/** Drop the details of calls that have no row in the session any more (a turn that ended before its call did). */
export function deleteOrphanedToolDetails(sessionId: string): number {
  return initDb().prepare(`
    DELETE FROM tool_details
    WHERE session_id = ? AND tool_id NOT IN (SELECT tool_id FROM messages WHERE session_id = ? AND tool_id IS NOT NULL)
  `).run(sessionId, sessionId).changes;
}
