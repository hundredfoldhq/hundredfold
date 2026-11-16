import { initDb } from "../shared/db.js";

/**
 * Telling a resumed session that its Todos moved while it was paused.
 *
 * The gateway pauses a session on its own account: a compaction it or the
 * session asked for, a gateway restart, a wait for a usage limit to reset.
 * While the session is away something else can change the status of the Todo
 * it works (the reconciler, the operator, a parent), and the session wakes up
 * with the old picture. The pause is stamped where it begins; the session's
 * next turn consumes the stamp and carries one line naming each Todo whose
 * status somebody else changed in between, so the session can correct or
 * confirm it. The line rides on the engine prompt exactly as the board
 * reminder does and is never stored.
 */

/** Why the session was paused. */
export type PauseKind = "compaction" | "restart" | "usage-limit";

/** The transport-meta key a pause is stamped under: `{ at: ISO, kind }`. */
export const PAUSED_AT_META_KEY = "pausedAt";

/** Opens the line, so a transcript sync can tell it from what the sender wrote. */
export const PAUSE_NOTICE_LABEL = "[Gateway notice] While this session was paused (";

const KIND_LABELS: Record<PauseKind, string> = {
  compaction: "compaction",
  restart: "gateway restart",
  "usage-limit": "usage limit",
};

/** Most Todos the line names; the rest are counted. */
const MAX_NAMED_TODOS = 3;
/** Longest actor name the line quotes. */
const MAX_ACTOR_LENGTH = 32;

const STATUS_EVENT_KINDS = "('status_change', 'escalated')";

function stampJson(kind: PauseKind, at: Date): string {
  return JSON.stringify({ at: at.toISOString(), kind });
}

/**
 * Stamp that the session is paused, unless a pause is already stamped: the
 * earliest pause stands until a turn consumes it, because every status change
 * since then is news to the session.
 */
export function stampSessionPause(sessionId: string, kind: PauseKind, at: Date = new Date()): void {
  initDb()
    .prepare(
      `UPDATE sessions SET transport_meta = json_set(COALESCE(transport_meta, '{}'), '$.${PAUSED_AT_META_KEY}', json(?))
        WHERE id = ? AND json_type(transport_meta, '$.${PAUSED_AT_META_KEY}') IS NULL`,
    )
    .run(stampJson(kind, at), sessionId);
}

/**
 * The same stamp, as a SQL expression for a sweep that already rewrites
 * `transport_meta` in one UPDATE: the meta with the stamp set when absent.
 * Binds one parameter, {@link pausedAtParam}, ahead of the statement's others.
 */
export function pausedAtMetaSql(metaExpr: string = "COALESCE(transport_meta, '{}')"): string {
  return `CASE WHEN json_type(transport_meta, '$.${PAUSED_AT_META_KEY}') IS NULL`
    + ` THEN json_set(${metaExpr}, '$.${PAUSED_AT_META_KEY}', json(?)) ELSE ${metaExpr} END`;
}

/** The parameter {@link pausedAtMetaSql} binds. */
export function pausedAtParam(kind: PauseKind, at: Date = new Date()): string {
  return stampJson(kind, at);
}

/** A transport-meta object with the stamp set when absent, for a writer that holds the whole object. */
export function withPauseStamp<T extends Record<string, unknown>>(meta: T, kind: PauseKind, at: Date = new Date()): T {
  return PAUSED_AT_META_KEY in meta ? meta : { ...meta, [PAUSED_AT_META_KEY]: { at: at.toISOString(), kind } };
}

/** A pause as stamped: when it began and why. */
export interface PauseStamp {
  at: string;
  kind: PauseKind;
}

function parseStamp(raw: unknown): PauseStamp | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const { at, kind } = value;
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return undefined;
    if (typeof kind !== "string" || !(kind in KIND_LABELS)) return undefined;
    return { at, kind: kind as PauseKind };
  } catch {
    return undefined;
  }
}

