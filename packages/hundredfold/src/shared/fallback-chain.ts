import { readAccountPick } from "../sessions/account-pick-meta.js";
import { ownClaudeAccountOf, ownClaudeProfile } from "../sessions/session-account.js";
import { engineAllowedAsSubstitute, sessionSubstituteScope } from "../sessions/substitute-filters.js";
import { declaredAccountByKey, declaredClaudeAccounts, declaredRemoteAccountByName } from "./claude-accounts-config.js";
import { linkAccount, ownTargetLink } from "./fallback-chain-links.js";
import { accountForEmployee, claudeAccountKey, DEFAULT_CLAUDE_ACCOUNT, isRemoteClaudeAccount } from "./engine-account.js";
import { resolveSubstituteModel } from "./engine-fallback.js";
import { engineChain, expandFallbackChain, type ExpandedFallbackLink, type FallbackExpansionMode } from "./fallback-chain-expand.js";
import { linkHealth } from "./fallback-chain-health.js";
import { orderGroupLinks, type GroupRankInputs } from "./fallback-chain-group.js";
import { opencodeMemberTarget, opencodeOwnModel } from "./fallback-chain-opencode-group.js";
import {
  fallbackGroupOf, fallbackLinkKey, fallbackLinkLabel,
  type AccountPick, type FallbackChainEntry, type FallbackChainSource, type FallbackLink, type FallbackSkipReason, type ResolvedFallbackLink,
} from "./fallback-chain-wire.js";
import { engineSupportsRemote, REMOTE_ENGINE_CLI, type EngineName } from "./models.js";
import { remoteEngineAvailable } from "../engines/remote-stage.js";
import type { Employee, HundredfoldConfig, ModelRegistry, Session } from "./types.js";

export { isLinkExhausted, linkHealthKey } from "./fallback-chain-health.js";
export { linkAccount, ownTargetLink } from "./fallback-chain-links.js";

/**
 * The chain resolver: which targets a subject falls back to, in order, and what
 * each one looks like for it. Pure and read-only: config, the model registry,
 * engine health and the latest cached limits reading go in, a resolved chain
 * comes out. It never probes anything.
 *
 * The runtime walks this chain (`sessions/rate-limit-substitute.ts`); the
 * expansion here visits targets in the order the walkers it replaced did, so a
 * chain written only in strings runs as it always has. See docs/fallback-chains.md.
 */

export interface FallbackChainEnv extends GroupRankInputs {
  config: HundredfoldConfig;
  registry: ModelRegistry;
}

/** What a chain is resolved for: a session, or an engine, account or employee the editor shows. */
export interface FallbackChainSpec {
  /** The target the chain falls back from: index 0 of the resolved chain. */
  own: FallbackLink;
  /** Its account key (`claude`, `claude:<profile key>`, a remote login) or, off Claude, its engine. */
  ownAccount: string;
  /** The account an unprofiled Claude link in an `engine` chain runs as: the subject's own Claude login (a remote employee's, a named profile's). Default: the gateway's own `claude`. */
  claudeAccount?: string;
  entries: readonly FallbackChainEntry[];
  /** `account` for a local Claude subject, else `engine`: see fallback-chain-expand.ts. */
  mode: FallbackExpansionMode;
  /** Department-scoped, and/or running on a remote host (`host`: its ssh destination, when known). */
  scope: { scoped: boolean; remote: boolean; host?: string };
}

/**
 * The model a link runs: its own when it names one. Otherwise, on the session's
 * engine, the session's model; on another engine, the `fallbackModelMap`
 * translation of the session's model, else undefined (the engine's own default).
 */
export function resolveLinkModel(
  config: HundredfoldConfig,
  registry: ModelRegistry,
  session: { engine: string; model?: string | null },
  link: FallbackLink,
): string | undefined {
  if (link.model !== undefined) return link.model;
  if (link.engine === session.engine) return session.model ?? undefined;
  return resolveSubstituteModel(config, registry, { from: session.engine, to: link.engine, model: session.model });
}

/** A profile that is not a declared account, or sits on a link that cannot take one. */
function profileUnknown(config: HundredfoldConfig, link: FallbackLink): boolean {
  if (link.profile === undefined) return false;
  return link.engine !== "claude" || !(declaredClaudeAccounts(config).some((account) => account.name === link.profile) || declaredRemoteAccountByName(config, link.profile));
}

/**
 * Why a profile link cannot run where the subject does, in words; undefined for a link that can (or names no profile).
 * A remote subject takes only an account declared on its own `user@host`; a local one takes no remote account.
 */
