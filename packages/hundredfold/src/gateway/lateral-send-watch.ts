import { createHash } from "node:crypto";
import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import { reportsTurnProgress, type Session, type SessionDeliveryPayload } from "../shared/types.js";
import { claimSessionDelivery, getQueueItem, getSession } from "../sessions/registry.js";
import { lastTurnOutputAt } from "../sessions/turn/output-clock.js";
import { LATERAL_STALL_DELIVERY_KIND, retireClosedLateralNotices } from "../sessions/lateral-notice-staleness.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import { isStoppedByUser } from "../sessions/stopped-marker.js";
import { parseLateralSendKey } from "../sessions/queued-send-supersede.js";
import type { ApiContext } from "./api.js";
import { resumePendingQueueItem } from "./callback-queue-recovery.js";

/**
 * Watching an agent-to-agent message that was accepted but has not run.
 *
 * `send_to_session` answers "queued" the moment the row is stored, and from then
 * on only the target's lane can start it. When a message sits `pending` past a
 * bounded time, one of two things is true, and the sender must not be left
 * guessing which:
 *
 * - **Nothing owns the row.** The process holds no dispatch for it (a dispatch
 *   that was lost, as a restart or a hot-reload can leave one), so it would wait
 *   forever. It is dispatched again, in the order the lane keeps.
 * - **The row is owned but the lane has not reached it.** While the target is
 *   in a turn that is still getting somewhere, that is the expected wait: the
 *   send already answered "queued", and the sender hears nothing more. Only a
 *   target that needs the sender to act (a turn gone silent, a usage-limit
 *   wait, an error, no turn running) is reported, with how to replace or
 *   withdraw the message.
 *
 * A report is per sender and target, never per message: one notice names every
 * message of that sender still waiting on that target, and a later one comes
 * only when the target's state has changed. An orchestrator with several
 * messages parked behind one child's long turn is woken once, if at all.
 *
 * Scope: only a session this gateway runs itself can be dispatched again. A
 * row that is unowned and cannot be (a connector-owned session, as at boot
 * replay) stays pending, and its sender is told so rather than promised a run.
 * A row the re-dispatch had to drop (stopped or deleted target, engine
 * unavailable) is reported as dropped, not as waiting.
 */

/** How long an accepted message may sit before the watch acts on it. */
export const LATERAL_STALL_AFTER_MS = 5 * 60_000;
/** How long a target in a turn may show no progress before it reads as stalled. */
export const LATERAL_SILENT_AFTER_MS = 15 * 60_000;
/** The same, while a tool call or a model request of that turn is in flight: a long build is work, not a stall. */
export const LATERAL_BUSY_SILENT_AFTER_MS = 60 * 60_000;
export const LATERAL_SWEEP_MS = 60_000;
export { LATERAL_STALL_DELIVERY_KIND };

/** What became of the row: still owned by the lane, left with nothing to run it, or dropped. */
export type StalledSendState = "queued" | "unowned" | "dropped";

interface PendingSend {
  id: string;
  sessionId: string;
  sessionKey: string;
  dedupeKey: string;
  createdAt: string;
}

/** The agent-to-agent rows that have waited longer than `afterMs`, oldest first. */
function stalledSends(now: number, afterMs: number): PendingSend[] {
  const cutoff = new Date(now - afterMs).toISOString();
  return initDb().prepare(
    `SELECT id, session_id AS sessionId, session_key AS sessionKey, dedupe_key AS dedupeKey, created_at AS createdAt
     FROM queue_items
     WHERE status = 'pending' AND dedupe_key LIKE 'lateral:%' AND created_at <= ?
     ORDER BY created_at ASC, rowid ASC`,
  ).all(cutoff) as PendingSend[];
}

function minutesSince(iso: string, now: number): number {
  return Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));
}

/** Where the target's turn stands, as the watch judges it. */
export type TargetTurn =
  /** In a turn that is getting somewhere: the wait is expected, nobody is told. */
  | { kind: "working" }
  /** In a turn that has shown nothing for longer than the stall window. */
  | { kind: "silent"; silentMinutes: number }
  /** Anything else: no turn running, a usage-limit wait, an error. Its status says which. */
  | { kind: "other"; laneRunning: boolean };

