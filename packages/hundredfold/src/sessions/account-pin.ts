import { declaredAccountByKey, declaredClaudeAccounts, declaredRemoteAccountByKey } from "../shared/claude-accounts-config.js";
import { accountForEmployee } from "../shared/engine-account.js";
import { engineHealthForTarget, readEngineHealth, type EngineHealthReading } from "../shared/engine-health.js";
import { startPickOf, homeGroupOf, opencodeHomeGroupOf, type HomeGroup } from "../shared/fallback-chain-group.js";
import type { FallbackLimitReadings } from "../shared/fallback-chain-health.js";
import { ownTargetLink } from "../shared/fallback-chain-links.js";
import { inheritedChain, resolveFallbackLinks, type FallbackChainEnv, type FallbackChainSpec } from "../shared/fallback-chain.js";
import { opencodeAccountKeyProvider, opencodeModelKeyOf, opencodeOwnModel, opencodeProviderOf } from "../shared/fallback-chain-opencode-group.js";
import { fallbackGroupOf, type AccountPick, type FallbackChainEntry, type FallbackChainSource } from "../shared/fallback-chain-wire.js";
import { recordAccountStart, resetAccountCredits } from "../shared/fallback-account-pick.js";
import { getModelRegistry } from "../shared/models.js";
import { isRemoteTarget, sshDestination } from "../shared/remote-target.js";
import type { Employee, HundredfoldConfig, JsonObject } from "../shared/types.js";
import { availabilityRegistry, engineInstalledWhereRun } from "./availability-registry.js";
import { metaWithRemoteAccountPin, type RemoteAccountPin } from "./remote-account-pin.js";
import { runsOnlyOnClaude } from "./scoped-engine.js";

/**
 * Where a new session's account is chosen: the one function every start
 * path asks (docs/design/fallback-account-groups.md, "Every way a session
 * starts"). When the session's chain opens with a group holding its own account,
 * the balancer picks a member, the session is pinned to it (a Claude session in the profile column
 * a chosen profile already uses, or for a remote employee's session, whose profile
 * is a directory on its host, in `transportMeta.remoteAccountPin`; an opencode session in its
 * `model` column, the only account setting opencode has) and the pick is
 * recorded in `transportMeta.accountPick`. Anywhere else this answers nothing, and the
 * session starts exactly as it did before groups.
 *
 * Choosing is pure and charges nothing; the credit is charged by `chargeAccountStart`,
 * after the session row exists, so a validation, a refusal or a preview never
 * spends a turn of the rotation. A start path runs pick, create and charge in
 * one synchronous stretch, so two requests cannot read the same credits.
 */

export interface AccountPinArgs {
  config: HundredfoldConfig;
  /** The employee the session is for; none for a session of the instance default. */
  employee?: Employee;
  /** The engine the session starts on: only `claude` and `opencode` are balanced. */
  engine: string;
  /**
   * The model the session runs, when known: it decides which model-scoped usage windows apply. For opencode it is the
   * model the caller asked for (or the employee's): one on another account's provider than the subject's own is a chosen account.
   */
  model?: string | null;
  /** The caller named a profile (`claude:<name>`): that account is the session's, nothing is balanced. */
  namedProfile?: boolean;
  /** `switch` for a deliberate engine-only switch onto Claude; absent: a new session. */
  trigger?: AccountPick["trigger"];
  now?: Date;
  /** What the pick reads; default: the engine-health file and the usage history on disk. */
  inputs?: { health?: EngineHealthReading; limits?: FallbackLimitReadings };
}

export interface AccountPin {
  /**
   * What the session's profile column takes: the picked account's directory; `null` for a
   * switch whose pick is the employee's own login (it clears an earlier pin); undefined for
   * nothing to store (no balancing, or a new session whose pick is the employee's own login).
   */
  claudeConfigDir?: string | null;
  /**
   * An opencode session: the model the pick pins it to, `<picked provider>/<model key>`, which goes to the session's `model`
   * column wherever `claudeConfigDir` is applied. Absent when the pick is the session's own account (the model stays as
   * requested); for a switch re-picking onto the own account, the own-provider spelling, which puts an earlier pin back.
   */
  model?: string;
  accountPick?: AccountPick;
  /**
   * A remote employee's session: the declared remote account it is pinned to (written to `transportMeta.remoteAccountPin`),
   * or `null` for a switch whose pick is the employee's own login (it removes an earlier pin). Undefined for a local
   * session, or when there is nothing to store. Never the profile column: that is a directory on the gateway.
   */
  remoteAccountPin?: RemoteAccountPin | null;
}

/**
 * The chain a Claude session of this employee (else of the instance default) runs under, and where it came from. A remote
 * employee's session resolves as it does today: its employee's chain, else the engine's (engine mode).
 */
