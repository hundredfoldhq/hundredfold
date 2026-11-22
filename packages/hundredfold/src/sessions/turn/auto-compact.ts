import { opencodeMode } from "../../engines/opencode-server.js";
import { logger } from "../../shared/logger.js";
import { detectRateLimit } from "../../shared/rateLimit.js";
import { isRawEngineCommand } from "../../shared/skill-commands.js";
import type { EngineResult, HundredfoldConfig, Session } from "../../shared/types.js";
import { AUTO_COMPACT_BUDGET_HOLD_KEY, resolveAutoCompactPolicy, type AutoCompactPolicy } from "../../shared/auto-compact-config.js";
import {
  autoCompactDoneNotice,
  autoCompactFailedNotice,
  autoCompactStatus,
  buildAutoCompactCommand,
  decideAutoCompaction,
  holdAfterCompaction,
  lastEngineActivityMs,
  markAutoCompacting,
  type AutoCompactDecision,
  type AutoCompactGo,
  type AutoCompactSkip,
  type BudgetHold,
} from "../auto-compaction.js";
import type { PartialStreamWriter } from "../partial-stream.js";
import {
  deletePartialMessages,
  getSession,
  listChildSessions,
  nextEngineSessionFields,
  recordTurnAccounting,
  updateSessionForAttempt,
  type UpdateSessionFields,
} from "../registry.js";
import { runEngineAttempt, type EngineAttempt } from "./engine-run.js";
import { settleTurn } from "./completion.js";
import { preflightTurn } from "./preflight.js";
import { clearSupersededTurnMeta, isTurnSuperseded, retainUnseenInterruptedPrompt } from "./superseded.js";
import type { TurnPlan, TurnRun, TurnSurface } from "./types.js";
import { reportedSessionStatus } from "../background-work.js";

/**
 * Runs auto-compaction (see `../auto-compaction.ts`) INSIDE the turn
 * it precedes, between that turn's preflight and its engine run.
 *
 * Inside the turn, rather than as a turn of its own queued in front, because
 * that is what makes the three ordering guarantees free:
 *   - every transport — web, CLI view, connectors, cron, delegation callbacks,
 *     workflow phases — reaches an engine through `runTurn`, so all of them get
 *     it, and nothing else does;
 *   - the turn already owns the session's queue slot, so nothing can run
 *     between the compaction and the message it was for, and a message queued
 *     meanwhile waits behind both, as it would behind any turn (the bug
 *     self-compaction once had was a queued turn landing BETWEEN two turns);
 *   - it is decided once per turn, and a confirmed compaction resets the meter,
 *     so the next turn cannot compact again.
 * It is also not a turn in its own right: no receipt, no parent callback, no
 * second attempt. The turn it precedes reports as it always would.
 *
 * Failure never costs the message. A compaction that errors, hits a usage limit,
 * or is never confirmed is logged and noticed, and the turn runs as planned on
 * the full context. Only a preemption — a newer message, a stop — ends the turn
 * here, exactly as it would have ended the engine run it was about to start.
 */

export type PreTurnCompaction =
  /** Run the turn with this plan (the original, or one resuming a new engine id). */
  | { kind: "run"; plan: TurnPlan }
  /** A stop or a newer message took the turn while it compacted. */
  | { kind: "preempted" };

/** The compaction's stream is not the turn's answer: nothing of it is kept. */
const DISCARDED_STREAM: PartialStreamWriter = { persist() {}, finish() {} };

/** The chat sees the compaction's status and the meter moving, not its prose. */
function compactionSurface(surface: TurnSurface): TurnSurface {
  return {
    ...surface,
    delta: (delta) => {
      if (delta.type === "status" || delta.type === "context") surface.delta(delta);
    },
  };
}

