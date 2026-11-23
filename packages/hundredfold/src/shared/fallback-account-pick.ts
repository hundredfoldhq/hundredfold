import type { UsageSample, UsageSampleWindow } from "./claude-usage-history.js";
import { ENGINE_HEALTH_REFRESH_INTERVAL_MS } from "./engine-health-interval.js";
import { isOpencodeAccountKey, opencodeModelKeyOf } from "./fallback-chain-opencode-group.js";
import type { AccountHeadroom, AccountPick, FallbackChainSource } from "./fallback-chain-wire.js";

/**
 * The account balancer: given the Claude accounts of a group and what is known
 * of each one's usage, rank them by headroom and pick the account a new session
 * should run on. New sessions are spread across the group in proportion to each
 * account's headroom by a deterministic smooth weighted round-robin, so a burst
 * of starts inside one usage-reading interval splits instead of all landing on
 * the account that looked best. Picking is pure (samples, health verdicts and
 * the in-memory credits go in, a pick comes out); the credits are charged only
 * by `recordAccountStart`, after a session really started. Nothing is read from
 * disk and no provider is called. docs/design/fallback-account-groups.md (4) is
 * the rule this implements.
 */

/** A sample older than this is stale: twice the cadence the engine-health refresh writes it at. */
export const ACCOUNT_READING_FRESH_MS = 2 * ENGINE_HEALTH_REFRESH_INTERVAL_MS;

/** One account of a group, as the ranking sees it. */
export interface GroupCandidate {
  /** The per-account store key (`claude`, `claude:<profile key>`, or an opencode account's `opencode/<provider>`). */
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
}

/** The tightest window that applies and counts, and the headroom it leaves. */
interface Headroom {
  percent: number;
  tightest?: { window: string; usedPercent: number; resetsAt: string };
}

const SCOPED_WINDOW_RE = /^7d\s+(\S.*)$/i;
/** An opencode account's model-scoped window: `<window> <model key>`, written for one model of the provider's ledger. */
const OPENCODE_SCOPED_WINDOW_RE = /^(?:5h|7d|30d)\s+(\S.*)$/;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** An opencode window applies to every model, except one scoped to a model key, which applies only to a session on exactly that key (no family matching). */
function opencodeWindowApplies(window: UsageSampleWindow, model: string | null | undefined): boolean {
  const scope = OPENCODE_SCOPED_WINDOW_RE.exec(window.name.trim())?.[1];
  const key = opencodeModelKeyOf(model) ?? model?.trim();
  return scope === undefined || !key || scope === key;
}

/** Whether a window applies to a session on `model`: a `7d <model name>` window only to that family, every other window always, and every window when the model is unknown. An opencode account's scoped windows match the model key exactly. */
function windowApplies(window: UsageSampleWindow, model: string | null | undefined, account: string): boolean {
  if (isOpencodeAccountKey(account)) return opencodeWindowApplies(window, model);
  const scope = SCOPED_WINDOW_RE.exec(window.name.trim())?.[1];
  if (scope === undefined || !model?.trim()) return true;
  const modelWords = new Set(words(model));
  return words(scope).every((word) => modelWords.has(word));
}