function chainOf(config: HundredfoldConfig, employee: Employee | undefined, ownAccount: string): { source: FallbackChainSource; entries: readonly FallbackChainEntry[] } {
  if (employee?.fallback !== undefined) return { source: "employee", entries: employee.fallback };
  return inheritedChain(config, "claude", isRemoteTarget(employee) ? "engine" : "account", ownAccount);
}

/** What the start pick works from: the home group, where its chain came from and the account the session would otherwise run as. */
interface FoundHome {
  home: HomeGroup;
  source: FallbackChainSource;
  entries: readonly FallbackChainEntry[];
  ownAccount: string;
  /** An opencode session's own model, spelled on its own account's provider: what a pick of another member re-spells, and a switch onto the own account puts back. */
  ownModel?: string;
}

/**
 * The home group of a Claude session of `employee`: the group at the head of its chain that holds its own login. A remote
 * employee's own login is the member naming no profile, or the declared remote account of its own directory.
 */
function claudeHomeOf(args: AccountPinArgs): FoundHome | undefined {
  const { config, employee } = args;
  if (args.namedProfile) return undefined;
  const ownAccount = accountForEmployee(employee, "claude");
  const { source, entries } = chainOf(config, employee, ownAccount);
  const home = source === "none" ? undefined : homeGroupOf(config, entries, ownAccount, isRemoteTarget(employee) ? ownAccount : undefined);
  return home && { home, source, entries, ownAccount };
}

/** The chain an opencode session of this employee (else of the instance default) runs under: the employee's own, else the engine's. */
function opencodeChainOf(config: HundredfoldConfig, employee: Employee | undefined): { source: FallbackChainSource; entries: readonly FallbackChainEntry[] } {
  if (employee?.fallback !== undefined) return { source: "employee", entries: employee.fallback };
  return inheritedChain(config, "opencode", "engine", "opencode");
}

/**
 * The home group of an opencode session: the opencode group at the head of its chain that holds its own account, the declared
 * account whose provider serves its own model. The own model is the requested one, else the subject's (the employee's, else the
 * engine's). A requested model on another provider than the subject's own is a chosen account, the counterpart of `claude:<name>`:
 * nothing is balanced. One on the own provider is balanced across the members that serve its key.
 */
function opencodeHomeOf(args: AccountPinArgs): FoundHome | undefined {
  const { config, employee } = args;
  const requested = args.model?.trim() || undefined;
  const subjectModel = opencodeOwnModel(config, employee?.engine === "opencode" ? employee.model : undefined);
  const ownModel = requested ?? subjectModel;
  if (ownModel === undefined || namesOtherAccount(requested, subjectModel)) return undefined;
  const { source, entries } = opencodeChainOf(config, employee);
  const home = source === "none" ? undefined : opencodeHomeGroupOf(config, entries, ownModel);
  return home && { home, source, entries, ownAccount: home.ownAccount, ownModel };
}

/** Whether a requested model is on another provider than the subject's own: a chosen account, never balanced. */
function namesOtherAccount(requested: string | undefined, subjectModel: string | undefined): boolean {
  return Boolean(requested && subjectModel && opencodeProviderOf(requested) !== opencodeProviderOf(subjectModel));
}

/** The home group of a session starting on `engine`, when it is one the balancer serves. */
function homeOf(args: AccountPinArgs): FoundHome | undefined {
  if (args.engine === "opencode") return opencodeHomeOf(args);
  return args.engine === "claude" ? claudeHomeOf(args) : undefined;
}

/** Where the pick's candidates are judged: on the gateway, or on the employee's host (a profile there only on its own `user@host`). */
function scopeOf(employee: Employee | undefined): FallbackChainSpec["scope"] {
  const scoped = runsOnlyOnClaude(employee?.name);
  return isRemoteTarget(employee) ? { scoped, remote: true, host: sshDestination(employee) } : { scoped, remote: false };
}

/** The environment a pick reads: the registry (on a remote employee's host, what is installed there) and the health of the machine the session runs on. */
function pickEnv(args: AccountPinArgs): FallbackChainEnv {
  const { config, employee } = args;
  const registry = getModelRegistry(config);
  // Health about another host's login says nothing about this one: a remote employee's pick reads its own host's records.
  const health = args.inputs?.health ?? readEngineHealth();
  const host = isRemoteTarget(employee) ? sshDestination(employee) : undefined;
  return {
    config,
    registry: availabilityRegistry(registry, (candidate) => registry[candidate]?.available === true && (args.engine !== "opencode" || host === undefined || engineInstalledWhereRun(config, candidate, host))),
    health: isRemoteTarget(employee) ? engineHealthForTarget(health, employee) : health,
    ...(args.inputs?.limits ? { limits: args.inputs.limits } : {}),
    ...(args.now ? { now: args.now } : {}),
  };
}

