import type { UsageSample, UsageSampleWindow } from "./claude-usage-history.js";
import { ENGINE_HEALTH_REFRESH_INTERVAL_MS } from "./engine-health-interval.js";
import type { AccountHeadroom, AccountPick, FallbackChainSource } from "./fallback-chain-wire.js";

/**
 * The account balancer: given the Claude accounts of a group and what is known
 * of each one's usage, rank them by headroom and pick the one a new session
 * should run on. Pure: samples, health verdicts and session counts go in, a
 * ranking comes out; nothing is read from disk and no provider is called.
 * docs/design/fallback-account-groups.md (4) is the rule this implements.
 */

/** A sample older than this is stale: twice the cadence the engine-health refresh writes it at. */
export const ACCOUNT_READING_FRESH_MS = 2 * ENGINE_HEALTH_REFRESH_INTERVAL_MS;

/** One account of a group, as the ranking sees it. */
export interface GroupCandidate {
  /** The per-account store key (`claude`, `claude:<profile key>`). */
  account: string;
  label: string;
  /** The newest usage sample recorded for the account, when there is one. */
  reading?: UsageSample;
  /** Engine health says the account is at its limit, or its login is recorded as signed out. */
  exhausted: boolean;
  /** Epoch ms health says the account reopens, when it states one (orders accounts that are all out). */
  reopensAt?: number;
}

export interface GroupRankOptions {
  now: Date;
  /** The model the session will run, or none: it decides which model-scoped windows apply. */
  model?: string | null;
  /** How many sessions are active on the account now. Default: none. */
  activeSessions?: (account: string) => number;
}

/** The tightest window that applies and counts, and the headroom it leaves. */
interface Headroom {
  percent: number;
  tightest?: { window: string; usedPercent: number; resetsAt: string };
}

const SCOPED_WINDOW_RE = /^7d\s+(\S.*)$/i;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Whether a window applies to a session on `model`: a `7d <model name>` window only to that family, every other window always, and every window when the model is unknown. */
function windowApplies(window: UsageSampleWindow, model: string | null | undefined): boolean {
  const scope = SCOPED_WINDOW_RE.exec(window.name.trim())?.[1];
  if (scope === undefined || !model?.trim()) return true;
  const modelWords = new Set(words(model));
  return words(scope).every((word) => modelWords.has(word));
}

/** The headroom a sample leaves: 100 minus the highest use across the applicable windows, a window that has already reset counting as unused, in whole percent. */
function headroomOf(sample: UsageSample, model: string | null | undefined, now: Date): Headroom {
  let tightest: UsageSampleWindow | undefined;
  for (const window of sample.windows) {
    if (window.resetsAt * 1000 <= now.getTime() || !windowApplies(window, model)) continue;
    if (tightest === undefined || window.usedPercent > tightest.usedPercent) tightest = window;
  }
  if (tightest === undefined) return { percent: 100 };
  const used = Math.min(Math.max(tightest.usedPercent, 0), 100);
  return {
    percent: Math.floor(100 - used),
    tightest: { window: tightest.name, usedPercent: tightest.usedPercent, resetsAt: new Date(tightest.resetsAt * 1000).toISOString() },
  };
}

function stateOf(candidate: GroupCandidate, now: Date): AccountHeadroom["state"] {
  if (candidate.exhausted) return "exhausted";
  if (candidate.reading === undefined) return "unknown";
  return now.getTime() - candidate.reading.at <= ACCOUNT_READING_FRESH_MS ? "fresh" : "stale";
}

function headroomRecord(candidate: GroupCandidate, options: GroupRankOptions): AccountHeadroom {
  const { reading } = candidate;
  const headroom = reading ? headroomOf(reading, options.model, options.now) : undefined;
  return {
    account: candidate.account,
    label: candidate.label,
    state: stateOf(candidate, options.now),
    ...(headroom ? { headroomPercent: headroom.percent } : {}),
    ...(headroom?.tightest ? { tightest: headroom.tightest } : {}),
    ...(reading ? { readingAt: new Date(reading.at).toISOString() } : {}),
    activeSessions: Math.max(options.activeSessions?.(candidate.account) ?? 0, 0),
  };
}

const TIER_ORDER: Record<AccountHeadroom["state"], number> = { fresh: 0, stale: 1, unknown: 2, exhausted: 3 };

interface Ranked {
  headroom: AccountHeadroom;
  reopensAt: number;
  written: number;
}

/** Best first: tier, then (when every account in the tier is out) the earliest reopening, then most headroom, fewest active sessions and written order. */
function compareRanked(a: Ranked, b: Ranked): number {
  const x = a.headroom;
  const y = b.headroom;
  return TIER_ORDER[x.state] - TIER_ORDER[y.state]
    || (x.state === "exhausted" ? a.reopensAt - b.reopensAt : 0)
    || (y.headroomPercent ?? 0) - (x.headroomPercent ?? 0)
    || x.activeSessions - y.activeSessions
    || a.written - b.written;
}

function rankedOf(candidates: readonly GroupCandidate[], options: GroupRankOptions): Ranked[] {
  return candidates
    .map((candidate, written): Ranked => ({
      headroom: headroomRecord(candidate, options),
      reopensAt: candidate.reopensAt ?? Number.POSITIVE_INFINITY,
      written,
    }))
    .sort(compareRanked);
}

/**
 * The group's accounts ranked best first. The tightest applicable window
 * decides the headroom; tiers are fresh, stale, unknown, then exhausted, so an
 * account that cannot be read is never preferred over one that can. Ties fall
 * to the fewest active sessions, then to the order the group is written in, so
 * the same state always gives the same ranking.
 */
export function rankGroupAccounts(candidates: readonly GroupCandidate[], options: GroupRankOptions): AccountHeadroom[] {
  return rankedOf(candidates, options).map((ranked) => ranked.headroom);
}

/** Where a pick is being made: the group's place in the chains and the moment. */
export interface GroupPickContext extends GroupRankOptions {
  trigger: AccountPick["trigger"];
  source: FallbackChainSource;
  groupIndex: number;
}

function reasonOf(ranked: readonly Ranked[]): AccountPick["reason"] {
  const [best, next] = ranked.map((entry) => entry.headroom);
  if (best!.state === "exhausted") return "all-exhausted";
  if (next === undefined) return "only-candidate";
  if (best!.state === "unknown") return "no-readings";
  const level = (item: AccountHeadroom): string => `${item.state}:${item.headroomPercent}`;
  return level(best!) === level(next) ? "tie" : "most-headroom";
}

/**
 * The account a new session should run on, with the ranking behind the choice.
 * `all-exhausted`: every account is out and the one that reopens first is
 * picked, for creation's own reroute to move the session past the group.
 * Undefined for a group with no candidate.
 */
export function pickGroupAccount(candidates: readonly GroupCandidate[], context: GroupPickContext): AccountPick | undefined {
  const ranked = rankedOf(candidates, context);
  if (ranked.length === 0) return undefined;
  return {
    at: context.now.toISOString(),
    trigger: context.trigger,
    source: context.source,
    groupIndex: context.groupIndex,
    picked: ranked[0]!.headroom.account,
    reason: reasonOf(ranked),
    candidates: ranked.map((entry) => entry.headroom),
  };
}