/** The headroom a sample leaves: 100 minus the highest use across the applicable windows, a window that has already reset counting as unused, in whole percent. */
function headroomOf(sample: UsageSample, account: string, model: string | null | undefined, now: Date): Headroom {
  let tightest: UsageSampleWindow | undefined;
  for (const window of sample.windows) {
    if (window.resetsAt * 1000 <= now.getTime() || !windowApplies(window, model, account)) continue;
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

/** What an account's headroom is worth as a share of new sessions: linear in headroom, halved when the reading is stale, nothing at its limit or with no headroom. `anyReading`: some account that is not at its limit has a reading, so one with none gets nothing; with none anywhere, each gets 1 (an even split). */
function weightOf(state: AccountHeadroom["state"], headroomPercent: number | undefined, anyReading: boolean): number {
  if (state === "exhausted") return 0;
  if (state === "unknown") return anyReading ? 0 : 1;
  const headroom = headroomPercent ?? 0;
  return state === "stale" ? headroom / 2 : headroom;
}

interface Measured {
  state: AccountHeadroom["state"];
  headroom?: Headroom;
  reading?: UsageSample;
}

function measure(candidate: GroupCandidate, options: GroupRankOptions): Measured {
  const { reading } = candidate;
  return { state: stateOf(candidate, options.now), reading, ...(reading ? { headroom: headroomOf(reading, candidate.account, options.model, options.now) } : {}) };
}

const TIER_ORDER: Record<AccountHeadroom["state"], number> = { fresh: 0, stale: 1, unknown: 2, exhausted: 3 };

interface Ranked {
  headroom: AccountHeadroom;
  reopensAt: number;
  written: number;
}

/** Best first: tier, then (among accounts that are all out) the earliest reopening, then most headroom and the order written. */
function compareRanked(a: Ranked, b: Ranked): number {
  const x = a.headroom;
  const y = b.headroom;
  return TIER_ORDER[x.state] - TIER_ORDER[y.state]
    || (x.state === "exhausted" ? a.reopensAt - b.reopensAt : 0)
    || (y.headroomPercent ?? 0) - (x.headroomPercent ?? 0)
    || a.written - b.written;
}

function rankedOf(candidates: readonly GroupCandidate[], options: GroupRankOptions): Ranked[] {
  const measured = candidates.map((candidate) => measure(candidate, options));
  const anyReading = measured.some((m) => m.state !== "exhausted" && m.reading !== undefined);
  const weights = measured.map((m) => weightOf(m.state, m.headroom?.percent, anyReading));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return candidates
    .map((candidate, written): Ranked => {
      const { state, headroom, reading } = measured[written]!;
      const weight = weights[written]!;
      return {
        headroom: {
          account: candidate.account,
          label: candidate.label,
          state,
          ...(headroom ? { headroomPercent: headroom.percent } : {}),
          ...(headroom?.tightest ? { tightest: headroom.tightest } : {}),
          ...(reading ? { readingAt: new Date(reading.at).toISOString() } : {}),
          weight,
          sharePercent: total > 0 ? Math.round((weight / total) * 100) : 0,
        },
        reopensAt: candidate.reopensAt ?? Number.POSITIVE_INFINITY,
        written,
      };
    })
    .sort(compareRanked);
}

/**
 * The group's accounts ranked best first, each with its weight and share. The
 * tightest applicable window decides the headroom; tiers are fresh, stale,
 * unknown, then exhausted, so an account that cannot be read is never preferred
 * over one that can; within a tier, highest headroom first, then written order.
 * This is the order a limit walks the group's other members in, and the order
 * of a pick's candidates; it is not what a new session is spread by.
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

/** The credit each account of a candidate set has built up: weights added at each start, the winner charged the total. In memory, keyed by the set's sorted account keys, so a restart begins every set at 0. */
const credits = new Map<string, Map<string, number>>();

function setKey(accounts: readonly string[]): string {
  return [...accounts].sort().join("|");
}

/** Forgets every credit. For tests and for a config reload that changes what a group means. */
export function resetAccountCredits(): void {
  credits.clear();
}

/** The account with the highest credit once this start's weights are added (ties: the order written), among those with a weight. Undefined when none has. */
function winnerOf(written: readonly AccountHeadroom[], writtenOrder: readonly string[]): string | undefined {
  const held = credits.get(setKey(written.map((entry) => entry.account)));
  let best: { account: string; credit: number; at: number } | undefined;
  for (const entry of written) {
    if (entry.weight <= 0) continue;
    const credit = (held?.get(entry.account) ?? 0) + entry.weight;
    const at = writtenOrder.indexOf(entry.account);
    if (!best || credit > best.credit || (credit === best.credit && at < best.at)) best = { account: entry.account, credit, at };
  }
  return best?.account;
}

function reasonOf(ranked: readonly AccountHeadroom[], picked: string | undefined): AccountPick["reason"] {
  if (picked === undefined) return "all-exhausted";
  if (ranked.length === 1) return "only-candidate";
  return ranked.every((entry) => entry.state === "unknown" || entry.state === "exhausted") ? "no-readings" : "weighted";
}

/**
 * The account a new session should run on, with the weights behind the choice.
 * Pure: it reads the credits and changes nothing, so a preview, a validation
 * and the board walk's view can ask without charging anything; a start that
 * really happens is charged with `recordAccountStart`. `all-exhausted`: every
 * account has no weight, and the one that reopens first (best ranked) is picked,
 * for creation's own reroute to move the session past the group. Undefined for
 * a group with no candidate.
 */
export function pickGroupAccount(candidates: readonly GroupCandidate[], context: GroupPickContext): AccountPick | undefined {
  const ranked = rankGroupAccounts(candidates, context);
  if (ranked.length === 0) return undefined;
  const picked = winnerOf(ranked, candidates.map((candidate) => candidate.account));
  return {
    at: context.now.toISOString(),
    trigger: context.trigger,
    source: context.source,
    groupIndex: context.groupIndex,
    picked: picked ?? ranked[0]!.account,
    reason: reasonOf(ranked, picked),
    candidates: ranked,
  };
}

/**
 * Charges a start to the account it was picked for: every candidate's credit
 * grows by the weight the pick recorded and the winner's drops by their sum, so
 * the next pick sees the start the usage readings have not caught up with. Call
 * it once, after the session row exists, never for a preview.
 */
export function recordAccountStart(pick: Pick<AccountPick, "picked" | "candidates">): void {
  const total = pick.candidates.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0 || !pick.candidates.some((entry) => entry.account === pick.picked && entry.weight > 0)) return;
  const key = setKey(pick.candidates.map((entry) => entry.account));
  const held = credits.get(key) ?? new Map<string, number>();
  for (const entry of pick.candidates) held.set(entry.account, (held.get(entry.account) ?? 0) + entry.weight);
  held.set(pick.picked, (held.get(pick.picked) ?? 0) - total);
  credits.set(key, held);
}
