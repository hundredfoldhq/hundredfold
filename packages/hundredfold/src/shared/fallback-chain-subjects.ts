import { declaredAccountByKey, declaredClaudeAccounts, declaredRemoteClaudeAccounts, type DeclaredClaudeAccount } from "./claude-accounts-config.js";
import { accountForEmployee, DEFAULT_CLAUDE_ACCOUNT } from "./engine-account.js";
import { employeeOwnLink } from "./employee-fallback.js";
import type { FallbackExpansionMode } from "./fallback-chain-expand.js";
import {
  inheritedChain, ownTargetLink, resolveFallbackLinks,
  type FallbackChainEnv, type FallbackChainSpec,
} from "./fallback-chain.js";
import { homeGroupOf, startPickOf } from "./fallback-chain-group.js";
import {
  fallbackGroupOf, fallbackLinkOf,
  type AccountPick, type FallbackChainEntry, type FallbackChainSource, type FallbackChainSubject, type FallbackChainsResponse, type FallbackProfileOption, type ResolvedFallbackLink,
} from "./fallback-chain-wire.js";
import { duplicateProblemsByChain } from "./fallback-chain-load.js";
import { ENGINE_NAMES } from "./models.js";
import { opencodeCatalogue, opencodeClones } from "./opencode-catalogue.js";
import { opencodeChainContext, opencodeChainProblems } from "./opencode-accounts.js";
import type { Employee, HundredfoldConfig, ModelRegistry } from "./types.js";
import { opencodeAccountKeyEnvironment } from "./child-env.js";

/**
 * The chains the editor shows (`GET /api/fallback-chains`): one subject per
 * engine, one per declared Claude account and, on request, one for an employee.
 * Each carries the chain as written, normalised to links, and the chain that
 * would run after legacy expansion, resolved the way a session's is.
 */

/** The target an engine or account falls back from: its default model, as configured or as the registry names it. */
function defaultModel(config: HundredfoldConfig, registry: ModelRegistry, engine: string): string | undefined {
  const section = (config.engines as unknown as Record<string, { model?: string } | undefined>)[engine];
  return section?.model ?? registry[engine]?.defaultModel ?? undefined;
}

/** The declared accounts a chain may name, as the editor's profile picker lists them: the local ones, then those on other hosts (marked `remote`). */
export function fallbackProfiles(config: HundredfoldConfig): FallbackProfileOption[] {
  return [
    ...declaredClaudeAccounts(config).map((account) => ({ name: account.name, account: account.key, configDir: account.profile.dir })),
    ...declaredRemoteClaudeAccounts(config).map((account) => ({
      name: account.name, account: account.key, configDir: account.configDir, remote: { host: account.remoteHost, destination: account.destination },
    })),
  ];
}

/** The chain as written, normalised: each entry a link, a group kept whole; null when nothing is written. */
function configuredOf(written: readonly FallbackChainEntry[] | undefined): FallbackChainSubject["configured"] {
  return written === undefined ? null : written.flatMap((entry) => fallbackGroupOf(entry) ?? fallbackLinkOf(entry) ?? []);
}

function subjectOf(
  env: FallbackChainEnv, identity: Pick<FallbackChainSubject, "kind" | "id">, spec: FallbackChainSpec, written: readonly FallbackChainEntry[] | undefined,
  extra: { problems?: readonly string[]; pickSource?: Exclude<FallbackChainSource, "session"> } = {},
): FallbackChainSubject {
  const { problems = [], pickSource } = extra;
  const [primary, ...effective] = resolveFallbackLinks(env, spec);
  const startPick = pickSource === undefined ? undefined : subjectStartPick(env, spec, effective, pickSource, primary?.model);
  return {
    ...(problems.length > 0 ? { problems: [...problems] } : {}),
    ...identity,
    primary: primary ?? null,
    configured: configuredOf(written),
    legacy: written?.some((entry) => typeof entry === "string") ?? false,
    effective,
    ...(startPick ? { startPick } : {}),
  };
}

/** What a new session of this subject would be balanced onto now, when its chain opens with a group holding its own account (a local Claude subject only). */
function subjectStartPick(
  env: FallbackChainEnv, spec: FallbackChainSpec, effective: readonly ResolvedFallbackLink[], source: Exclude<FallbackChainSource, "session">, model: string | undefined,
): AccountPick | undefined {
  if (spec.mode !== "account" || spec.scope.remote || spec.own.engine !== "claude") return undefined;
  const home = homeGroupOf(env.config, spec.entries, spec.ownAccount);
  return home ? startPickOf(env, home, effective, { source, ownAccount: spec.ownAccount, model }) : undefined;
}

const OPEN_SCOPE = { scoped: false, remote: false };

