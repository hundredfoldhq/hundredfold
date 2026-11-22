import { declaredAccountByKey, declaredClaudeAccounts, declaredRemoteAccountByKey } from "../shared/claude-accounts-config.js";
import { accountForEmployee } from "../shared/engine-account.js";
import { engineHealthForTarget, readEngineHealth, type EngineHealthReading } from "../shared/engine-health.js";
import { startPickOf, homeGroupOf, type HomeGroup } from "../shared/fallback-chain-group.js";
import type { FallbackLimitReadings } from "../shared/fallback-chain-health.js";
import { ownTargetLink } from "../shared/fallback-chain-links.js";
import { inheritedChain, resolveFallbackLinks, type FallbackChainSpec } from "../shared/fallback-chain.js";
import { fallbackGroupOf, type AccountPick, type FallbackChainEntry, type FallbackChainSource } from "../shared/fallback-chain-wire.js";
import { recordAccountStart, resetAccountCredits } from "../shared/fallback-account-pick.js";
import { getModelRegistry } from "../shared/models.js";
import { isRemoteTarget, sshDestination } from "../shared/remote-target.js";
import type { Employee, HundredfoldConfig, JsonObject } from "../shared/types.js";
import { availabilityRegistry } from "./availability-registry.js";
import { metaWithRemoteAccountPin, type RemoteAccountPin } from "./remote-account-pin.js";
import { runsOnlyOnClaude } from "./scoped-engine.js";

/**
 * Where a new Claude session's account is chosen: the one function every start
 * path asks (docs/design/fallback-account-groups.md, "Every way a session
 * starts"). When the session's chain opens with a group holding its own login,
 * the balancer picks a member, the session is pinned to it (the profile column
 * a chosen profile already uses; for a remote employee's session, whose profile
 * is a directory on its host, `transportMeta.remoteAccountPin`) and the pick is
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
  /** The engine the session starts on: only `claude` is balanced. */
  engine: string;
  /** The model the session runs, when known: it decides which model-scoped usage windows apply. */
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

/**
 * The home group of a Claude session of `employee`: the group at the head of its chain that holds its own login. A remote
 * employee's own login is the member naming no profile, or the declared remote account of its own directory.
 */
function homeOf(args: AccountPinArgs): { home: HomeGroup; source: FallbackChainSource; entries: readonly FallbackChainEntry[]; ownAccount: string } | undefined {
  const { config, employee } = args;
  if (args.engine !== "claude" || args.namedProfile) return undefined;
  const ownAccount = accountForEmployee(employee, "claude");
  const { source, entries } = chainOf(config, employee, ownAccount);
  const home = source === "none" ? undefined : homeGroupOf(config, entries, ownAccount, isRemoteTarget(employee) ? ownAccount : undefined);
  return home && { home, source, entries, ownAccount };
}

/** Where the pick's candidates are judged: on the gateway, or on the employee's host (a profile there only on its own `user@host`). */
function scopeOf(employee: Employee | undefined): FallbackChainSpec["scope"] {
  const scoped = runsOnlyOnClaude(employee?.name);
  return isRemoteTarget(employee) ? { scoped, remote: true, host: sshDestination(employee) } : { scoped, remote: false };
}

/** What a new session would be balanced onto now: the chain resolved for the session (its own target first), then the start pick over the home group. */
function startPickFor(args: AccountPinArgs, found: NonNullable<ReturnType<typeof homeOf>>): AccountPick | undefined {
  const { config, employee } = args;
  const { home, source, entries, ownAccount } = found;
  const registry = getModelRegistry(config);
  // Health about another host's login says nothing about this one: a remote employee's pick reads its own host's records.
  const health = args.inputs?.health ?? readEngineHealth();
  const env = {
    config,
    registry: availabilityRegistry(registry, (candidate) => registry[candidate]?.available === true),
    health: isRemoteTarget(employee) ? engineHealthForTarget(health, employee) : health,
    ...(args.inputs?.limits ? { limits: args.inputs.limits } : {}),
    ...(args.now ? { now: args.now } : {}),
  };
  const model = args.model ?? undefined;
  const spec: FallbackChainSpec = {
    own: ownTargetLink(config, { engine: "claude", model, account: ownAccount }),
    ownAccount, claudeAccount: ownAccount, entries, mode: isRemoteTarget(employee) ? "engine" : "account",
    scope: scopeOf(employee),
  };
  const [, ...effective] = resolveFallbackLinks(env, spec);
  return startPickOf(env, home, effective, { source, ownAccount, model });
}

/** Where a pick other than the employee's own login pins the session: a local profile's directory, or a remote employee's declared remote account. */
function pinnedTo(args: AccountPinArgs, picked: string): Pick<AccountPin, "claudeConfigDir" | "remoteAccountPin"> | undefined {
  if (isRemoteTarget(args.employee)) {
    const declared = declaredRemoteAccountByKey(args.config, picked);
    return declared && { remoteAccountPin: { account: declared.key, configDir: declared.configDir } };
  }
  const dir = declaredAccountByKey(args.config, picked)?.profile.dir;
  return dir === undefined ? undefined : { claudeConfigDir: dir };
}

/** What a pick equal to the employee's own login stores: nothing for a new session; for a switch, the removal of an earlier pin. */
function ownLoginPin(args: AccountPinArgs): Pick<AccountPin, "claudeConfigDir" | "remoteAccountPin"> {
  if (args.trigger !== "switch") return {};
  return isRemoteTarget(args.employee) ? { remoteAccountPin: null } : { claudeConfigDir: null };
}

/** The pick for a Claude session of `employee` starting now, and where it pins the session. */
export function pinAccountAtCreation(args: AccountPinArgs): AccountPin {
  const found = homeOf(args);
  const pick = found && startPickFor(args, found);
  if (!found || !pick) return {};
  const accountPick: AccountPick = { ...pick, trigger: args.trigger ?? "start" };
  if (pick.picked === found.ownAccount) return { accountPick, ...ownLoginPin(args) };
  const pinned = pinnedTo(args, pick.picked);
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

/** The groups a config writes in the chains it holds (the engine's and each declared account's), as one comparable string. */
function accountGroupsOf(config: HundredfoldConfig): string {
  const chains = [config.engines.claude?.fallback, ...declaredClaudeAccounts(config).map((account) => account.fallback)];
  return JSON.stringify(chains.map((chain) => (chain ?? []).flatMap((entry) => fallbackGroupOf(entry) ?? [])));
}

/** A config reload that changes a group forgets the credits: they were earned under the old rotation and mean nothing for the new one. Any other reload leaves them. */
export function resetCreditsOnGroupChange(previous: HundredfoldConfig, next: HundredfoldConfig): void {
  if (accountGroupsOf(previous) !== accountGroupsOf(next)) resetAccountCredits();
}
