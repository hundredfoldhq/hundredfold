import { classifyOpencodeFailure, type OpencodeFailureKind } from "../../shared/opencode-failure.js";
import { isInterruptibleEngine, type EngineResult, type Session, type StreamDelta } from "../../shared/types.js";
import { rateLimitEngineLabel } from "../../shared/rateLimit.js";
import type { EngineName } from "../../shared/models.js";
import { getSession, insertMessage, type UpdateSessionFields } from "../registry.js";
import { notifyOperatorChannel, notifyRateLimited, notifyRateLimitResumed } from "../callbacks.js";
import { handleRateLimit, type RateLimitHandlerHooks, type RateLimitInfo } from "../rate-limit-handler.js";
import { remoteScopeFor } from "../session-cwd.js";
import { accountOverride, sessionRemoteTarget } from "../session-account.js";
import { servedFields } from "./served-fields.js";
import { settleTurn, type SettleTurnInput } from "./completion.js";
import { formatResumeTime, turnDisplayText } from "./text.js";
import type { TurnInput, TurnPlan, TurnSurface } from "./types.js";
import { withBoardReminder } from "./board-reminder.js";
import { chainExhaustedNotice, hopNoticeText, signedOutClause, withSignedOut, type ChainExhausted } from "../fallback-hop.js";
import type { FallbackHop, FallbackHopNoticeMeta } from "../../shared/fallback-chain-wire.js";
import type { JsonObject } from "../../shared/types.js";
import { postEngineNotices } from "./engine-notices.js";
import { awaitRemoteHostForRetry } from "./remote-ready.js";
import { ENGINE_SWITCHED_REASON } from "../../shared/engine-switch.js";
import { withLeftBackgroundTasksCleared } from "../left-background-tasks.js";

export interface RateLimitTurnArgs {
  input: TurnInput;
  plan: TurnPlan;
  surface: TurnSurface;
  systemPrompt: string;
  platformContextRefresh?: string;
  platformContextFingerprint: string;
  rateLimit: RateLimitInfo;
  originalResult: EngineResult;
  terminalFields: () => UpdateSessionFields;
}

type EngineSession = NonNullable<SettleTurnInput["engineSession"]>;

/** Session label used in every operator notification this branch sends. */
function describe(session: Session): string {
  return `Session ${session.id}${session.employee ? ` (${session.employee})` : ""}`;
}

/**
 * Settle a turn the rate-limit branch recovered — on the fallback engine or on
 * the original one after the limit cleared. Either way it is a completed turn:
 * it cost real money and produced a real answer, so it accounts and reports.
 */
async function settleRecoveredTurn(
  args: RateLimitTurnArgs,
  recovered: EngineResult,
  engineSession: EngineSession | undefined,
  served: { ranOn?: string; recordServed?: boolean; readTaskIds?: readonly string[] } = {},
): Promise<Session | undefined> {
  const sessionId = args.input.session.id;
  const text = turnDisplayText(recovered.result, recovered.error);
  if (text) insertMessage(sessionId, "assistant", text);

  const settled = await settleTurn({
    sessionId,
    attemptToken: args.input.attemptToken,
    outcome: recovered.error ? "failed" : "succeeded",
    result: recovered.result,
    error: recovered.error ?? null,
    cost: recovered.cost,
    durationMs: recovered.durationMs,
    accounting: { cost: recovered.cost, numTurns: recovered.numTurns, ...(served.ranOn ? { model: served.ranOn } : {}) },
    ...(engineSession ? { engineSession } : {}),
    fields: recoveredFields(args, recovered, served),
    employee: args.input.employee,
    afterLimit: true,
    surface: args.surface,
  });
  if (text) await args.surface.reply(text);
  return settled;
}

/** The fields a recovered turn settles with. The retry that waited out a limit was answered by the target the session is on,
 *  and a hop records its own. The tasks the prompt's note named, which the engine has read, are no longer owed. */