function childrenInFlight(sessionId: string): Session[] {
  try {
    return listChildSessions(sessionId).filter((child) => {
      const status = reportedSessionStatus(child);
      return status === "running" || status === "waiting";
    });
  } catch (err) {
    logger.warn(`[auto-compact] ${sessionId}: could not list child sessions: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export type AutoCompactOutcome = "compacted" | "unconfirmed" | "failed" | "rate-limited" | "preempted" | "not-planned";

/** One auto-compaction in progress: what was decided, and when it started. */
interface Pending {
  run: TurnRun;
  decision: AutoCompactGo;
  startedAt: number;
}

/** A value for the log line; `-` when there is none. An empty value would let
 *  the logger's secret scrubber take the next field as its value. */
const field = (value: number | string | undefined): string => (value === undefined ? "-" : String(value));

function resultFields(result: Pick<EngineResult, "compaction" | "cost"> | undefined): string[] {
  const stats = result?.compaction;
  return [
    `pre=${field(stats?.preTokens)}`,
    `post=${field(stats?.postTokens)}`,
    `costUsd=${field(result?.cost?.toFixed(4))}`,
  ];
}

function triggerFields(decision: AutoCompactGo): string[] {
  return decision.trigger === "budget"
    ? [`trigger=budget`, `budget=${decision.budgetTokens}`]
    : [`trigger=cold`, `idleSec=${Math.round(decision.idleMs / 1000)}`, `windowSec=${decision.policy.cacheWindowSeconds}`];
}

/**
 * One greppable line per auto-compaction, so the saving can be checked later
 * against the spend ledger (the compaction's own cost is recorded there too).
 * Sizes are in tokens. No key may contain "token": the logger's secret
 * scrubber blanks any `…token…=` value, whatever its case.
 */
export function autoCompactLogLine(
  fields: { sessionId: string; engine: string; outcome: AutoCompactOutcome; decision: AutoCompactGo; durationMs: number },
  result?: Pick<EngineResult, "compaction" | "cost">,
): string {
  return "[auto-compact] " + [
    `session=${fields.sessionId}`,
    `engine=${fields.engine}`,
    `outcome=${fields.outcome}`,
    ...triggerFields(fields.decision),
    `context=${fields.decision.contextTokens}`,
    ...resultFields(result),
    `durationMs=${fields.durationMs}`,
  ].join(" ");
}

function logAutoCompaction(pending: Pending, outcome: AutoCompactOutcome, result?: Pick<EngineResult, "compaction" | "cost" | "error">): void {
  const { run, decision } = pending;
  const line = autoCompactLogLine(
    { sessionId: run.input.session.id, engine: run.plan.engineName, outcome, decision, durationMs: Date.now() - pending.startedAt },
    result,
  );
  if (outcome === "compacted" || outcome === "preempted") logger.info(line);
  else logger.warn(`${line} error=${JSON.stringify((result?.error ?? "").slice(0, 300))}`);
}

/** A stop, a newer message, a workflow interruption or another turn took the
 *  attempt while the compaction ran. */
function wasPreempted(run: TurnRun, live: Session | undefined, result: EngineResult): boolean {
  if (!live || live.engine !== run.plan.engineName) return true;
  if (result.error?.startsWith("Interrupted")) return true;
  if (live.attemptToken !== run.input.attemptToken || live.status !== "running") return true;
  return isTurnSuperseded(live.id, run.turnStartedAt);
}

/** The session's `transportMeta` with its budget hold set, or lifted (`null`). */
function withBudgetHold(current: Session, hold: BudgetHold | null): UpdateSessionFields {
  const { [AUTO_COMPACT_BUDGET_HOLD_KEY]: _previous, ...rest } = current.transportMeta ?? {};
  return { transportMeta: hold ? { ...rest, [AUTO_COMPACT_BUDGET_HOLD_KEY]: hold } : rest };
}

/**
 * Record a confirmed compaction on the session, fenced to this attempt: its
 * cost, the engine session it compacted (so `lastSyncedAt` says the cache is
 * warm again), the meter's new reading — the size after, or nothing when
 * the engine reported none, so the meter never shows the pre-compaction size
 * as current — and the budget hold, when the compaction did not get the
 * session under its budget. Returns the engine id the turn should now resume.
 */
function recordCompaction(run: TurnRun, compactPlan: TurnPlan, attempt: EngineAttempt, decision: AutoCompactGo): string | undefined {
  const { result } = attempt;
  const meter = compactedMeter(result);
  const sessionId = run.input.session.id;
  recordTurnAccounting(sessionId, { cost: result.cost, numTurns: result.numTurns, ...(compactPlan.model ? { model: compactPlan.model } : {}) });
  const nativeId = result.sessionId?.trim() || compactPlan.resumeNativeId;
  updateSessionForAttempt(sessionId, run.input.attemptToken, (current): UpdateSessionFields => ({
    ...(nativeId
      ? nextEngineSessionFields(current, compactPlan.engineName, nativeId, {
        model: compactPlan.model,
        effortLevel: compactPlan.effortLevel,
        platformContextFingerprint: attempt.fingerprint,
        lastSyncedAt: new Date().toISOString(),
      })
      : {}),
    lastContextTokens: meter,
    ...withBudgetHold(current, holdAfterCompaction(decision.policy, compactPlan.engineName, meter ?? undefined)),
  }));
  return nativeId;
}

/**
 * A live view still holds the size streamed while the summary ran, and the turn goes
 * straight on, so nothing else would correct it before the turn's first reply.
 */
function tellSurfaceCompacted(run: TurnRun, result: EngineResult, decision: AutoCompactGo): void {
  const preTokens = result.compaction?.preTokens ?? decision.contextTokens;
  const postTokens = compactedMeter(result);
  run.surface.compacted?.({
    ...(typeof preTokens === "number" ? { preTokens } : {}),
    ...(typeof postTokens === "number" ? { postTokens } : {}),
  });
}

/** The size the meter is written with after a confirmed compaction, or null when the engine reported none. */
function compactedMeter(result: EngineResult): number | null {
  const postTokens = result.compaction?.postTokens ?? result.contextTokens;
  return typeof postTokens === "number" ? postTokens : null;
}

/** The turn's plan, resuming the engine session the compaction left behind. */
function planAfterCompaction(plan: TurnPlan, nativeId: string | undefined): TurnPlan {
  if (!nativeId || nativeId === plan.resumeNativeId) return plan;
  return { ...plan, resumeSessionId: nativeId, resumeNativeId: nativeId };
}

async function runCompaction(run: TurnRun, compactPlan: TurnPlan): Promise<EngineAttempt | Error> {
  markAutoCompacting(run.input.session.id, true);
  try {
    return await runEngineAttempt({
      input: run.input,
      plan: compactPlan,
      surface: compactionSurface(run.surface),
      heartbeat: run.heartbeat,
      partialStream: DISCARDED_STREAM,
      turnStartedAt: Date.now(),
      model: compactPlan.model,
    });
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  } finally {
    markAutoCompacting(run.input.session.id, false);
  }
}

type Verdict =
  | { outcome: "compacted" }
  | { outcome: "preempted" }
  | { outcome: "rate-limited" | "failed" | "unconfirmed"; reason: string };

/** How the compaction ended, in the order that matters: a preemption first
 *  (whatever else it says, the turn is gone), then a limit, then anything short
 *  of a confirmed compaction. */
function judge(run: TurnRun, result: EngineResult): Verdict {
  if (wasPreempted(run, getSession(run.input.session.id), result)) return { outcome: "preempted" };
  // A usage limit is not this turn's to handle: the turn runs next, meets the
  // same limit, and takes the ordinary rate-limit path (wait, or fall back).
  if (detectRateLimit(result).limited) return { outcome: "rate-limited", reason: "the engine is at its usage limit" };
  if (result.error) return { outcome: "failed", reason: result.error };
  if (!result.compaction) return { outcome: "unconfirmed", reason: "the engine never confirmed a compaction" };
  return { outcome: "compacted" };
}

function decide(run: TurnRun): AutoCompactDecision {
  const { input, plan } = run;
  const decision = decideAutoCompaction({
    config: input.config,
    // The live row: an earlier turn's receipt has moved the meter and the
    // engine ref since this turn's snapshot was taken.
    session: getSession(input.session.id) ?? input.session,
    engine: plan.engineName,
    opencodeMode: opencodeMode(input.config.engines.opencode),
    prompt: input.prompt,
    compactionTurn: plan.compaction,
    syncRequested: plan.syncRequested,
    now: Date.now(),
  });
  // The decision moved the hold (filled its floor, or lifted it): write that
  // back, fenced to this attempt like everything else the turn records.
  if (decision.holdUpdate !== undefined) {
    const hold = decision.holdUpdate;
    updateSessionForAttempt(input.session.id, input.attemptToken, (current) => withBudgetHold(current, hold));
  }
  return decision;
}

/**
 * Compact this turn's session first when it is long and its cache has gone
 * cold, or its context has passed its budget; otherwise hand the plan straight
 * back. See the module comment.
 */
export async function compactColdSessionFirst(run: TurnRun): Promise<PreTurnCompaction> {
  const decision = decide(run);
  if (decision.compact) return await compactThenRun({ run, decision, startedAt: Date.now() });
  if (decision.skip === "disabled") logDisabled(run);
  else logSkip(run, decision.skip);
  return { kind: "run", plan: run.plan };
}

/** Sessions already told, for an engine, that their idle time is unknown. A
 *  cold turn is never deduplicated (see {@link logDisabled}); this only keeps a
 *  session whose activity is never known from repeating itself on every turn.
 *  Bounded by a gateway restart. */
const toldUnknown = new Set<string>();

/** Forget which sessions were told (tests). */
export function resetDisabledNotices(): void {
  toldUnknown.clear();
}

/**
 * The line for a long session whose engine has auto-compaction off. Without it
 * an engine left off — the default for Claude — compacts nothing and says
 * nothing, and the only symptom is the bill. `config=absent` means the engine
 * has no `autoCompact` block at all; `config=off` means one sets it off.
 * No key may contain "token" (see {@link autoCompactLogLine}).
 */
export function autoCompactDisabledLogLine(fields: {
  sessionId: string;
  engine: string;
  context: number;
  /** How long the engine's conversation has sat idle; undefined when nothing says. */
  idleMs?: number;
  policy: AutoCompactPolicy;
  /** Whether `engines.<engine>.autoCompact` is set at all. */
  configured: boolean;
}): string {
  const cold = fields.idleMs !== undefined && fields.idleMs >= fields.policy.cacheWindowSeconds * 1000;
  return "[auto-compact] " + [
    `session=${fields.sessionId}`,
    `engine=${fields.engine}`,
    `outcome=skipped`,
    `skip=disabled`,
    `context=${fields.context}`,
    `idleSec=${field(fields.idleMs === undefined ? undefined : Math.round(fields.idleMs / 1000))}`,
    `cold=${fields.idleMs === undefined ? "unknown" : cold}`,
    `config=${fields.configured ? "off" : "absent"}`,
    `hint=${JSON.stringify(`set engines.${fields.engine}.autoCompact.enabled: true to compact long cold sessions before their next turn`)}`,
  ].join(" ");
}

/**
 * Say that a long session's turn ran on an engine whose auto-compaction is off.
 *
 * One line per cold turn: each is a full-price resume the policy would have
 * compacted, and the cache window (300 s by default) is the rate limit, since
 * the turn that logs it re-warms the cache. A warm long turn is not worth a line,
 * and so must not use up a once-only claim before the cold one the line is for.
 * A session whose idle time is unknown is told once per engine. Not for a
 * compaction turn or a native command, which are not a message the policy would
 * have compacted in front of, and not for a short session or an engine that
 * cannot compact.
 */
function logDisabled(run: TurnRun): void {
  const { input, plan } = run;
  const sessionId = input.session.id;
  const policy = resolveAutoCompactPolicy(input.config, plan.engineName);
  if (!policy || plan.compaction || isRawEngineCommand(plan.engineName, input.prompt)) return;
  const live = getSession(sessionId) ?? input.session;
  const context = live.lastContextTokens ?? 0;
  if (context < policy.minContextTokens) return;
  const lastActivity = lastEngineActivityMs(live, plan.engineName);
  const idleMs = lastActivity === undefined ? undefined : Date.now() - lastActivity;
  if (!worthDisabledLine(`${sessionId}:${plan.engineName}`, idleMs, policy)) return;
  logger.info(autoCompactDisabledLogLine({
    sessionId,
    engine: plan.engineName,
    context,
    ...(idleMs === undefined ? {} : { idleMs }),
    policy,
    configured: hasAutoCompactBlock(input.config, plan.engineName),
  }));
}

function hasAutoCompactBlock(config: Pick<HundredfoldConfig, "engines">, engine: string): boolean {
  const block = (config.engines as unknown as Record<string, { autoCompact?: unknown } | undefined>)[engine];
  return block?.autoCompact !== undefined;
}

/** Cold: always. Warm: never. Unknown: the first time for this session and engine. */
function worthDisabledLine(key: string, idleMs: number | undefined, policy: AutoCompactPolicy): boolean {
  if (idleMs !== undefined) return idleMs >= policy.cacheWindowSeconds * 1000;
  if (toldUnknown.has(key)) return false;
  toldUnknown.add(key);
  return true;
}

/** Skips that are ordinary for a long session: it is warm, held at its budget, or
 *  the turn is itself a command. Every other skip of a long session is a
 *  compaction the operator may have expected, so it is logged where it shows. */
const ROUTINE_SKIPS = new Set<AutoCompactSkip>(["cache-warm", "budget-held", "compaction-turn", "raw-command", "context-small"]);

function logSkip(run: TurnRun, skip: AutoCompactSkip): void {
  const sessionId = run.input.session.id;
  const policy = resolveAutoCompactPolicy(run.input.config, run.plan.engineName);
  const live = getSession(sessionId);
  const context = live?.lastContextTokens ?? undefined;
  const long = typeof context === "number" && policy !== undefined && context >= policy.minContextTokens;
  if (long && !ROUTINE_SKIPS.has(skip)) {
    logger.info(`[auto-compact] session=${sessionId} engine=${run.plan.engineName} outcome=skipped skip=${skip} context=${context}`);
  } else {
    logger.debug(`[auto-compact] ${sessionId}: not compacting (${skip})`);
  }
}

async function compactThenRun(pending: Pending): Promise<PreTurnCompaction> {
  const { run, decision } = pending;
  const { input, plan } = run;
  const sessionId = input.session.id;
  // The same preflight an operator's `/compact` gets, so the compaction runs
  // exactly as that one does: verbatim, with no refresh or held prompt folded in.
  const compactPlan = preflightTurn({
    ...input,
    session: getSession(sessionId) ?? input.session,
    prompt: buildAutoCompactCommand(childrenInFlight(sessionId), decision.trigger),
  });
  if (!compactPlan.ok || !compactPlan.compaction) {
    logAutoCompaction(pending, "not-planned", { error: compactPlan.ok ? "not a compaction" : compactPlan.error });
    return { kind: "run", plan };
  }

  run.surface.delta({ type: "status", content: autoCompactStatus(decision) });
  const attempt = await runCompaction(run, compactPlan);
  if (attempt instanceof Error) {
    logAutoCompaction(pending, "failed", { error: attempt.message });
    await run.surface.notice(autoCompactFailedNotice(attempt.message, decision.trigger));
    return { kind: "run", plan };
  }

  const verdict = judge(run, attempt.result);
  logAutoCompaction(pending, verdict.outcome, attempt.result);
  if (verdict.outcome === "preempted") return { kind: "preempted" };
  if (verdict.outcome !== "compacted") {
    await run.surface.notice(autoCompactFailedNotice(verdict.reason, decision.trigger));
    return { kind: "run", plan };
  }
  const nativeId = recordCompaction(run, compactPlan, attempt, decision);
  tellSurfaceCompacted(run, attempt.result, decision);
  await run.surface.notice(autoCompactDoneNotice(decision, attempt.result.compaction));
  return { kind: "run", plan: planAfterCompaction(plan, nativeId) };
}

/**
 * The turn was taken — by a stop, a workflow interruption, a newer message —
 * while it compacted, so its own prompt never reached the engine. Settled as
 * interrupted and silent upward, as any preempted turn is; a prompt a newer
 * message displaced is held for the next turn to carry, since the engine has no
 * record of it. The caller has confirmed the session can still take a result.
 */
export async function settlePreemptedBeforeEngine(run: TurnRun): Promise<void> {
  const sessionId = run.input.session.id;
  const superseded = isTurnSuperseded(sessionId, run.turnStartedAt);
  deletePartialMessages(sessionId);
  await settleTurn({
    sessionId,
    attemptToken: run.input.attemptToken,
    outcome: "interrupted",
    result: null,
    error: null,
    fields: run.terminalFields(),
    employee: run.input.employee,
    notifyParent: false,
    surface: run.surface,
  });
  if (superseded) retainUnseenInterruptedPrompt(sessionId, run.input.prompt);
  clearSupersededTurnMeta(sessionId);
  logger.info(`Session ${sessionId} interrupted before its engine run`);
}