function profileHostProblem(config: HundredfoldConfig, scope: FallbackChainSpec["scope"], link: FallbackLink): string | undefined {
  if (link.engine !== "claude" || link.profile === undefined) return undefined;
  const remote = declaredRemoteAccountByName(config, link.profile);
  if (!scope.remote) return remote ? `profile "${link.profile}" is on remote host ${remote.remoteHost}` : undefined;
  if (!remote) return `profile "${link.profile}" is a profile on the gateway, not on ${scope.host ?? "this session's host"}`;
  return remote.destination === scope.host ? undefined : `profile "${link.profile}" is on ${remote.destination}, not this session's host ${scope.host ?? "(unknown)"}`;
}

/** Why the subject's department or host rules the link out: a scoped session takes Claude only, a remote one an engine that runs on a host and a profile only on its own host, a local one no profile on another. */
function scopeSkip(config: HundredfoldConfig, scope: FallbackChainSpec["scope"], link: FallbackLink): "scoped" | "remote" | undefined {
  const engine = link.engine as EngineName;
  if (!engineAllowedAsSubstitute({ scoped: scope.scoped, remote: false }, engine)) return "scoped";
  const remoteRefused = !engineAllowedAsSubstitute({ scoped: false, remote: scope.remote }, engine) || profileHostProblem(config, scope, link) !== undefined;
  return remoteRefused ? "remote" : undefined;
}

/** A model the link names that the registry, which lists models for the engine, does not serve. */
function modelNotServed(entry: ModelRegistry[string], link: FallbackLink): boolean {
  return link.model !== undefined && entry.models.length > 0 && !entry.models.some((model) => model.id === link.model);
}

/** Why a link cannot be used by this subject at all, if it cannot; `exhausted` and `tried` are the walk's to say, not this. */
function skipReason(env: FallbackChainEnv, subject: FallbackChainSpec, link: FallbackLink): FallbackSkipReason | undefined {
  if (profileUnknown(env.config, link)) return "profile-unknown";
  const entry = env.registry[link.engine];
  if (!entry?.available) return "not-installed";
  return scopeSkip(env.config, subject.scope, link) ?? (modelNotServed(entry, link) ? "model-not-served" : undefined);
}

/** What the gateway can add to a skip: the profile that is on another host, or the host that lacks a remote engine's CLI, when its facts say so (an engine the gateway has no adapter for is not the host's fault). */
function skipDetail(config: HundredfoldConfig, scope: FallbackChainSpec["scope"], link: FallbackLink, reason: FallbackSkipReason): string | undefined {
  if (reason === "remote") return profileHostProblem(config, scope, link);
  if (reason !== "not-installed" || !scope.remote || !scope.host || !engineSupportsRemote(link.engine)) return undefined;
  if (remoteEngineAvailable(scope.host, link.engine) !== false) return undefined;
  return `${scope.host} has no \`${REMOTE_ENGINE_CLI[link.engine]}\` on its non-interactive PATH`;
}

/**
 * The provider an opencode target naming no model runs on: the one in `engines.opencode.model`, which is
 * the model a session with no pin starts on. Health is kept per provider, so without it such a target would
 * read only the engine-wide key and never see its own provider (an account, say) out. It is read for health
 * alone: the session's model stays unpinned.
 */
function unpinnedHealthProvider(config: HundredfoldConfig, link: FallbackLink): string | undefined {
  if (link.engine !== "opencode" || link.model !== undefined) return undefined;
  const model = config.engines.opencode?.model;
  const slash = model === undefined ? -1 : model.indexOf("/");
  return model !== undefined && slash > 0 ? model.slice(0, slash) : undefined;
}

function resolvedLink(
  env: FallbackChainEnv, link: FallbackLink, origin: ResolvedFallbackLink["origin"], written: FallbackLink,
  runsAs: { claudeAccount?: string; healthProvider?: string } = {},
): ResolvedFallbackLink {
  const { claudeAccount, healthProvider } = runsAs;
  const account = linkAccount(link, env.config, claudeAccount);
  const identity = {
    ...link, key: fallbackLinkKey(link), account, label: fallbackLinkLabel(link), origin, written: { ...written },
    ...(healthProvider === undefined ? {} : { healthProvider }),
  };
  return { ...identity, health: linkHealth(env, identity) };
}

/** A link with the model it would run, taken from the subject's own target. */
function withModel(env: FallbackChainEnv, subject: FallbackChainSpec, link: FallbackLink): FallbackLink {
  const model = resolveLinkModel(env.config, env.registry, subject.own, link);
  return { engine: link.engine, ...(link.profile === undefined ? {} : { profile: link.profile }), ...(model === undefined ? {} : { model }) };
}

