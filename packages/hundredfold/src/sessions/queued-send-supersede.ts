// A sender's own parked agent-to-agent messages: finding them, counting them,
// and taking one back when a later send replaces it. Kept apart from
// `incoming-turn.ts`, which accepts the send, and from `queue-item-registry.ts`,
// which owns the operator's cancel for the visible rows.
//
// Why this exists: a message sent to a session that is mid-turn waits for the
// turn to end, and a correction sent behind it used to wait in line too, so the
// receiver read the stale instruction first and acted on it before the one that
// replaced it. The operator has always been able to cancel a parked message; the
// sender of an internal row had no way to.
import { initDb } from '../shared/db.js';

type Db = ReturnType<typeof initDb>;

/**
 * The durable identity prefix of every send from `callerSessionId` to
 * `targetSessionId`. A lateral send's queue row is keyed by it, and the row has
 * no other record of who sent it, so this prefix is what makes a row the
 * sender's own.
 */
export function lateralSendPrefix(callerSessionId: string, targetSessionId: string): string {
  return `lateral:${callerSessionId}:${targetSessionId}:`;
}

/** The caller and target a lateral send's queue row was keyed by, or undefined for any other key. */
export function parseLateralSendKey(dedupeKey: string): { callerSessionId: string; targetSessionId: string } | undefined {
  const [kind, callerSessionId, targetSessionId] = dedupeKey.split(':');
  return kind === 'lateral' && callerSessionId && targetSessionId ? { callerSessionId, targetSessionId } : undefined;
}

export type SupersedeOutcome =
  | { outcome: 'withdrawn'; queueItemId: string; messageId: string | null }
  /** The row had already left `pending`: the receiver took it, or a stop cancelled it. */
  | { outcome: 'too-late'; queueItemId: string };

/** Whether `queueItemId` is a send from the caller to the target, in any state. */
function isOwnSend(callerSessionId: string, targetSessionId: string, queueItemId: string): boolean {
  return initDb().prepare(
    'SELECT 1 FROM queue_items WHERE id = ? AND session_id = ? AND instr(dedupe_key, ?) = 1',
  ).get(queueItemId, targetSessionId, lateralSendPrefix(callerSessionId, targetSessionId)) !== undefined;
}

/**
 * Why a send's `supersedes` cannot be honoured, undefined when it can. A message
 * that is not the caller's own to this session is refused outright rather than
 * ignored: a wrong id would otherwise deliver both messages, the very outcome
 * the caller asked to prevent.
 */
export function supersedeRequestError(supersedes: unknown, callerSessionId: string, targetSessionId: string): string | undefined {
  if (supersedes === undefined) return undefined;
  if (typeof supersedes !== 'string' || !supersedes.trim()) return 'supersedes must be the queueId of an earlier send_to_session of yours';
  return isOwnSend(callerSessionId, targetSessionId, supersedes)
    ? undefined
    : `supersedes "${supersedes}" is not a message you sent to this session`;
}

/** What a sender is told about its send beyond "queued": whether it is waiting, and what else of its is. */
export function sendReceipt(
  callerSessionId: string,
  target: { id: string; sessionKey: string },
  targetRunning: boolean,
  superseded: SupersedeOutcome | undefined,
): { targetRunning: boolean; queuedFromYou: number; superseded?: SupersedeOutcome['outcome'] } {
  return {
    targetRunning,
    queuedFromYou: countPendingSends(callerSessionId, target),
    ...(superseded ? { superseded: superseded.outcome } : {}),
  };
}

/** How many of the caller's sends to the target are still parked behind its turn (read by lane, which the queue index covers). */
function countPendingSends(callerSessionId: string, target: { id: string; sessionKey: string }): number {
  return (initDb().prepare(
    "SELECT COUNT(*) AS n FROM queue_items WHERE session_key = ? AND status = 'pending' AND session_id = ? AND instr(dedupe_key, ?) = 1",
  ).get(target.sessionKey, target.id, lateralSendPrefix(callerSessionId, target.id)) as { n: number }).n;
}