/** Read the session's stamp and drop it, whatever it holds. */
function consumeStamp(sessionId: string): PauseStamp | undefined {
  const database = initDb();
  const row = database
    .prepare(`SELECT json_extract(transport_meta, '$.${PAUSED_AT_META_KEY}') AS stamp FROM sessions WHERE id = ?`)
    .get(sessionId) as { stamp: string | null } | undefined;
  if (!row || row.stamp === null) return undefined;
  database
    .prepare(`UPDATE sessions SET transport_meta = NULLIF(json_remove(transport_meta, '$.${PAUSED_AT_META_KEY}'), '{}') WHERE id = ?`)
    .run(sessionId);
  return parseStamp(row.stamp);
}

/** The Todos this session works: those with an open run, and those whose run ended after the pause began (a block closes its run). */
function todosWorkedSince(sessionId: string, at: string): string[] {
  const rows = initDb()
    .prepare(
      `SELECT DISTINCT work_item_id FROM work_item_runs
        WHERE session_id = ? AND (ended_at IS NULL OR ended_at >= ?)
        ORDER BY work_item_id`,
    )
    .all(sessionId, at) as Array<{ work_item_id: string }>;
  return rows.map((row) => row.work_item_id);
}

interface StatusEvent {
  fromStatus: string | null;
  actor: string | null;
  employee: string | undefined;
}

function actorEmployee(detail: string | null): string | undefined {
  if (!detail) return undefined;
  try {
    const employee = (JSON.parse(detail) as Record<string, unknown>).actorEmployee;
    return typeof employee === "string" && employee ? employee : undefined;
  } catch {
    return undefined;
  }
}

function statusEventsSince(todoId: string, at: string): StatusEvent[] {
  const rows = initDb()
    .prepare(
      `SELECT from_status, actor, detail FROM work_item_events
        WHERE work_item_id = ? AND kind IN ${STATUS_EVENT_KINDS} AND to_status IS NOT NULL AND created_at >= ?
        ORDER BY created_at, rowid`,
    )
    .all(todoId, at) as Array<{ from_status: string | null; actor: string | null; detail: string | null }>;
  return rows.map((row) => ({ fromStatus: row.from_status, actor: row.actor, employee: actorEmployee(row.detail) }));
}

function currentStatus(todoId: string): string | undefined {
  const row = initDb().prepare("SELECT status FROM work_items WHERE id = ?").get(todoId) as { status: string } | undefined;
  return row?.status;
}

/**
 * Who moved it, in words a session may read. An allow-list: the operator and the
 * reconciler by name, another session by its employee, a board member as such,
 * and anyone else (a cron, a plugin, a recovery sweep, a delegation) as the
 * gateway. A raw actor carries ids the session has no business with.
 */
function actorLabel(event: StatusEvent): string {
  const actor = event.actor ?? "";
  if (actor === "operator" || actor === "reconciler") return actor;
  if (actor.startsWith("session:")) {
    const label = event.employee ?? "another session";
    return label.length > MAX_ACTOR_LENGTH ? `${label.slice(0, MAX_ACTOR_LENGTH - 1)}…` : label;
  }
  return actor.startsWith("user:") ? "a board member" : "the gateway";
}

/**
 * What changed on one Todo that the session did not do. The session's picture
 * is the status before the first change by anyone else; it is stale when the
 * Todo is somewhere else now and the last move was not its own (a session that
 * corrected the Todo has seen it). A flap that came back reads as no change.
 */
function staleMove(sessionId: string, todoId: string, at: string): string | undefined {
  const events = statusEventsSince(todoId, at);
  const self = `session:${sessionId}`;
  const first = events.find((event) => event.actor !== self);
  const last = events.at(-1);
  const now = currentStatus(todoId);
  if (!first || !last || last.actor === self || !first.fromStatus || !now || first.fromStatus === now) return undefined;
  return `${todoId} moved ${first.fromStatus} → ${now} (by ${actorLabel(last)})`;
}