/**
 * The target an expanded link runs and whether it can serve at all. A member of an opencode group is an
 * account, so it runs the subject's own model key on its provider; any other link gets the model rules above.
 */
function targetOf(env: FallbackChainEnv, subject: FallbackChainSpec, link: FallbackLink, group: ExpandedFallbackLink["group"]): { target: FallbackLink; unserved: boolean } {
  if (group && link.engine === "opencode") return opencodeMemberTarget(env.config, link, opencodeOwnModel(env.config, subject.own.model));
  return { target: withModel(env, subject, link), unserved: false };
}

/** An expanded link with the group it came from, and why the subject cannot use it, when it cannot. */
function annotated(
  env: FallbackChainEnv, subject: FallbackChainSpec,
  expanded: { resolved: ResolvedFallbackLink; target: FallbackLink; group: ExpandedFallbackLink["group"]; unserved?: boolean },
): ResolvedFallbackLink {
  const { resolved, target, group, unserved } = expanded;
  const skip = skipReason(env, subject, target) ?? (unserved ? "model-not-served" : undefined);
  const detail = skip ? skipDetail(env.config, subject.scope, target, skip) : undefined;
  const member = group ? { ...resolved, group: { index: group.index, written: group.written } } : resolved;
  return skip ? { ...member, skip, ...(detail ? { skipDetail: detail } : {}) } : member;
}

/** The keys that stand for the subject's own target: its own link, and a remote subject's unprofiled spelling of it (a link naming no profile runs the account it has). */
function ownTargetKeys(subject: FallbackChainSpec, own: ResolvedFallbackLink): string[] {
  const keys = [own.key];
  if (subject.scope.remote && own.profile !== undefined) keys.push(fallbackLinkKey({ engine: own.engine, ...(own.model === undefined ? {} : { model: own.model }) }));
  return keys;
}

/**
 * The key a member of an opencode group has when it is the subject's own account while the subject names no model
 * (it runs the engine's configured one, so the own link's key, `opencode||`, does not spell it). Only a group member is
 * dropped for it: a link a chain names outright stays, as it always has.
 */
function ownMemberKey(config: HundredfoldConfig, own: ResolvedFallbackLink): string | undefined {
  const effective = own.engine === "opencode" && own.model === undefined ? opencodeOwnModel(config, undefined) : undefined;
  return effective === undefined ? undefined : fallbackLinkKey({ engine: "opencode", model: effective });
}

/**
 * The subject's chain, resolved: index 0 is its own target, then the effective
 * chain (legacy strings expanded in place) with each link's model, account,
 * label, health and skip reason. A link that resolves to a target already listed
 * (the own one included) is dropped: it is the same target. The members of a group
 * entry are expanded in place and ordered by usage headroom (fallback-chain-group.ts);
 * the own account, when it is a member, is the own target and drops out of the expansion.
 */
export function resolveFallbackLinks(env: FallbackChainEnv, subject: FallbackChainSpec): ResolvedFallbackLink[] {
  // An account chain names its Claude accounts itself; an engine chain's unprofiled Claude link is the subject's own login.
  const claudeAccount = subject.mode === "engine" ? subject.claudeAccount : undefined;
  const own = resolvedLink(env, subject.own, "config", subject.own, { claudeAccount, healthProvider: unpinnedHealthProvider(env.config, subject.own) });
  const seen = new Set<string>(ownTargetKeys(subject, own));
  const ownMember = ownMemberKey(env.config, own);
  const expanded = expandFallbackChain(env.config, subject.entries, { mode: subject.mode, selfAccount: subject.ownAccount, selfKey: own.key });
  const links: ResolvedFallbackLink[] = [own];
  for (const { link, origin, group } of expanded) {
    const { target, unserved } = targetOf(env, subject, link, group);
    const resolved = resolvedLink(env, target, origin, link, { claudeAccount });
    if (seen.has(resolved.key) || (group && resolved.key === ownMember)) continue;
    seen.add(resolved.key);
    links.push(annotated(env, subject, { resolved, target, group, unserved }));
  }
  // An opencode subject naming no model runs the engine's configured one, which is the model its group is ranked for.
  const rankModel = own.engine === "opencode" ? opencodeOwnModel(env.config, own.model) : own.model;
  return links.some((link) => link.group) ? orderGroupLinks(env, links, rankModel) : links;
}

/**
 * The chain a target inherits when no session or employee names one: its
 * declared account's, else (for the default profile and every other engine) its
 * engine's. A named local profile that is not declared has none.
 */
