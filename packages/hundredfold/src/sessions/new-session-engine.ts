import type { Employee, Engine, HundredfoldConfig, JsonObject } from "../shared/types.js";
import { getModelRegistry, type EngineName } from "../shared/models.js";
import { isRemoteTarget, sshDestination } from "../shared/remote-target.js";
import { resolveEmployeeClaudeProfile } from "../shared/claude-profile.js";
import { substituteHealth } from "./rate-limit-account.js";
import { engineHealthForTarget, readEngineHealth } from "../shared/engine-health.js";
import { availabilityRegistry, engineInstalledWhereRun } from "./availability-registry.js";
import { rerouteAtCreation, type RerouteChoice } from "./fallback-reroute.js";
import { logger } from "../shared/logger.js";
import { reroutedSessionMeta } from "./engine-override-window.js";
import { runsOnlyOnClaude } from "./scoped-engine.js";
import { startsOnPreferredEngine } from "./session-fallback.js";
import type { SessionFallbackMode } from "../shared/session-fallback-config.js";
import type { AccountPick } from "../shared/fallback-chain-wire.js";
import { metaWithAccountPick, pinAccountAtCreation, type AccountPin } from "./account-pin.js";
import { metaWithRemoteAccountPin } from "./remote-account-pin.js";

/** What a routed turn brought with it about where the session should run. */
export interface NewSessionEnginePreference {
  engine?: string;
  model?: string;
  effortLevel?: string;
  employee?: Employee;
  /** The mode the new session will carry; absent, the config's. `auto-resume` starts it on its preferred engine. */
  fallbackMode?: SessionFallbackMode;
}

/**
 * The model and effort level the session starts with. A reroute moved off the
 * engine the employee's pair was configured for, so on that path only what the
 * caller named survives and the substitute runs on its own configured defaults,
 * the way a mid-turn fallback already does.
 */
function inheritedDefaults(
  preference: NewSessionEnginePreference,
  rerouted: boolean,
): { model?: string; effortLevel?: string } {
  const employee = rerouted ? undefined : preference.employee;
  return {
    model: preference.model ?? employee?.model ?? undefined,
    effortLevel: preference.effortLevel ?? employee?.effortLevel ?? undefined,
  };
}

/** The scope a new session's chain is judged by: its host, when it runs on one. */
function startScope(destination: string | undefined): { scoped: false; remote: boolean; host?: string } {
  return { scoped: false, remote: destination !== undefined, ...(destination ? { host: destination } : {}) };
}

/**
 * Whether the session starts where it prefers whatever its engine's health says: the caller named an engine or a model,
 * a local named Claude profile (FR-056: its own account, its rate limit walks its own chain; a pinned account is the
 * session's own, so a named login is no reason to start it where it is), a department-scoped employee (it runs only on
 * claude, and a rate limit then moves it between claude accounts only), or a fallback mode that waits out a limit.
 */
function startsWherePreferred(config: HundredfoldConfig, preference: NewSessionEnginePreference, preferred: EngineName, pin: AccountPin): boolean {
  const named = preference.engine !== undefined || preference.model !== undefined;
  const ownAccount = preferred === "claude" && resolveEmployeeClaudeProfile(preference.employee) !== null && pin.accountPick === undefined;
  return named || ownAccount || runsOnlyOnClaude(preference.employee?.name) || startsOnPreferredEngine(config, preference.fallbackMode);
}

/**
 * Where a session that preferred `preferred` should start instead, when that
 * target is out of allowance: the first usable link of its chain that is not out
 * itself (`rerouteAtCreation`). An engine the caller named wins, and so does a
 * named model — a model belongs to exactly one engine — so neither is reordered.
 */
function healthyStart(
  config: HundredfoldConfig,
  engines: Map<string, Engine>,
  preference: NewSessionEnginePreference,
  preferred: EngineName,
  pin: AccountPin,
): RerouteChoice | undefined {
  if (startsWherePreferred(config, preference, preferred, pin)) return undefined;
  // A remote employee's preference may only be reordered within the engines that
  // can actually run on its host. Rerouting it onto one that ignores
  // `remoteHost` would start the session on an engine whose every turn the
  // remote gate then refuses — a session that looks started and can never run.
  // Scoped to the machine this session will actually run on: a login that
  // died on the gateway is no reason to move a remote employee's session.
  const health = substituteHealth(engineHealthForTarget(readEngineHealth(), preference.employee), preference.employee, { claudeConfigDir: pin.claudeConfigDir ?? null, transportMeta: metaWithRemoteAccountPin(undefined, pin.remoteAccountPin ?? undefined) ?? null });
  // Installed where the session will run: a remote employee's on its host.
  const destination = isRemoteTarget(preference.employee) ? sshDestination(preference.employee) : undefined;
  const registry = availabilityRegistry(getModelRegistry(config), (candidate) => engines.has(candidate) && engineInstalledWhereRun(config, candidate, destination));
  return rerouteAtCreation({
    config, employee: preference.employee, engine: preferred, model: preference.employee?.model, registry, health, scope: startScope(destination), pin,
  });
}

/** What the pin adds to the session being created: the profile directory it runs on, and the pick the caller charges once the row exists. */
function pinnedFields(pin: AccountPin): { claudeConfigDir?: string; accountPick?: AccountPick } {
  return { ...(pin.claudeConfigDir ? { claudeConfigDir: pin.claudeConfigDir } : {}), ...(pin.accountPick ? { accountPick: pin.accountPick } : {}) };
}

/**
 * The engine, model and effort level a NEW routed session starts on.
 *
 * Anything the caller did not name is a preference, so a target whose allowance
 * is spent gives way to the first member of its chain that can serve the turn —
 * and the session remembers what it preferred, so it goes back once that
 * allowance returns instead of staying on the stand-in.
 */
export function newSessionEngineSelection(
  config: HundredfoldConfig,
  engines: Map<string, Engine>,
  preference: NewSessionEnginePreference,
  transportMeta?: JsonObject | null,
): { engine: EngineName; model?: string; effortLevel?: string; transportMeta?: JsonObject; claudeConfigDir?: string; accountPick?: AccountPick } {
  const preferred = (preference.engine ?? preference.employee?.engine ?? config.engines.default) as EngineName;
  // The account of a balanced Claude session, picked here and charged by the caller once the session exists.
  const pin = pinAccountAtCreation({ config, employee: preference.employee, engine: preferred, model: preference.model ?? preference.employee?.model });
  const meta = metaWithAccountPick(transportMeta ?? undefined, pin);
  const choice = healthyStart(config, engines, preference, preferred, pin);
  if (!choice) return { engine: preferred, ...inheritedDefaults(preference, false), ...(meta ? { transportMeta: meta } : {}), ...pinnedFields(pin) };
  logger.info(`Engine "${preferred}" is out of allowance — starting this session on "${choice.engine}" instead, until ${choice.reroute.until.toISOString()}`);
  return {
    engine: choice.engine,
    ...inheritedDefaults(preference, true),
    // The chain's own model for the link, when it names one; the employee's model belongs to the target left.
    ...(choice.model ? { model: choice.model } : {}),
    transportMeta: reroutedSessionMeta(choice.reroute, meta),
    ...pinnedFields(pin),
  };
}
