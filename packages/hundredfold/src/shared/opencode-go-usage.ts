import { createHash } from "node:crypto";
import type { ProviderUsage, ProviderUsageReasonCode } from "./types.js";
import { isRecord, num, str } from "./engine-limits-util.js";

/**
 * OpenCode Go's own usage reading: `GET /inference/go/v1/usage` with the Go key as a bearer token (the endpoint
 * the provider documents). It answers a percentage and a reset for each of three meters, not dollars:
 *
 *   { "usage": { "rolling": {status, percent, resetsAt}, "weekly": {...}, "monthly": {...} } }
 *
 * `rolling` is the five-hour window, `weekly` seven days and `monthly` thirty. `status` is `ok` or `rate-limited`.
 *
 * Nothing here ever reports a number the provider did not give: a reading that cannot be had is an
 * `unavailable` result with a fixed reason, never a window at 0%. The key lives only in the request header;
 * errors, results and the cache carry a one-way tag of it at most.
 */

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/inference/go/v1/usage";
export const OPENCODE_GO_USAGE_SOURCE = "OpenCode Go usage API";

/** The provider id the usage endpoint answers for; an account whose `base` is this one signs in with a Go key too. */
export const OPENCODE_GO_PROVIDER = "opencode-go";

const REQUEST_TIMEOUT_MS = 5_000;
/** How long a reading is reused. Short, so a page load after a turn sees fresh numbers, long enough that a burst of loads is one request. */
export const GO_USAGE_TTL_MS = 60_000;
/** How long a failure is reused: a dead key or a refused region is not worth a request per page load. */
export const GO_USAGE_FAILURE_TTL_MS = 30_000;
/** Entries older than this are dropped when another is stored. */
const PRUNE_AFTER_MS = 10 * 60_000;

const METERS: readonly { key: string; name: string; minutes: number }[] = [
  { key: "rolling", name: "5h", minutes: 300 },
  { key: "weekly", name: "7d", minutes: 10_080 },
  { key: "monthly", name: "30d", minutes: 43_200 },
];

const REASON_MESSAGES: Record<ProviderUsageReasonCode, string> = {
  "no-key": "No OpenCode Go key is available to read usage with.",
  unauthorized: "OpenCode Go rejected the key (401). Replace it and usage will show again.",
  "no-subscription": "This key has no OpenCode Go subscription, so there is no usage to show.",
  forbidden: "OpenCode Go refused the request (403): the key is not covered or the region is restricted.",
  "rate-limited": "OpenCode Go is rate limiting usage requests (429); it will be asked again shortly.",
  "http-error": "OpenCode Go's usage endpoint answered with an error.",
  network: "OpenCode Go's usage endpoint could not be reached.",
  timeout: "OpenCode Go's usage endpoint did not answer in time.",
  "bad-response": "OpenCode Go's usage endpoint answered in a shape this version does not understand.",
};

/** The `unavailable` reading for `code`, in fixed words. */
export function unavailableUsage(code: ProviderUsageReasonCode, now: Date = new Date()): ProviderUsage {
  return {
    source: OPENCODE_GO_USAGE_SOURCE,
    status: "unavailable",
    fetchedAt: now.toISOString(),
    unavailable: { code, message: REASON_MESSAGES[code] },
  };
}

type Window = NonNullable<ProviderUsage["windows"]>[number];

function parseMeter(value: unknown, name: string, minutes: number): Window | undefined {
  if (!isRecord(value)) return undefined;
  const percent = num(value.percent);
  // A percentage outside 0..100 is not a reading: leave the window out rather than clamp a guess into one.
  if (percent === undefined || percent < 0 || percent > 100) return undefined;
  const limited = value.status === "rate-limited";
  const resetsAtMs = typeof value.resetsAt === "string" ? Date.parse(value.resetsAt) : NaN;
  const resetsAt = Number.isFinite(resetsAtMs) ? Math.ceil(resetsAtMs / 1000) : undefined;
  return {
    name,
    usedPercent: percent,
    windowDurationMins: minutes,
    ...(resetsAt === undefined ? {} : { resetsAt, resetsAtIso: new Date(resetsAt * 1000).toISOString() }),
    ...(limited ? { limited: true } : {}),
  };
}

