import type { EngineHealthReading } from "./engine-health.js";
import { isLinkExhausted, isLinkSignedOut } from "./fallback-chain-health.js";
import type { FallbackHopSkip, FallbackSkipReason, ResolvedFallbackLink } from "./fallback-chain-wire.js";

/**
 * Which link a limit moves a session to next. Pure: a resolved chain, where the
 * run stands and a health reading go in, the chosen link and the links passed
 * over on the way come out. The runtime walks with it and the session API's
 * `fallback.chain.next` reports with it, so the two cannot disagree.
 */

/** Where a run stands on its chain: the index of the target the session is on, and every target tried so far (the own target included). */
export interface FallbackRunCursor {
  position: number;
  tried: readonly string[];
}

export interface NextFallbackLink {
  /** Index into the chain. */
  index: number;
  link: ResolvedFallbackLink;
  /** Links passed over between the cursor and `link`, with why. */
  skipped: FallbackHopSkip[];
}

/**
 * Where the run stands on `links` now: the recorded position while it points at
 * a fallback link the run has tried (the target the session is on, which may lie
 * behind others when the walk went back to a link it had passed over for its
 * health); otherwise past the furthest tried target, as when the chain was
 * edited since. An edit cannot send a run to a target it already tried.
 */
export function effectivePosition(links: readonly ResolvedFallbackLink[], run: FallbackRunCursor | undefined): number {
  if (!run) return 0;
  const tried = new Set(run.tried);
  const recorded = Number.isFinite(run.position) ? Math.trunc(run.position) : 0;
  if (recorded > 0 && recorded < links.length && tried.has(links[recorded]!.key)) return recorded;
  const triedAt = links.reduce((furthest, link, index) => (tried.has(link.key) ? index : furthest), 0);
  return Math.min(Math.max(recorded, triedAt, 0), Math.max(links.length - 1, 0));
}

/** Why a link can never be taken in this run, whatever its health reads: tried, ruled out for the session, or signed out. */
function ruledOut(link: ResolvedFallbackLink, tried: ReadonlySet<string>, health: EngineHealthReading, now: Date): FallbackSkipReason | undefined {
  if (tried.has(link.key)) return "tried";
  return link.skip ?? (isLinkSignedOut(health, link, now) ? "signed-out" : undefined);
}

interface Scan {
  found?: NextFallbackLink;
  /** Every link after the cursor passed over, with why: up to `found`, or the whole rest of the chain. */
  skipped: FallbackHopSkip[];
}

function scan(
  links: readonly ResolvedFallbackLink[],
  cursor: FallbackRunCursor,
  health: EngineHealthReading,
  now: Date,
  isSpent: (link: ResolvedFallbackLink) => boolean,
): Scan {
  const tried = new Set(cursor.tried);
  const skipped: FallbackHopSkip[] = [];
  for (let index = Math.max(cursor.position, 0) + 1; index < links.length; index++) {
    const link = links[index]!;
    const reason = ruledOut(link, tried, health, now) ?? (isSpent(link) ? "exhausted" : undefined);
    if (reason === undefined) return { found: { index, link, skipped }, skipped };
    const detail = reason === link.skip ? link.skipDetail : undefined;
    skipped.push({ key: link.key, reason, ...(detail ? { detail } : {}) });
  }
  return { skipped };
}

/** A link behind the cursor that the walk passed over for its health and never tried: untried and not ruled out. */
function passedOverBehind(links: readonly ResolvedFallbackLink[], cursor: FallbackRunCursor, health: EngineHealthReading, now: Date): NextFallbackLink | undefined {
  const tried = new Set(cursor.tried);
  const index = links.findIndex((link, at) => at > 0 && at < cursor.position && ruledOut(link, tried, health, now) === undefined);
  return index < 0 ? undefined : { index, link: links[index]!, skipped: [] };
}

/**
 * The first link after the cursor that has not been tried, is not ruled out for
 * this session and is not at its limit. When that finds nothing, a second pass
 * ignores health; and before the run counts as run out, a link the walk passed
 * over for its health earlier is taken too. A limit can order a chain but never
 * empty one; a signed-out provider (`isLinkSignedOut`) is ruled out in every pass,
 * since each of its models would be refused with the same dead key. The own
 * target is always tried, so it is never the answer.
 */
export function nextFallbackLink(
  links: readonly ResolvedFallbackLink[],
  cursor: FallbackRunCursor,
  health: EngineHealthReading,
  now: Date = new Date(),
): NextFallbackLink | undefined {
  return scan(links, cursor, health, now, (link) => isLinkExhausted(health, link, now)).found
    ?? scan(links, cursor, health, now, () => false).found
    ?? passedOverBehind(links, cursor, health, now);
}

/** When `nextFallbackLink` finds nothing: every link after the cursor, with why it could not be taken. */
export function linksLeftOver(
  links: readonly ResolvedFallbackLink[],
  cursor: FallbackRunCursor,
  health: EngineHealthReading,
  now: Date = new Date(),
): FallbackHopSkip[] {
  return scan(links, cursor, health, now, () => false).skipped;
}