/** The opencode links of a written chain that name a model or account opencode does not serve, or an account with no key. Advisory: the catalogue is not known at load. */
function opencodeProblems(env: FallbackChainEnv, where: string, chain: readonly FallbackChainEntry[] | undefined): string[] {
  return opencodeChainProblems(where, chain, opencodeChainContext(env.config, opencodeCatalogue(), opencodeAccountKeyEnvironment(), opencodeClones()));
}

/** An engine's default chain, `engines.<engine>.fallback`. */
export function engineSubject(env: FallbackChainEnv, engine: string): FallbackChainSubject {
  const written = (env.config.engines as unknown as Record<string, { fallback?: FallbackChainEntry[] } | undefined>)[engine]?.fallback;
  const mode: FallbackExpansionMode = engine === "claude" ? "account" : "engine";
  const own = ownTargetLink(env.config, { engine, model: defaultModel(env.config, env.registry, engine) });
  const problems = [...(duplicateProblemsByChain(env.config.engines)[`engines.${engine}.fallback`] ?? []), ...opencodeProblems(env, `engines.${engine}.fallback`, written)];
  const ownAccount = engine === "claude" ? DEFAULT_CLAUDE_ACCOUNT : engine;
  return subjectOf(env, { kind: "engine", id: engine }, { own, ownAccount, entries: written ?? [], mode, scope: OPEN_SCOPE }, written, { problems, pickSource: "engine" });
}

/** A declared Claude account's chain, `engines.claude.accounts.<name>.fallback`. */
export function accountSubject(env: FallbackChainEnv, account: DeclaredClaudeAccount): FallbackChainSubject {
  const model = defaultModel(env.config, env.registry, "claude");
  const own = { engine: "claude", profile: account.name, ...(model ? { model } : {}) };
  const spec: FallbackChainSpec = { own, ownAccount: account.key, entries: account.fallback ?? [], mode: "account", scope: OPEN_SCOPE };
  const where = `engines.claude.accounts.${account.name}.fallback`;
  const problems = [...(duplicateProblemsByChain(env.config.engines)[where] ?? []), ...opencodeProblems(env, where, account.fallback)];
  return subjectOf(env, { kind: "account", id: account.name }, spec, account.fallback, { problems });
}

/** Where an employee's chain comes from, and the account or engine that names it. */
function inheritedSource(
  config: HundredfoldConfig, engine: string, ownAccount: string, source: FallbackChainSource | undefined,
): { source: Exclude<FallbackChainSource, "session">; sourceId?: string } {
  if (source === undefined) return { source: "employee" };
  if (source === "account") return { source, sourceId: declaredAccountByKey(config, ownAccount)?.name };
  return source === "engine" ? { source, sourceId: engine } : { source: "none" };
}

/**
 * An employee's chain: its own `fallback` when it writes one, else what its
 * account and engine give it. `scope` is what the employee's department and host
 * make of its links (department-scoped, remote), which the caller knows.
 */
export function employeeSubject(env: FallbackChainEnv, employee: Employee, scope: FallbackChainSpec["scope"]): FallbackChainSubject {
  const ownAccount = accountForEmployee(employee, employee.engine);
  const mode: FallbackExpansionMode = employee.engine === "claude" && !scope.remote ? "account" : "engine";
  const inherited = employee.fallback === undefined ? inheritedChain(env.config, employee.engine, mode, ownAccount) : undefined;
  const entries = employee.fallback ?? inherited?.entries ?? [];
  const own = employeeOwnLink(env.config, employee);
  const where = inheritedSource(env.config, employee.engine, ownAccount, inherited?.source);
  const spec: FallbackChainSpec = { own, ownAccount, claudeAccount: accountForEmployee(employee, "claude"), entries, mode, scope };
  const subject = { ...subjectOf(env, { kind: "employee", id: employee.name }, spec, employee.fallback, { pickSource: where.source }), ...where };
  const problems = [...(employee.fallbackProblems ?? []), ...opencodeProblems(env, "fallback", employee.fallback)];
  return problems.length > 0 ? { ...subject, problems } : subject;
}

/** The whole response: profiles, every engine and every declared account, and the employee when one is asked for. */
export function fallbackChainsResponse(
  env: FallbackChainEnv,
  /** `registry`: the employee's own, when its links are judged elsewhere than this gateway (a remote host). */
  employee?: { employee: Employee; scope: FallbackChainSpec["scope"]; registry?: ModelRegistry },
): FallbackChainsResponse {
  const engines = ENGINE_NAMES.filter((name) => env.registry[name] !== undefined || name === "claude");
  return {
    profiles: fallbackProfiles(env.config),
    subjects: [
      ...engines.map((name) => engineSubject(env, name)),
      ...declaredClaudeAccounts(env.config).map((account) => accountSubject(env, account)),
      ...(employee ? [employeeSubject(employee.registry ? { ...env, registry: employee.registry } : env, employee.employee, employee.scope)] : []),
    ],
  };
}