function recoveredFields(
  args: RateLimitTurnArgs, recovered: EngineResult, served: { recordServed?: boolean; readTaskIds?: readonly string[] },
): UpdateSessionFields {
  const fields = servedFields(args.input, {
    ...args.terminalFields(),
    ...(typeof recovered.contextTokens === "number" ? { lastContextTokens: recovered.contextTokens } : {}),
  }, Boolean(served.recordServed) && !recovered.error);
  return withCarriedTasksCleared(args.input.session.id, fields, served.readTaskIds ?? []);
}

/** `fields` also dropping the tasks the settled turn's prompt carried: the live row's record, less exactly those ids. */
function withCarriedTasksCleared(sessionId: string, fields: UpdateSessionFields, ids: readonly string[]): UpdateSessionFields {
  if (ids.length === 0) return fields;
  const meta = withLeftBackgroundTasksCleared(fields.transportMeta ?? getSession(sessionId)?.transportMeta, ids);
  return { ...fields, transportMeta: meta as UpdateSessionFields["transportMeta"] };
}

/** Whether a stream delta shows the engine took up the prompt. */
function showsOutput(delta: StreamDelta): boolean {
  return delta.type === "text" || delta.type === "text_snapshot" || delta.type === "tool_use" || delta.type === "tool_result";
}

/** What the link or retry now running has shown. Output means the engine read its prompt even if it then failed, so the
 *  tasks the prompt carried are settled for a result that has none of an error or that was streamed. */
function outputWatch(forward: (delta: StreamDelta) => void) {
  let streamed = false;
  return {
    reset: () => { streamed = false; },
    delta: (delta: StreamDelta) => {
      if (showsOutput(delta)) streamed = true;
      forward(delta);
    },
    read: (result: EngineResult, carried: readonly string[]): readonly string[] => (!result.error || streamed ? carried : []),
  };
}

/** A hop answered: its native id is filed under whichever engine the switch landed on, and without a platform context
 *  fingerprint, which belongs to the engine that was limited. */
async function settleFallbackAnswer(args: RateLimitTurnArgs, result: EngineResult, ran: { model?: string }, readTaskIds: readonly string[]): Promise<void> {
  await postEngineNotices(args.surface, args.input.session.id, result.notices);
  const engine = getSession(args.input.session.id)?.engine ?? args.input.session.engine;
  const { plan } = args;
  await settleRecoveredTurn(args, result, result.sessionId?.trim() ? {
    engine, nativeId: result.sessionId, meta: { model: plan.model, effortLevel: plan.effortLevel },
  } : undefined, { ranOn: ran.model, readTaskIds });
}

/** The wait on the original target ended in an answer. */
async function settleRetryAnswer(args: RateLimitTurnArgs, result: EngineResult, readTaskIds: readonly string[]): Promise<void> {
  await postEngineNotices(args.surface, args.input.session.id, result.notices);
  const { plan } = args;
  const settled = await settleRecoveredTurn(args, result, !result.error && result.sessionId?.trim() ? {
    engine: plan.engineName,
    nativeId: result.sessionId,
    meta: { model: plan.model, effortLevel: plan.effortLevel, platformContextFingerprint: args.platformContextFingerprint },
  } : undefined, { ranOn: plan.model, recordServed: true, readTaskIds });
  if (!settled) return;
  notifyRateLimitResumed(settled);
  notifyOperatorChannel(`✅ ${rateLimitEngineLabel(args.input.session.engine)} usage limit cleared. ${describe(args.input.session)} resumed.`, undefined, "resumed");
}

/** The notification a hop leaves in the transcript: its readable text, and the hop itself for the dashboard. */
async function noticeHop(args: RateLimitTurnArgs, text: string, hop: FallbackHop): Promise<void> {
  const meta: FallbackHopNoticeMeta = { fallbackHop: hop };
  await args.surface.notice(text, meta as unknown as JsonObject);
}