/**
 * Judge the target's turn. "Working" needs the lane running a turn whose
 * engine output (or, where the engine reports it, a hook or a tool in flight)
 * is recent; the turn heartbeat does not count, since it beats for a wedged
 * turn too. A turn with no progress record here (none started in this
 * process) is timed from the oldest message waiting on it.
 */
export function judgeTargetTurn(target: Session, laneKey: string, context: ApiContext, now: number, waitingSince: number): TargetTurn {
  const laneRunning = context.sessionManager.getQueue().isRunning(laneKey);
  if (!laneRunning || target.status !== "running") return { kind: "other", laneRunning };
  const reading = readTurnProgress(target, context);
  const lastProgress = Math.max(reading.lastProgressAt, lastTurnOutputAt(target.id) ?? 0) || waitingSince;
  const silentMs = now - lastProgress;
  if (silentMs < (reading.busy ? LATERAL_BUSY_SILENT_AFTER_MS : LATERAL_SILENT_AFTER_MS)) return { kind: "working" };
  return { kind: "silent", silentMinutes: Math.max(1, Math.round(silentMs / 60_000)) };
}

/** What the target's engine says of its turn, where it reports progress at all. */
function readTurnProgress(target: Session, context: ApiContext): { lastProgressAt: number; busy: boolean } {
  const engine = context.sessionManager.getEngine(target.engine);
  const progress = engine && reportsTurnProgress(engine) ? engine.turnProgress(target.id) : undefined;
  if (!progress) return { lastProgressAt: 0, busy: false };
  return {
    lastProgressAt: progress.lastProgressAt,
    // Waiting behind a turn typed in the terminal is a state, timed like a long tool from when the wait began.
    busy: progress.activeTools > 0 || progress.activeUpstream || progress.waitingForTerminalTurn === true,
  };
}

/** The messages one sender has waiting on one target, by what became of each. */
export interface WaitingSends {
  queued: string[];
  unowned: string[];
  dropped: string[];
}

