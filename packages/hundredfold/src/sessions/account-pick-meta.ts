import type { AccountHeadroom, AccountPick, FallbackChainSource } from "../shared/fallback-chain-wire.js";
import type { Session } from "../shared/types.js";

/**
 * The balancer's record on a session (`transportMeta.accountPick`): which
 * account of a group the session was pinned to, why, and the ranking behind it.
 * Read defensively like the rest of the run meta: a field of the wrong shape
 * reads as absent, and a record that does not hold together reads as no pick.
 */

const SOURCES: readonly FallbackChainSource[] = ["session", "employee", "account", "engine", "none"];
const STATES: readonly AccountHeadroom["state"][] = ["fresh", "stale", "unknown", "exhausted"];
const TRIGGERS: readonly AccountPick["trigger"][] = ["start", "switch"];
const REASONS: readonly AccountPick["reason"][] = ["weighted", "only-candidate", "no-readings", "all-exhausted"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((item) => item === value);
}

function tightestOf(value: unknown): AccountHeadroom["tightest"] | undefined {
  if (!isRecord(value) || typeof value.window !== "string" || typeof value.usedPercent !== "number") return undefined;
  return { window: value.window, usedPercent: value.usedPercent, ...(typeof value.resetsAt === "string" ? { resetsAt: value.resetsAt } : {}) };
}

function candidateOf(value: unknown): AccountHeadroom | undefined {
  if (!isRecord(value) || typeof value.account !== "string" || typeof value.label !== "string") return undefined;
  const state = oneOf(STATES, value.state);
  if (!state || typeof value.weight !== "number" || typeof value.sharePercent !== "number") return undefined;
  const tightest = tightestOf(value.tightest);
  return {
    account: value.account,
    label: value.label,
    state,
    ...(typeof value.headroomPercent === "number" ? { headroomPercent: value.headroomPercent } : {}),
    ...(tightest ? { tightest } : {}),
    ...(typeof value.readingAt === "string" ? { readingAt: value.readingAt } : {}),
    weight: value.weight,
    sharePercent: value.sharePercent,
  };
}

/** The pick's own fields, when they are all well formed. */
function headerOf(raw: Record<string, unknown>): Omit<AccountPick, "candidates"> | undefined {
  const source = oneOf(SOURCES, raw.source);
  const trigger = oneOf(TRIGGERS, raw.trigger);
  const reason = oneOf(REASONS, raw.reason);
  const { at, picked, groupIndex } = raw;
  if (!source || !trigger || !reason || typeof at !== "string" || typeof picked !== "string") return undefined;
  return typeof groupIndex === "number" && Number.isInteger(groupIndex) ? { at, trigger, source, groupIndex, picked, reason } : undefined;
}

/** The pick a session's `transportMeta` holds, or undefined when it holds none or a malformed one. */
export function readAccountPick(meta: Session["transportMeta"] | null | undefined): AccountPick | undefined {
  const raw = (meta as Record<string, unknown> | null | undefined)?.accountPick;
  if (!isRecord(raw) || !Array.isArray(raw.candidates)) return undefined;
  const header = headerOf(raw);
  const candidates = raw.candidates.flatMap((candidate) => candidateOf(candidate) ?? []);
  return header && candidates.length === raw.candidates.length ? { ...header, candidates } : undefined;
}

/** The usage numbers of a ranking entry (headroom, the window behind it, the reading's time, and the weight and share that a fresh reading's headroom makes): what a department-scoped caller is not shown. */
export function withoutHeadroomNumbers<T extends Partial<AccountHeadroom>>(headroom: T): T {
  const { headroomPercent: _percent, tightest: _tightest, readingAt: _at, weight: _weight, sharePercent: _share, ...rest } = headroom;
  return rest as T;
}

/**
 * The transport meta as a session body carries it: the recorded pick without its usage numbers. The full pick is
 * the fallback view's `pick` (for a caller that may see it); the raw record in the meta is an implementation
 * detail no reader needs, and every route that serialises a session would otherwise have to remember to strip it.
 */
export function transportMetaWithoutPickNumbers<T extends Session["transportMeta"]>(meta: T): T {
  const raw = (meta as Record<string, unknown> | null | undefined)?.accountPick;
  if (!isRecord(raw) || !Array.isArray(raw.candidates)) return meta;
  const candidates = raw.candidates.map((candidate) => (isRecord(candidate) ? withoutHeadroomNumbers(candidate) : candidate));
  return { ...meta, accountPick: { ...raw, candidates } } as T;
}