async function announceFallback(
  args: RateLimitTurnArgs, resumeAt: Date | null, substitute: EngineName, opts: { model?: string; hop?: FallbackHop } = {},
): Promise<void> {
  const { model, hop } = opts;
  const session = args.input.session;
  // The handler rewrites session.engine to the substitute only after this hook
  // returns, so what is read here is still the engine that was limited. A later
  // hop of a chain walk moves on from the link before it: the hop names that one.
  const limitedEngine = hop?.from.split("|")[0] || session.engine;
  const limitedLabel = rateLimitEngineLabel(limitedEngine);
  const substituteLabel = model ? `${rateLimitEngineLabel(substitute)} (${model})` : rateLimitEngineLabel(substitute);
  const resumeText = formatResumeTime(resumeAt);
  notifyOperatorChannel(`⚠️ ${limitedLabel} usage limit reached. ${describe(session)} switching to ${substituteLabel}.`, undefined, "fallback");
  // A chain hop names both targets in full (account, profile and model) and carries its record; any other swap keeps its own wording.
  if (hop) await noticeHop(args, hopNoticeText(hop), hop);
  else await args.surface.notice(`⚠️ ${limitedLabel} usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to ${substituteLabel} for now.`);

  // Drop the LIMITED engine's warm PTY AND its armed late-recovery listener, so
  // the abandoned turn can't double-answer after the substitute delivers.
  const limited = args.input.engines.get(limitedEngine);
  if (limited && isInterruptibleEngine(limited)) {
    limited.kill(session.id, ENGINE_SWITCHED_REASON);
  }
}

async function announceWaiting(
  args: RateLimitTurnArgs, resumeAt: Date | null, why: { reason?: string; hop?: FallbackHop; exhausted?: ChainExhausted; signedOut?: string[] } = {},
): Promise<void> {
  const { reason, hop, exhausted, signedOut } = why;
  const session = args.input.session;
  const engineLabel = rateLimitEngineLabel(session.engine);
  const resumeText = formatResumeTime(resumeAt);
  // The operator is the one who can replace a signed-out link's key, so the alert names it.
  const paused = `⚠️ ${engineLabel} usage limit reached. ${describe(session)} paused${resumeText ? ` until ${resumeText}` : ""}`;
  notifyOperatorChannel(`${withSignedOut(paused, signedOut, ". ")}.`, undefined, "paused");
  await args.surface.waiting(true);
  notifyRateLimited(
    getSession(session.id) ?? session,
    resumeAt ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : undefined,
  );
  // A chain that ran out says plainly that no hop is left; any other wait keeps its wording.
  const text = exhausted ? chainExhaustedNotice(exhausted, resumeAt, signedOut) : waitingNotice(engineLabel, resumeText, reason, signedOut);
  if (hop) await noticeHop(args, text, hop);
  else await args.surface.notice(text);
}

/** The notice for any other wait: when it resets, why it did not switch, and which fallback links are signed out. */
function waitingNotice(engineLabel: string, resumeText: string | null, reason: string | undefined, signedOut: readonly string[] | undefined): string {
  const head = `⏳ ${engineLabel} usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}`;
  if (!reason && !signedOut?.length) return `${head} — I'll continue automatically.`;
  const why = withSignedOut(reason ? `${head}. Not switching: ${reason}` : head, signedOut, ". ");
  return `${why}. I'll continue automatically.`;
}

/** The limit never lifted inside the deadline: settle out of `waiting`. */
async function settleTimedOutTurn(args: RateLimitTurnArgs): Promise<void> {
  const session = args.input.session;
  const timeoutError = `${rateLimitEngineLabel(session.engine)} usage limit did not clear in time`;
  notifyOperatorChannel(`❌ ${timeoutError}. ${describe(session)} has been stopped.`, undefined, "stopped");
  await settleTurn({
    sessionId: session.id,
    attemptToken: args.input.attemptToken,
    outcome: "failed",
    error: timeoutError,
    // This turn settles out of `waiting`, not `running`, so the receipt widens
    // the fence the other terminal classes use.
    expectedStatuses: ["waiting", "running"],
    employee: args.input.employee,
    surface: args.surface,
  });
  await args.surface.reply("Usage limit didn't reset in time. Please try again later.");
}