export function inheritedChain(
  config: HundredfoldConfig, engine: string, mode: FallbackExpansionMode, ownAccount: string,
): { source: Exclude<FallbackChainSource, "session">; entries: readonly FallbackChainEntry[] } {
  if (mode === "account" && ownAccount !== DEFAULT_CLAUDE_ACCOUNT) {
    const declared = declaredAccountByKey(config, ownAccount);
    return declared ? { source: "account", entries: declared.fallback ?? [] } : { source: "none", entries: [] };
  }
  return { source: "engine", entries: engineChain(config, engine) };
}

/** Which chain a session gets, first match wins: its own target, its employee's chain, then what its account and engine give. */
function chainSource(
  config: HundredfoldConfig, session: Session, employee: Employee | undefined, mode: FallbackExpansionMode, ownAccount: string,
): { source: FallbackChainSource; entries: readonly FallbackChainEntry[] } {
  const target = session.fallbackTarget;
  if (target) return { source: "session", entries: [{ engine: target.engine, model: target.model }] };
  const picked = mode === "account" ? readAccountPick(session.transportMeta) : undefined;
  const fromPick = picked && pickedChainSource(config, picked, employee);
  if (fromPick) return fromPick;
  if (employee?.fallback !== undefined) return { source: "employee", entries: employee.fallback };
  return inheritedChain(config, session.engine, mode, ownAccount);
}

/** The chain a pick came from, when it still holds a group at the entry the pick recorded. */
function holdingGroup<T extends { entries: readonly FallbackChainEntry[] }>(chain: T | undefined, pick: AccountPick): T | undefined {
  return chain && fallbackGroupOf(chain.entries[pick.groupIndex]) !== null ? chain : undefined;
}

/**
 * The chain a balanced session keeps: the one its pick came from (`accountPick.source`), not the
 * pinned account's own. The group lives in its employee's chain, in the chain of the employee's own
 * login, or in the engine's, whichever the pick names; undefined when that chain no longer holds the
 * group at the recorded entry (edited since), and the session then resolves as any other.
 */
function pickedChainSource(
  config: HundredfoldConfig, pick: AccountPick, employee: Employee | undefined,
): { source: FallbackChainSource; entries: readonly FallbackChainEntry[] } | undefined {
  if (pick.source === "employee") return holdingGroup(employee?.fallback === undefined ? undefined : { source: "employee" as const, entries: employee.fallback }, pick);
  if (pick.source === "engine") return holdingGroup({ source: "engine" as const, entries: engineChain(config, "claude") }, pick);
  if (pick.source !== "account") return undefined;
  const inherited = inheritedChain(config, "claude", "account", accountForEmployee(employee, "claude"));
  return holdingGroup(inherited.source === "account" ? inherited : undefined, pick);
}

export interface SessionFallbackChainOptions extends GroupRankInputs {
  config: HundredfoldConfig;
  employee?: Employee;
  session: Session;
  registry: ModelRegistry;
  /** The department and host rules, when the caller already knows them (a turn that ran on a remote target the roster does not name). Default: read from the session and employee. */
  scope?: FallbackChainSpec["scope"];
}

/**
 * A session's chain, resolved: its own fallback target (one link), else its
 * employee's `fallback`, else its declared account's chain, else its engine's
 * default. A named local profile that is not declared and whose employee writes
 * no `fallback` has none (source `none`: it waits for its own reset). A balanced
 * session (one the account balancer pinned: `transportMeta.accountPick`) resolves
 * against the chain its pick came from instead of the pinned account's own.
 */
export function sessionFallbackChain(options: SessionFallbackChainOptions): { source: FallbackChainSource; links: ResolvedFallbackLink[] } {
  const { config, employee, session, registry, scope: givenScope, ...inputs } = options;
  const scope = givenScope ?? sessionSubstituteScope(session, employee, config);
  const mode: FallbackExpansionMode = session.engine === "claude" && !scope.remote ? "account" : "engine";
  // The session's own Claude login: the profile it was started on, else its employee's.
  const claudeAccount = ownClaudeAccountOf(session, employee);
  const ownAccount = session.engine === "claude" ? claudeAccount : session.engine;
  // A remote subject's own link names the declared remote account it runs as, so a chain naming that account is the same target.
  const remoteOwn = isRemoteClaudeAccount(ownAccount) ? ownAccount : undefined;
  const ownProfile = session.engine === "claude" ? (scope.remote ? remoteOwn : claudeAccountKey(ownClaudeProfile(session, employee))) : undefined;
  const own = ownTargetLink(config, { engine: session.engine, model: session.model, account: ownProfile });
  const { source, entries } = chainSource(config, session, employee, mode, ownAccount);
  const env: FallbackChainEnv = { config, registry, ...inputs };
  return { source, links: resolveFallbackLinks(env, { own, ownAccount, claudeAccount, entries, mode, scope }) };
}