function noticeLine(kind: PauseKind, moves: string[]): string {
  const named = moves.slice(0, MAX_NAMED_TODOS).join("; ");
  const more = moves.length > MAX_NAMED_TODOS ? `; and ${moves.length - MAX_NAMED_TODOS} more` : "";
  return `${PAUSE_NOTICE_LABEL}${KIND_LABELS[kind]}), ${named}${more}. If that is wrong, correct it with update_work_item; otherwise carry on.`;
}

/**
 * The one line a resumed session carries: the Todos it works that somebody else
 * moved while it was paused. Undefined when there was no pause, or nothing it
 * does not know. Consumes the stamp either way, so the next turn gets none.
 */
export function takePauseNotice(sessionId: string): string | undefined {
  return noticeFor(sessionId, consumeStamp(sessionId));
}

/** The earlier of the pauses given: a notice covering it covers the later ones too. */
function earliestStamp(...stamps: Array<PauseStamp | undefined>): PauseStamp | undefined {
  return stamps.reduce<PauseStamp | undefined>((first, next) => (
    next && (!first || Date.parse(next.at) < Date.parse(first.at)) ? next : first
  ), undefined);
}

function noticeFor(sessionId: string, stamp: PauseStamp | undefined): string | undefined {
  if (!stamp) return undefined;
  const moves = todosWorkedSince(sessionId, stamp.at)
    .map((todoId) => staleMove(sessionId, todoId, stamp.at))
    .filter((move): move is string => move !== undefined);
  return moves.length > 0 ? noticeLine(stamp.kind, moves) : undefined;
}

/** The pause a turn consumed and the notice it makes. The plan keeps the stamp so a re-run or a retry of the same turn can cover it again. */
export interface TurnPause {
  stamp?: PauseStamp;
  notice?: string;
}

/**
 * What a turn's plan takes. A slash command neither carries nor consumes a
 * pause (the prompt reaches the engine as written, and the turn after it,
 * which resumes the session, is the one to tell), so a prompt that leads with
 * `/`, as sent or as it will be run, takes nothing. `carried` is the pause an
 * earlier pass of this same turn consumed (a rate-limit hand-back re-runs the
 * turn from preflight): the notice then covers it too, from the earlier start.
 */
export function takeTurnPause(sessionId: string, prompt: string, promptToRun: string, carried?: PauseStamp): TurnPause {
  if (isSlashPrompt(prompt) || isSlashPrompt(promptToRun)) return {};
  const stamp = earliestStamp(carried, consumeStamp(sessionId));
  return { stamp, notice: noticeFor(sessionId, stamp) };
}

/**
 * The notice a usage-limit retry carries: the pause the wait stamped, from the
 * start of the pause the turn already carried (the refused attempt never showed
 * it to the model), as one line.
 */
export function takeRetryPauseNotice(sessionId: string, prompt: string, carried?: PauseStamp): string | undefined {
  return takeTurnPause(sessionId, prompt, prompt, carried).notice;
}

function isSlashPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith("/");
}

/**
 * The prompt as the engine receives it: the notice after the sender's text,
 * ahead of the board reminder. Applied when the engine is called, never to the
 * stored message.
 */
export function withPauseNotice(prompt: string, notice: string | undefined): string {
  if (!notice || isSlashPrompt(prompt)) return prompt;
  return prompt.trim() ? `${prompt}\n\n${notice}` : notice;
}

/**
 * A prompt read back from an engine's own transcript, without the notice this
 * gateway appended, so a transcript sync cannot write it into the stored message.
 * Only a single line that opens a paragraph is taken for ours.
 */
export function withoutPauseNotice(text: string): string {
  const at = text.lastIndexOf(PAUSE_NOTICE_LABEL);
  if (at === -1) return text;
  const before = text.slice(0, at);
  const line = text.slice(at);
  if (line.includes("\n") && line.slice(line.indexOf("\n")).trim() !== "") return text;
  if (before.trim() && !/\n[ \t]*\n[ \t]*$/.test(before)) return text;
  return before.trimEnd();
}