/** The windows a usage body carries, in 5h/7d/30d order; undefined when it carries none that parse. */
export function parseGoUsage(body: unknown): Window[] | undefined {
  const usage = isRecord(body) ? body.usage : undefined;
  if (!isRecord(usage)) return undefined;
  const windows = METERS.flatMap(({ key, name, minutes }) => parseMeter(usage[key], name, minutes) ?? []);
  return windows.length > 0 ? windows : undefined;
}

/** Whether the provider body names an entitlement problem (a key with no Go subscription), as opposed to any other refusal. */
function isEntitlementError(body: unknown): boolean {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  return str(error?.type) === "EntitlementError";
}

function reasonForStatus(status: number, body: unknown): ProviderUsageReasonCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return isEntitlementError(body) ? "no-subscription" : "forbidden";
  if (status === 429) return "rate-limited";
  return "http-error";
}

export interface FetchGoUsageOptions {
  fetchImpl?: typeof fetch;
  url?: string;
  timeoutMs?: number;
  now?: Date;
}

async function readJson(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return undefined; }
}

/** The request itself: a thrown failure becomes the `unavailable` reading it means, and a response comes back as is. */
async function requestUsage(key: string, options: FetchGoUsageOptions, now: Date): Promise<Response | ProviderUsage> {
  try {
    return await (options.fetchImpl ?? fetch)(options.url ?? OPENCODE_GO_USAGE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      // A redirect would carry the request somewhere the key was never meant to go.
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return unavailableUsage(timedOut ? "timeout" : "network", now);
  }
}

/** One uncached read with `key`. Never throws, and never carries the key out. */
export async function fetchGoUsage(key: string, options: FetchGoUsageOptions = {}): Promise<ProviderUsage> {
  const now = options.now ?? new Date();
  const res = await requestUsage(key, options, now);
  if (!(res instanceof Response)) return res;
  const body = await readJson(res);
  if (!res.ok) return unavailableUsage(reasonForStatus(res.status, body), now);
  const windows = parseGoUsage(body);
  if (windows === undefined) return unavailableUsage("bad-response", now);
  return { source: OPENCODE_GO_USAGE_SOURCE, status: "ok", fetchedAt: now.toISOString(), windows };
}

interface CacheEntry {
  at: number;
  ttl: number;
  usage: ProviderUsage;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ProviderUsage>>();

/** A one-way tag of a key: it tells one credential's cached reading from another's and is not enough to use. */
function keyTag(key: string): string {
  return createHash("sha256").update(`go-usage\0${key}`).digest("hex").slice(0, 16);
}

function prune(nowMs: number): void {
  for (const [tag, entry] of cache) if (nowMs - entry.at > PRUNE_AFTER_MS) cache.delete(tag);
}

export interface ReadGoUsageOptions extends FetchGoUsageOptions {
  /** Skip the cached reading (a deliberate refresh). */
  fresh?: boolean;
  nowMs?: () => number;
}

/**
 * The usage reading for `key`, from the short cache when it has one. Concurrent reads of one key share one
 * request, so a page load and the background refresh landing together are a single call.
 */
export async function readGoUsage(key: string, options: ReadGoUsageOptions = {}): Promise<ProviderUsage> {
  const tag = keyTag(key);
  const nowMs = (options.nowMs ?? Date.now)();
  const cached = cache.get(tag);
  if (!options.fresh && cached && nowMs - cached.at < cached.ttl) return cached.usage;
  const pending = inflight.get(tag);
  if (pending) return pending;
  const request = fetchGoUsage(key, { ...options, now: new Date(nowMs) })
    .then((usage) => {
      prune(nowMs);
      cache.set(tag, { at: nowMs, ttl: usage.status === "ok" ? GO_USAGE_TTL_MS : GO_USAGE_FAILURE_TTL_MS, usage });
      return usage;
    })
    .finally(() => { inflight.delete(tag); });
  inflight.set(tag, request);
  return request;
}

/** Test seam. */
export function forgetGoUsageCacheForTest(): void {
  cache.clear();
  inflight.clear();
}