/** The limit lifted, but the host the retry runs on stayed unreachable for the whole retry window. */
async function settleUnreachableTurn(args: RateLimitTurnArgs, error: string): Promise<void> {
  const session = args.input.session;
  notifyOperatorChannel(`❌ ${describe(session)} could not resume after its usage limit: ${error}`, undefined, "stopped");
  await settleTurn({
    sessionId: session.id,
    attemptToken: args.input.attemptToken,
    outcome: "failed",
    error,
    expectedStatuses: ["waiting", "running"],
    employee: args.input.employee,
    surface: args.surface,
  });
  await args.surface.reply(`The usage limit reset, but the host this session runs on never became ready: ${error}. Send a message to try again.`);
}

/** Every failure puts the transport back to waiting (the retry attempt had set it to thinking); the first of a
 *  streak also says so once, in the chat and to the operator. Later ones only update the session's status line. */
async function announceHostNotReady(args: RateLimitTurnArgs, info: { error: string; failures: number; retryAt: Date }): Promise<void> {
  await args.surface.waiting(true);
  if (info.failures !== 1) return;
  const session = args.input.session;
  notifyOperatorChannel(`⚠️ ${describe(session)}: the usage limit reset but its host is not ready (${info.error}). Retrying with backoff.`, undefined, "paused");
  await args.surface.notice(`⏳ The usage limit reset, but this session's host is not ready (${info.error}). I'll keep retrying and continue automatically.`);
}

type Refusal = OpencodeFailureKind | undefined;

/** The turn's error for a refused own target, in the provider's own words. */
function refusedError(label: string, refused: Refusal, provider: string): string {
  if (refused === "auth") return `${label} provider is signed out: ${provider}`;
  if (refused === "model-access") return `${label} provider does not serve this model for the account: ${provider}`;
  return `${label} account is out of credit: ${provider}`;
}

const REFUSED_REPLY: Record<"auth" | "model-access" | "billing", { why: string; fix: string; orFallback: boolean }> = {
  auth: { why: "The provider rejected its API key", fix: "Sign in again", orFallback: true },
  "model-access": { why: "The provider does not serve this model for the account", fix: "Enable the model or pick another", orFallback: false },
  billing: { why: "The provider reports an insufficient balance", fix: "Top up the account", orFallback: true },
};

/** What the reply tells the person to do about a refused own target, and about a fallback link that is signed out. */
function refusedReply(refused: Refusal, signedOut: readonly string[] | undefined): string {
  const { why, fix, orFallback } = REFUSED_REPLY[refused === "auth" || refused === "model-access" ? refused : "billing"];
  if (!signedOut?.length) return `${why} and no fallback could serve this turn. ${fix}${orFallback ? " or add a fallback" : ""}, then try again.`;
  // There is a fallback, and it is the signed-out link: its key is the other fix.
  const theirs = signedOut.length > 1 ? "their keys" : "its key";
  return `${why} and no fallback could serve this turn: the ${signedOutClause(signedOut)}. ${fix}, or replace ${theirs}, then try again.`;
}

/** A prepaid balance ran dry, a key is dead, or a model is not enabled for the account, and no fallback
 *  link could serve the turn: fail it with the provider's own words (they say where to top up or sign
 *  in) so it reaches the manager, instead of parking it for a window that never opens. A fallback link
 *  the walk found signed out is named too: its key needs replacing as much as the own target's fault. */
async function settleBillingFailedTurn(args: RateLimitTurnArgs, info: { signedOut?: string[] } = {}): Promise<void> {
  const session = args.input.session;
  const provider = args.originalResult.error?.replace(/\s+/g, " ").trim().slice(0, 400) || "the provider reported an insufficient balance";
  const refused = classifyOpencodeFailure(args.originalResult.error)?.kind;
  const own = refusedError(rateLimitEngineLabel(session.engine), refused, provider);
  const billingError = withSignedOut(own, info.signedOut);
  notifyOperatorChannel(`❌ ${billingError}. ${describe(session)} has been stopped.`, undefined, "stopped");
  await settleTurn({
    sessionId: session.id,
    attemptToken: args.input.attemptToken,
    outcome: "failed",
    error: billingError,
    expectedStatuses: ["waiting", "running"],
    employee: args.input.employee,
    surface: args.surface,
  });
  await args.surface.reply(refusedReply(refused, info.signedOut));
}