/** What a new session would be balanced onto now: the chain resolved for the session (its own target first), then the start pick over the home group. */
function startPickFor(args: AccountPinArgs, found: FoundHome): AccountPick | undefined {
  const { config, employee } = args;
  const { home, source, entries, ownAccount, ownModel } = found;
  const env = pickEnv(args);
  // The same resolution `fallback-chain-subjects.ts` makes for an opencode subject: the own target is the model the session runs.
  const spec: FallbackChainSpec = ownModel === undefined
    ? {
      own: ownTargetLink(config, { engine: "claude", model: args.model ?? undefined, account: ownAccount }),
      ownAccount, claudeAccount: ownAccount, entries, mode: isRemoteTarget(employee) ? "engine" : "account", scope: scopeOf(employee),
    }
    : { own: ownTargetLink(config, { engine: "opencode", model: ownModel }), ownAccount: "opencode", entries, mode: "engine", scope: scopeOf(employee) };
  const [, ...effective] = resolveFallbackLinks(env, spec);
  return startPickOf(env, home, effective, { source, ownAccount, model: ownModel ?? args.model ?? undefined });
}

/** The model an opencode pick pins the session to: its own model key on the picked account's provider. */
function opencodePinnedModel(found: FoundHome, picked: string): string | undefined {
  const provider = opencodeAccountKeyProvider(picked);
  const key = opencodeModelKeyOf(found.ownModel);
  return provider === undefined || key === undefined ? undefined : `${provider}/${key}`;
}

/** Where a pick other than the session's own account pins it: a local profile's directory, a remote employee's declared remote account, or an opencode session's model. */
function pinnedTo(args: AccountPinArgs, found: FoundHome, picked: string): Pick<AccountPin, "claudeConfigDir" | "remoteAccountPin" | "model"> | undefined {
  if (found.ownModel !== undefined) {
    const model = opencodePinnedModel(found, picked);
    return model === undefined ? undefined : { model };
  }
  if (isRemoteTarget(args.employee)) {
    const declared = declaredRemoteAccountByKey(args.config, picked);
    return declared && { remoteAccountPin: { account: declared.key, configDir: declared.configDir } };
  }
  const dir = declaredAccountByKey(args.config, picked)?.profile.dir;
  return dir === undefined ? undefined : { claudeConfigDir: dir };
}

/**
 * What a pick equal to the session's own account stores: nothing for a new session; for a switch, the removal of an earlier pin
 * (an opencode session's model goes back to the own account's spelling).
 */
function ownLoginPin(args: AccountPinArgs, found: FoundHome): Pick<AccountPin, "claudeConfigDir" | "remoteAccountPin" | "model"> {
  if (args.trigger !== "switch") return {};
  if (found.ownModel !== undefined) return { model: found.ownModel };
  return isRemoteTarget(args.employee) ? { remoteAccountPin: null } : { claudeConfigDir: null };
}

/** The pick for a session of `employee` starting now on Claude or opencode, and where it pins the session. */
export function pinAccountAtCreation(args: AccountPinArgs): AccountPin {
  const found = homeOf(args);
  const pick = found && startPickFor(args, found);
  if (!found || !pick) return {};
  const accountPick: AccountPick = { ...pick, trigger: args.trigger ?? "start" };
  if (pick.picked === found.ownAccount) return { accountPick, ...ownLoginPin(args, found) };
  const pinned = pinnedTo(args, found, pick.picked);
  return pinned ? { accountPick, ...pinned } : {};
}

/** The session's transport meta with the pick recorded (and the remote account pin, for a remote employee's session), or the meta as it was when there is none. */
export function metaWithAccountPick(meta: JsonObject | undefined, pin: Pick<AccountPin, "accountPick" | "remoteAccountPin"> | undefined): JsonObject | undefined {
  const picked = pin?.accountPick ? { ...(meta ?? {}), accountPick: pin.accountPick as unknown as JsonObject } : meta;
  return metaWithRemoteAccountPin(picked, pin?.remoteAccountPin ?? undefined);
}

/** Charges a start that really happened to the account it picked. Call it once, right after the session row was created; never for a validation or a preview. */
export function chargeAccountStart(pin: Pick<AccountPin, "accountPick"> | undefined): void {
  if (pin?.accountPick) recordAccountStart(pin.accountPick);
}

/** The groups a config writes in the chains it holds (the Claude engine's, each declared Claude account's and the opencode engine's), as one comparable string. */
function accountGroupsOf(config: HundredfoldConfig): string {
  const chains = [config.engines.claude?.fallback, ...declaredClaudeAccounts(config).map((account) => account.fallback), config.engines.opencode?.fallback];
  return JSON.stringify(chains.map((chain) => (chain ?? []).flatMap((entry) => fallbackGroupOf(entry) ?? [])));
}

/** A config reload that changes a group forgets the credits: they were earned under the old rotation and mean nothing for the new one. Any other reload leaves them. */
export function resetCreditsOnGroupChange(previous: HundredfoldConfig, next: HundredfoldConfig): void {
  if (accountGroupsOf(previous) !== accountGroupsOf(next)) resetAccountCredits();
}