/**
 * Take back a parked send: cancel its row and drop the bubble it put in the
 * receiver's transcript, together, because a message the engine will never see
 * but the transcript still shows is read as one that was sent (and is replayed
 * into a session that has to be rebuilt from its transcript). Runs inside the
 * caller's transaction so the replacement and the withdrawal commit as one.
 *
 * The row is read again here: it can have been claimed by a turn since the
 * route checked it, and a claimed message cannot be taken back.
 */
export function withdrawOwnSend(db: Db, callerSessionId: string, targetSessionId: string, queueItemId: string): SupersedeOutcome {
  const row = db.prepare(
    "SELECT message_id AS messageId FROM queue_items WHERE id = ? AND session_id = ? AND status = 'pending' AND instr(dedupe_key, ?) = 1",
  ).get(queueItemId, targetSessionId, lateralSendPrefix(callerSessionId, targetSessionId)) as { messageId: string | null } | undefined;
  if (!row) return { outcome: 'too-late', queueItemId };
  db.prepare("UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(queueItemId);
  if (row.messageId) db.prepare('DELETE FROM messages WHERE id = ?').run(row.messageId);
  return { outcome: 'withdrawn', queueItemId, messageId: row.messageId };
}

/** What the engine reads between two folded sends. */
const FOLDED_SEND_SEPARATOR = '\n\n';

/**
 * Fold the sends parked in a lane into `intoId`, one turn in send order: the
 * turn that cut the running one short reads every message that was waiting
 * behind it, then the one that cut it, instead of answering each in a turn of
 * its own before the next is read. `intoId` takes the earliest place among them,
 * so the turn runs where the first of them would have; the others are cancelled,
 * and their bubbles stay: each was sent, and the one turn reads them all.
 *
 * Only the sends of the one sender that `intoId` came from are folded: another
 * session's parked message keeps its own turn, since the merged row belongs to
 * this sender (it is the row this sender can withdraw or replace). A callback
 * delivery, an operator message and a `/compact` keep their own turns too.
 *
 * Returns the ids folded in, empty when nothing was parked ahead.
 */
export function foldParkedLateralSends(sessionKey: string, intoId: string): string[] {
  const db = initDb();
  return db.transaction(() => {
    const own = db.prepare('SELECT dedupe_key AS dedupeKey FROM queue_items WHERE id = ? AND session_key = ?').get(intoId, sessionKey) as { dedupeKey: string | null } | undefined;
    const sender = own?.dedupeKey ? parseLateralSendKey(own.dedupeKey) : undefined;
    if (!sender) return [];
    const rows = db.prepare(
      "SELECT id, prompt, position, message_id AS messageId FROM queue_items WHERE session_key = ? AND status = 'pending' AND instr(dedupe_key, ?) = 1 ORDER BY position ASC, created_at ASC, rowid ASC",
    ).all(sessionKey, lateralSendPrefix(sender.callerSessionId, sender.targetSessionId)) as Array<{ id: string; prompt: string; position: number; messageId: string | null }>;
    if (rows.length < 2 || !rows.some((row) => row.id === intoId)) return [];
    const folded = rows.filter((row) => row.id !== intoId);
    db.prepare("UPDATE queue_items SET prompt = ?, dispatch_payload = ?, position = ? WHERE id = ? AND status = 'pending'").run(
      rows.map((row) => row.prompt).join(FOLDED_SEND_SEPARATOR),
      JSON.stringify({ attachments: [], speechDerived: false, foldedMessageIds: folded.flatMap((row) => (row.messageId ? [row.messageId] : [])) }),
      rows[0].position,
      intoId,
    );
    const cancel = db.prepare("UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'");
    for (const row of folded) cancel.run(row.id);
    return folded.map((row) => row.id);
  }).immediate();
}