function rateLimitHooks(args: RateLimitTurnArgs): RateLimitHandlerHooks {
  const { plan, surface } = args;
  const link = outputWatch((delta) => surface.delta(delta));
  const retry = outputWatch((delta) => surface.delta(delta));
  return {
    onFallbackStart: ({ resumeAt, substitute, model, hop }) => {
      link.reset();
      return announceFallback(args, resumeAt, substitute, { model, hop });
    },
    onFallbackStream: link.delta,
    // A hop that did not serve the turn still asked for its notices, once each.
    onFallbackFailed: (failed) => postEngineNotices(surface, args.input.session.id, failed.notices),
    onFallbackComplete: (result, ran) => settleFallbackAnswer(args, result, ran, link.read(result, ran.carriedLeftBackgroundTaskIds)),
    onWaitingStart: ({ resumeAt, reason, hop, exhausted, signedOut }) => announceWaiting(args, resumeAt, { reason, hop, exhausted, signedOut }),
    onRetryAttempt: () => {
      retry.reset();
      return surface.waiting(false);
    },
    onStillLimited: () => surface.waiting(true),
    onRetryStream: retry.delta,
    onRetrySuccess: (result, ran) => settleRetryAnswer(args, result, retry.read(result, ran.carriedLeftBackgroundTaskIds)),
    prepareRetry: () => awaitRemoteHostForRetry(args.input, plan.engineName),
    onRetryHostNotReady: (info) => announceHostNotReady(args, info),
    onRetryHostUnreachable: ({ error }) => settleUnreachableTurn(args, error),
    onTimeout: () => settleTimedOutTurn(args),
    onBillingFailure: (info) => settleBillingFailedTurn(args, info),
  };
}

/**
 * The rate-limit branch of a turn: hand off to the wait/retry/fallback handler
 * and settle whichever of its outcomes lands. Returns the session to re-run the
 * turn on when a wait on a substitute Claude account handed it back to its own
 * account; that turn has not settled, and the caller runs it again.
 */
export async function runRateLimitTurn(args: RateLimitTurnArgs): Promise<Session | undefined> {
  const { input, plan } = args;
  const outcome = await handleRateLimit({
    session: input.session,
    attemptToken: input.attemptToken,
    prompt: withBoardReminder(input.prompt, plan.boardReminder),
    systemPrompt: args.systemPrompt,
    platformContextRefresh: args.platformContextRefresh,
    engineConfig: plan.engineConfig,
    effortLevel: plan.effortLevel,
    cliFlags: input.employee?.cliFlags,
    ...sessionRemoteTarget(input.employee, remoteScopeFor(input.config.remote, input.session), input.session),
    mcpConfigPath: plan.mcpConfigPath,
    resolvedMcp: plan.resolvedMcp,
    attachments: input.attachments.length ? input.attachments : undefined,
    config: input.config,
    engines: input.engines,
    employee: input.employee,
    engine: plan.engine,
    rateLimit: args.rateLimit,
    originalResult: args.originalResult,
    hooks: rateLimitHooks(args),
  });
  if (outcome.kind !== "handback") return undefined;
  // The own target was recorded as still limited: the window moved out and the turn runs on the stand-in, so nothing went back.
  if (!outcome.reverted) return outcome.session;
  if (outcome.waited) {
    // The parent and the operator channel were told this session paused; tell them it is moving again.
    await args.surface.waiting(false);
    notifyRateLimitResumed(outcome.session);
    notifyOperatorChannel(`✅ ${describe(input.session)} back on its own ${accountOverride(input.session) ? "Claude account" : "target"} and resumed.`, undefined, "resumed");
  }
  await args.surface.notice(accountOverride(input.session) ? "↩️ Back on this session's own Claude account — continuing there." : "↩️ Back on this session's own target — continuing there.");
  return outcome.session;
}
