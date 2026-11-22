import type { Employee, EngineLimitBucket, EngineLimitEngineSnapshot, HundredfoldConfig, ProviderUsage } from "./types.js";
import { goKeyFor, declaredGoProviders, isGoProvider, type GoKeyDeps } from "./opencode-go-key.js";
import { readGoUsage, unavailableUsage, type ReadGoUsageOptions } from "./opencode-go-usage.js";
import { meteredLimitFor } from "./engine-limits-opencode.js";
import { rosterEmployees } from "./engine-limits-accounts.js";

/**
 * The provider's own usage, attached to the opencode limits: which OpenCode Go providers to ask about, what the
 * reading adds (dollar figures from a configured allowance) and how it reaches engine health.
 *
 * hundredfold's turn ledger prices what hundredfold ran; the provider's reading is what the plan has really spent,
 * hand-run opencode included. They are never added together: where the provider answered, its windows stand for
 * the provider and its ledger buckets stay out of the health write (providerHealthBuckets); where it did not, the
 * ledger carries on exactly as before and the card says the reading is unavailable.
 */

export interface GoUsageDeps extends ReadGoUsageOptions, GoKeyDeps {
  employees?: Iterable<Employee>;
  /** The engine's default model, which names the built-in provider a session with no pin runs on. */
  defaultModel?: string;
}

function providerOf(model: string | undefined | null): string | undefined {
  const slash = model === undefined || model === null ? -1 : model.indexOf("/");
  return model !== undefined && model !== null && slash > 0 ? model.slice(0, slash) : undefined;
}

/** The Go providers worth asking about: every declared account's, and the built-in one when the default model or an opencode employee runs on it. */
export function goProvidersInUse(config: HundredfoldConfig, deps: Pick<GoUsageDeps, "employees" | "defaultModel"> = {}): string[] {
  const providers = new Set(declaredGoProviders(config));
  const configured = config.engines.opencode?.model;
  const models = [deps.defaultModel, configured];
  for (const employee of deps.employees ?? rosterEmployees()) {
    if ((employee.engine ?? config.engines.default) === "opencode") models.push(employee.model);
  }
  for (const model of models) {
    const provider = providerOf(model);
    if (provider !== undefined && isGoProvider(config, provider)) providers.add(provider);
  }
  return [...providers].sort();
}

/** Dollar figures for the monthly window, from the allowance configured for the provider (the provider reports only percentages). */
function withDollars(config: HundredfoldConfig, provider: string, usage: ProviderUsage): ProviderUsage {
  const monthly = usage.windows?.find((window) => window.name === "30d");
  const limit = meteredLimitFor(config, `${provider}/*`);
  if (limit === undefined || monthly?.usedPercent === undefined) return usage;
  const consumed = Math.round((monthly.usedPercent / 100) * limit * 100) / 100;
  return { ...usage, monthlyLimitUsd: limit, consumedUsd: consumed, remainingUsd: Math.round((limit - consumed) * 100) / 100 };
}

/** One reading per Go provider in use, keyed by provider id. Reads concurrently; never throws. */
export async function collectGoUsage(config: HundredfoldConfig, deps: GoUsageDeps = {}): Promise<Map<string, ProviderUsage>> {
  const providers = goProvidersInUse(config, deps);
  const readings = await Promise.all(providers.map(async (provider): Promise<[string, ProviderUsage]> => {
    const key = goKeyFor(config, provider, deps);
    const usage = key === undefined ? unavailableUsage("no-key", deps.now) : await readGoUsage(key, deps);
    return [provider, withDollars(config, provider, usage)];
  }));
  return new Map(readings);
}

/**
 * The engine snapshot with the provider's reading on it, when the engine's own default provider is a Go provider
 * and has one that no declared account covers (an account's card carries its own). A reading that arrived turns an
 * engine that had nothing to meter into a snapshot; one that did not leaves every other field as it was.
 */
export function withEngineUsage(
  snap: EngineLimitEngineSnapshot,
  config: HundredfoldConfig,
  usage: ReadonlyMap<string, ProviderUsage>,
): EngineLimitEngineSnapshot {
  const provider = providerOf(config.engines.opencode?.model ?? snap.defaultModel);
  const reading = provider === undefined ? undefined : usage.get(provider);
  if (provider === undefined || reading === undefined || declaredGoProviders(config).includes(provider)) return snap;
  if (reading.status !== "ok" || !snap.available) return { ...snap, providerUsage: reading };
  const { unsupportedReason: _reason, ...rest } = snap;
  return { ...rest, status: "snapshot", providerUsage: reading };
}

/** The window a provider reading puts into health: spent when the provider says rate-limited, whatever its rounded percentage. */
function healthBucket(provider: string, usage: ProviderUsage): EngineLimitBucket {
  return {
    id: `${provider}/*`,
    name: `${provider}/*`,
    windows: (usage.windows ?? []).map((window) => ({ ...window, usedPercent: window.limited ? 100 : window.usedPercent })),
  };
}

/**
 * The buckets the health meter reads: the ledger's, minus the providers the provider itself answered for, plus one
 * bucket of its own windows for each of them. A provider whose reading is unavailable keeps its ledger buckets.
 */
export function providerHealthBuckets(
  buckets: readonly EngineLimitBucket[] | undefined,
  usage: ReadonlyMap<string, ProviderUsage>,
): EngineLimitBucket[] {
  const answered = [...usage].filter(([, reading]) => reading.status === "ok");
  const covered = new Set(answered.map(([provider]) => provider));
  const kept = (buckets ?? []).filter((bucket) => !covered.has(bucket.id.split("/")[0] ?? ""));
  return [...kept, ...answered.map(([provider, reading]) => healthBucket(provider, reading))];
}