function listIds(ids: string[]): string {
  return ids.length === 1 ? ids[0] : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

/** "Message x is" / "Messages x and y are", then the rest of the sentence with "it"/"them" chosen for the count. */
function aboutMessages(ids: string[], rest: (one: boolean) => string): string {
  const one = ids.length === 1;
  return `${one ? `Message ${ids[0]} is` : `Messages ${listIds(ids)} are`} ${rest(one)}`;
}

function targetState(turn: TargetTurn, targetStatus: string): string {
  if (turn.kind === "working") return `it is in a turn that is still making progress (status ${targetStatus})`;
  if (turn.kind === "silent") return `it is in a turn that has shown no progress for ${turn.silentMinutes} minutes (status ${targetStatus})`;
  if (turn.kind === "other" && turn.laneRunning) return `it is still working through an earlier turn (status ${targetStatus})`;
  return `it has no turn running (status ${targetStatus})`;
}

/** One sentence per fate the sender's messages met, for the fates there are. */
function fateSentences(sends: WaitingSends): string[] {
  const sentences: string[] = [];
  if (sends.queued.length > 0) {
    sentences.push(aboutMessages(sends.queued, (one) => `still queued and will run in order once the session reaches ${one ? "it" : "them"}.`));
  }
  if (sends.unowned.length > 0) {
    sentences.push(aboutMessages(sends.unowned, (one) => `still stored but nothing in this gateway is running ${one ? "it, and it will not run by itself" : "them, and they will not run by themselves"}.`));
  }
  if (sends.dropped.length > 0) {
    sentences.push(aboutMessages(sends.dropped, (one) => `dropped and will not run: the session cannot run ${one ? "it" : "them"} as it stands. Send again if still needed.`));
  }
  sentences.push("Read the session to see where it stands.");
  if (sends.queued.length + sends.unowned.length > 0) {
    sentences.push("To change what the session receives, send again with `supersedes` set to a message's id, or message another employee if the work cannot wait.");
  }
  return sentences;
}

function overallState(sends: WaitingSends): StalledSendState {
  if (sends.queued.length + sends.unowned.length === 0) return "dropped";
  return sends.unowned.length > 0 ? "unowned" : "queued";
}

/** What the sender is told: where its messages are and what it can do about them. */
export function stalledSendPayload(input: {
  targetSessionId: string;
  waitedMinutes: number;
  targetStatus: string;
  targetNote?: string | null;
  turn: TargetTurn;
  sends: WaitingSends;
}): SessionDeliveryPayload {
  const { targetSessionId, waitedMinutes, targetStatus, targetNote, turn, sends } = input;
  const all = [...sends.queued, ...sends.unowned, ...sends.dropped];
  const one = all.length === 1;
  const note = targetNote?.trim() ? ` Its last error: ${targetNote.trim().slice(0, 200)}.` : "";
  const head = `${one ? `Your message ${all[0]}` : `Your ${all.length} messages`} to session ${targetSessionId} ${one ? "has" : "have"} not been delivered `
    + `after ${waitedMinutes} minutes: ${targetState(turn, targetStatus)}.${note}`;
  const state = overallState(sends);
  return {
    message: [head, ...fateSentences(sends), "You are told again about this session only if its state changes."].join(" "),
    displayMessage: `${one ? `Message ${all[0].slice(0, 8)}` : `${all.length} messages`} to ${targetSessionId.slice(0, 8)} ${state === "dropped" ? "dropped" : "undelivered"} after ${waitedMinutes} min`,
    // waitingQueueItemIds: what the dispatch re-checks before the notice's turn runs (lateral-notice-staleness.ts).
    meta: { kind: LATERAL_STALL_DELIVERY_KIND, targetSessionId, queueItemIds: all, waitingQueueItemIds: [...sends.queued, ...sends.unowned], state },
  };
}

/**
 * The identity of one report: the target's state as the sender would act on
 * it. The same state reached again is no news; a new turn, a new status, a
 * newly unowned message (each one needs the sender to resend it) or a newly
 * dropped message is. Messages merely queued behind an already-reported state
 * are not.
 */
function reportIdentity(target: Session, turn: TargetTurn, sends: WaitingSends): string {
  const signature = [
    turn.kind === "other" ? `other:${turn.laneRunning ? "lane" : "nolane"}` : turn.kind,
    target.status,
    target.attemptToken ?? "",
    [...sends.unowned].sort().join(","),
    [...sends.dropped].sort().join(","),
  ].join("|");
  return `stalled:${createHash("sha256").update(signature).digest("hex").slice(0, 16)}`;
}

interface SenderTargetGroup {
  callerSessionId: string;
  target: Session;
  /** The target's lane, as its queue rows are keyed. */
  laneKey: string;
  oldest: string;
  sends: WaitingSends;
}

/** Tell the sender, once per target state: the outbox key makes a repeat a no-op. */
function reportGroup(group: SenderTargetGroup, turn: TargetTurn, now: number): boolean {
  const { callerSessionId, target, sends } = group;
  // A notice for this sender that closed without running must not hold the state it reported.
  retireClosedLateralNotices(callerSessionId, target.id, [...sends.queued, ...sends.unowned, ...sends.dropped]);
  const { delivery, claimed } = claimSessionDelivery({
    targetSessionId: callerSessionId,
    sourceKind: "session",
    sourceId: target.id,
    sourceAttempt: reportIdentity(target, turn, sends),
    sourceOutcome: "stalled",
    sourceVersion: 1,
    deliveryKind: LATERAL_STALL_DELIVERY_KIND,
    payload: stalledSendPayload({
      targetSessionId: target.id,
      waitedMinutes: minutesSince(group.oldest, now),
      targetStatus: target.status,
      targetNote: target.lastError,
      turn,
      sends,
    }),
  });
  if (!claimed) return false;
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(`[lateral-watch] Notice ${delivery.id} to session ${callerSessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return true;
}

export interface LateralSweepResult {
  rearmed: string[];
  reported: string[];
}

/** Re-dispatch a row nothing owns. True when it was dispatched again. */
function redispatch(send: PendingSend, context: ApiContext): boolean {
  if (context.sessionManager.getQueue().hasInFlightItem(send.id)) return false;
  const item = getQueueItem(send.id);
  return item?.status === "pending" && resumePendingQueueItem(item, context);
}

/** What the row is now, after the re-dispatch had its chance: the notice says that, not what the row was. */
function stalledState(send: PendingSend, context: ApiContext): StalledSendState | undefined {
  const status = getQueueItem(send.id)?.status;
  if (status === "cancelled") return "dropped";
  if (status !== "pending") return undefined;
  return context.sessionManager.getQueue().hasInFlightItem(send.id) ? "queued" : "unowned";
}

/** Add a row still waiting after the re-dispatch to its sender-and-target group. */
function addToGroup(groups: Map<string, SenderTargetGroup>, send: PendingSend, rowState: StalledSendState): void {
  const key = parseLateralSendKey(send.dedupeKey);
  const sender = key && getSession(key.callerSessionId);
  // A sender stopped on purpose cannot act on a notice, and would refuse it: hear nothing until it is started again.
  if (!key || !sender || isStoppedByUser(sender)) return;
  const groupKey = `${key.callerSessionId}:${send.sessionId}`;
  let group = groups.get(groupKey);
  if (!group) {
    const target = getSession(send.sessionId);
    if (!target) return;
    // Rows come oldest first, so the first one opens the group.
    group = { callerSessionId: key.callerSessionId, target, laneKey: send.sessionKey, oldest: send.createdAt, sends: { queued: [], unowned: [], dropped: [] } };
    groups.set(groupKey, group);
  }
  group.sends[rowState].push(send.id);
}

/** Tell one sender about its messages waiting on one target, if the target needs it to act. The ids reported. */
function settleGroup(group: SenderTargetGroup, context: ApiContext, now: number): string[] {
  // Read after the re-dispatches: a row dispatched again may have started the target's turn.
  const target = getSession(group.target.id) ?? group.target;
  const turn = judgeTargetTurn(target, group.laneKey, context, now, Date.parse(group.oldest));
  const { queued, unowned, dropped } = group.sends;
  if (unowned.length + dropped.length === 0 && turn.kind === "working") return [];
  return reportGroup({ ...group, target }, turn, now) ? [...queued, ...unowned, ...dropped] : [];
}

/**
 * One pass: re-dispatch what nothing owns, then, per sender and target, tell
 * the sender about what is still waiting if the target needs it to act.
 */
export function sweepLateralSends(context: ApiContext, opts: { now?: number; afterMs?: number } = {}): LateralSweepResult {
  const now = opts.now ?? Date.now();
  const result: LateralSweepResult = { rearmed: [], reported: [] };
  const groups = new Map<string, SenderTargetGroup>();
  for (const send of stalledSends(now, opts.afterMs ?? LATERAL_STALL_AFTER_MS)) {
    if (redispatch(send, context)) {
      logger.warn(`[lateral-watch] Message ${send.id} to session ${send.sessionId} was pending with no dispatch; dispatched again`);
      result.rearmed.push(send.id);
      continue;
    }
    const rowState = stalledState(send, context);
    if (rowState) addToGroup(groups, send, rowState);
  }
  for (const group of groups.values()) result.reported.push(...settleGroup(group, context, now));
  return result;
}

/** Watch accepted agent-to-agent messages for as long as the gateway runs. */
export function startLateralSendWatch(context: ApiContext): () => void {
  const timer = setInterval(() => {
    try {
      const { rearmed, reported } = sweepLateralSends(context);
      if (rearmed.length + reported.length > 0) {
        logger.info(`[lateral-watch] re-dispatched ${rearmed.length}, reported ${reported.length} undelivered message(s)`);
      }
    } catch (error) {
      logger.warn(`[lateral-watch] Sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, LATERAL_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
