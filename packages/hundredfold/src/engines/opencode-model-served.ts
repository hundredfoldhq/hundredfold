import type { EngineResult, EngineRunOpts } from "../shared/types.js";
import { isRemoteTarget, sshDestination } from "../shared/remote-target.js";
import { localOpencodeVersion } from "../shared/opencode-bin-version.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { opencodeApiOf } from "./opencode-version.js";
import { gatherFacts } from "./remote-stage.js";
import type { OpencodeAccountStaging } from "./opencode-accounts.js";
import { opencodeClonesPending, opencodeClonesSettled } from "../shared/opencode-catalogue.js";
import { missingBaseModelsError, UNLOADED_ACCOUNT_MODELS_ERROR } from "../shared/opencode-accounts.js";
import { DETAILS_TIMEOUT_MS } from "../shared/opencode-discovery.js";
import { logger } from "../shared/logger.js";

/**
 * Whether the opencode a turn would run on can serve the turn's own model, before anything is launched.
 *
 * An account's model off the account's main endpoint is one a 1.x binary cannot serve (it sends every model to the
 * block's own endpoint), and it fails there with an `UnknownError` that says nothing of why. The error returned here
 * says it, and the turn is never started. A binary is only asked (the local version, or a remote host's facts) when the
 * model is one an account's 1.x block would leave out, so every other turn pays nothing.
 *
 * @returns the error to fail the turn with, or undefined when the turn can go ahead (a host whose version cannot be read
 *  is left for the launch itself to report).
 */
export async function unservedTurnModel(opts: EngineRunOpts, accounts: OpencodeAccountStaging | undefined): Promise<string | undefined> {
  const model = opts.model;
  if (!accounts || !model) return undefined;
  const onOne = accounts.unservedModel(model, 1);
  if (onOne === undefined) return undefined;
  if (!isRemoteTarget(opts)) {
    return opencodeApiOf(await localOpencodeVersion(resolveBin("opencode", opts.bin))) === 1 ? onOne : undefined;
  }
  const facts = await gatherFacts(sshDestination(opts)).catch(() => undefined);
  return facts !== undefined && opencodeApiOf(facts.opencodeVersion) === 1 ? onOne : undefined;
}

/** Whether the turn's model is one a 1.x binary would leave out, so that the binary has to be asked. Synchronous, so a turn that needs no check does not wait before it starts. */
export function mayBeUnserved(opts: EngineRunOpts, accounts: OpencodeAccountStaging | undefined): accounts is OpencodeAccountStaging {
  return !!accounts && !!opts.model && accounts.unservedModel(opts.model, 1) !== undefined;
}

/** The failed result of a turn on a model its host's opencode cannot serve; undefined when it can. Nothing ran, so the conversation is intact (it is never read as a stale resume id). */
export async function unservedTurnResult(opts: EngineRunOpts, accounts: OpencodeAccountStaging | undefined): Promise<EngineResult | undefined> {
  const error = await unservedTurnModel(opts, accounts);
  return error === undefined ? undefined : { sessionId: opts.resumeSessionId || "", result: "", error, conversationIntact: true };
}

/** Whether the turn's own model is a declared account's whose base has no model details yet, so that its block would stage no
 *  models and opencode would refuse the turn as `provider.no-route`. Synchronous, so every other turn starts without waiting. */
export function awaitsAccountModels(opts: EngineRunOpts, accounts: OpencodeAccountStaging | undefined): accounts is OpencodeAccountStaging {
  return !!accounts && !!opts.model && accounts.unstaged(opts.model) !== undefined;
}

/**
 * The accounts to stage a turn with once its own account's models are known.
 *
 * On a fresh gateway the first turn can start before the first detailed model discovery has landed (it takes seconds, and
 * the gateway serves before it ends). An account cloned from its base then has no models, its staged block lists none, and
 * opencode refuses the turn as `provider.no-route`, which holds the model as if the account could not use it. So the turn
 * waits, bounded, for discovery to bring the base's models, then reads the accounts again (`read`: the turn's own reader).
 *
 * @returns the accounts to go on with; `interrupted` when `signal` aborted the wait (nothing is launched); or the failed
 *  result, nothing having run: {@link UNLOADED_ACCOUNT_MODELS_ERROR} when discovery was still running at the timeout (no
 *  failure class: nothing is held), or {@link missingBaseModelsError} when it finished without the base's models (model
 *  access: the turn hops and the model is held, as opencode's refusal of the empty block would have been).
 */
export async function accountsOnceStaged(
  opts: EngineRunOpts,
  accounts: OpencodeAccountStaging,
  read: () => OpencodeAccountStaging | undefined,
  wait: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ accounts: OpencodeAccountStaging | undefined } | { result: EngineResult } | { interrupted: true }> {
  const model = opts.model!;
  const { base } = accounts.unstaged(model)!;
  logger.info(`opencode: waiting for model discovery to load "${base}" before staging ${model}`);
  await opencodeClonesSettled(base, wait.timeoutMs ?? DETAILS_TIMEOUT_MS, wait.signal);
  if (wait.signal?.aborted) return { interrupted: true };
  const again = read();
  const still = again?.unstaged(model);
  if (still === undefined) return { accounts: again };
  const error = opencodeClonesPending(still.base) ? UNLOADED_ACCOUNT_MODELS_ERROR : missingBaseModelsError(model, still.account, still.base);
  logger.warn(`opencode: ${model} (account "${still.account}", base "${still.base}"): ${error}`);
  return { result: { sessionId: opts.resumeSessionId || "", result: "", error, conversationIntact: true } };
}
