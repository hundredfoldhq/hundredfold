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
const REASONS: readonly AccountPick["reason"][] = ["most-headroom", "tie", "only-candidate", "no-readings", "all-exhausted"];

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
  if (!state || typeof value.activeSessions !== "number") return undefined;
  const tightest = tightestOf(value.tightest);
  return {
    account: value.account,
    label: value.label,
    state,
    ...(typeof value.headroomPercent === "number" ? { headroomPercent: value.headroomPercent } : {}),
    ...(tightest ? { tightest } : {}),
    ...(typeof value.readingAt === "string" ? { readingAt: value.readingAt } : {}),
    activeSessions: value.activeSessions,
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
