import { recordUsageSample, usageHistoryPath, type UsageSample, type UsageSampleWindow } from "./claude-usage-history.js";
import { opencodeAccountKey } from "./fallback-chain-opencode-group.js";
import { declaredOpencodeAccounts } from "./opencode-accounts-config.js";
import type { EngineLimitBucket, EngineLimitWindow, HundredfoldConfig } from "./types.js";

/**
 * The per-account usage history of opencode accounts, which the account balancer
 * reads as headroom (docs/design/fallback-account-groups.md, section 10). One
 * history per declared account, keyed `opencode/<provider>` and kept beside the
 * Claude ones with the same collapse, retention and cap (claude-usage-history.ts).
 *
 * The samples come from what the engine-health refresh already computes per
 * provider (`providerHealthBuckets`): the provider's own meter where it answered,
 * else the turn ledger's buckets. No reading means no sample, so an account the
 * meter cannot see is unknown to the balancer, never a made-up full headroom.
 */

/** The windows an opencode account keeps, and their lengths in seconds (for a window that names no reset). */
const WINDOW_SECONDS: Record<string, number> = { "5h": 5 * 3600, "7d": 7 * 86_400, "30d": 30 * 86_400 };

/**
 * A window as a sample window, or undefined when it is not one to keep. `scope` is the model key a
 * per-model ledger bucket stands for (absent for an unscoped window): the window is then named
 * `<window> <model key>` and applies only to a session on exactly that model. A window that names no
 * reset (a trailing window is spent only at its limit) is held to its own length from the reading: its
 * usage cannot outlive the window it is measured over.
 */
function sampleWindow(window: EngineLimitWindow, scope: string | undefined, nowMs: number): UsageSampleWindow | undefined {
  const seconds = WINDOW_SECONDS[window.name];
  if (seconds === undefined || window.usedPercent === undefined) return undefined;
  const resetsAt = window.resetsAt ?? Math.ceil(nowMs / 1000) + seconds;
  return { name: scope === undefined ? window.name : `${window.name} ${scope}`, usedPercent: window.usedPercent, resetsAt };
}

/** What a bucket id says of the model it meters under `provider`: `*` for the whole provider, else the model key; undefined for another provider's bucket. */
function bucketScope(bucketId: string, provider: string): string | undefined {
  const prefix = `${provider}/`;
  if (!bucketId.startsWith(prefix)) return undefined;
  const rest = bucketId.slice(prefix.length);
  return rest === "" ? undefined : rest;
}

/** One provider's sample from the health buckets, or undefined when no bucket of it holds a window to keep. */
export function opencodeSampleFromBuckets(buckets: readonly EngineLimitBucket[], provider: string, nowMs: number): UsageSample | undefined {
  const windows = buckets.flatMap((bucket) => {
    const scope = bucketScope(bucket.id, provider);
    if (scope === undefined) return [];
    return (bucket.windows ?? []).flatMap((window) => sampleWindow(window, scope === "*" ? undefined : scope, nowMs) ?? []);
  });
  return windows.length > 0 ? { at: nowMs, windows } : undefined;
}

/** Appends a sample for each declared opencode account that has a reading in `buckets` to that account's history. Never throws. */
export function recordOpencodeAccountSamples(config: HundredfoldConfig, buckets: readonly EngineLimitBucket[], nowMs = Date.now()): void {
  for (const account of declaredOpencodeAccounts(config)) {
    const sample = opencodeSampleFromBuckets(buckets, account.provider, nowMs);
    if (sample) recordUsageSample(sample, usageHistoryPath(opencodeAccountKey(account.provider)));
  }
}
