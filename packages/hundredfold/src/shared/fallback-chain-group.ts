import { latestAccountReading } from "./fallback-chain-limits.js";
import { isLinkExhausted, isLinkSignedOut, type FallbackHealthInputs } from "./fallback-chain-health.js";
import { linkAccount } from "./fallback-chain-links.js";
import { DEFAULT_CLAUDE_ACCOUNT } from "./engine-account.js";
import { pickGroupAccount, rankGroupAccounts, type GroupCandidate } from "./fallback-account-pick.js";
import {
  fallbackGroupOf, fallbackLinkLabel,
  type AccountHeadroom, type AccountPick, type FallbackChainEntry, type FallbackChainSource, type FallbackGroupEntry, type FallbackLink, type ResolvedFallbackLink,
} from "./fallback-chain-wire.js";
import type { HundredfoldConfig } from "./types.js";

/**
 * Balanced account groups at resolve time: reading what the balancer needs from
 * health and the usage samples, ordering the members of an expanded group by
 * headroom, and finding the group a session's own account makes its "home".
 * The ranking and weighting rules themselves are `fallback-account-pick.ts`'s.
 */

/** What resolving a chain reads to rank a group: health and the limits readings. */
export type GroupRankInputs = FallbackHealthInputs;

/** An account's candidate: its latest usage sample (the injected readings when given, else the one on disk) and whether health or a signed-out login rules it out. */
export function accountCandidate(inputs: FallbackHealthInputs, account: string, label: string): GroupCandidate {
  const now = inputs.now ?? new Date();
  const identity = { engine: "claude", model: undefined, account };
  const exhausted = isLinkExhausted(inputs.health, identity, now) || isLinkSignedOut(inputs.health, identity, now);
  const until = inputs.health[account]?.until;
  const reopens = until === undefined ? Number.NaN : Date.parse(until);
  return {
    account,
    label,
    exhausted,
    reading: inputs.limits === undefined ? latestAccountReading(account) : inputs.limits[account],
    ...(exhausted && Number.isFinite(reopens) ? { reopensAt: reopens } : {}),
  };
}

/** The ranking of some Claude links (the members of a group), best first, for a session that will run `model`. */
export function rankLinks(inputs: GroupRankInputs, links: readonly Pick<ResolvedFallbackLink, "account" | "label">[], model: string | undefined): AccountHeadroom[] {
  const candidates = links.map((link) => accountCandidate(inputs, link.account, link.label));
  return rankGroupAccounts(candidates, { now: inputs.now ?? new Date(), model });
}

/**
 * Orders every group's members within the chain by headroom and records each
 * member's ranking input. The members of a group sit in the slots the written
 * chain gave them; ranked members that can serve the session take those slots
 * first, best first, and members ruled out for it keep their written order after.
 * Links without a group are untouched.
 */
export function orderGroupLinks(inputs: GroupRankInputs, links: ResolvedFallbackLink[], model: string | undefined): ResolvedFallbackLink[] {
  const slots = new Map<FallbackGroupEntry, number[]>();
  links.forEach((link, at) => {
    if (link.group) slots.set(link.group.written, [...(slots.get(link.group.written) ?? []), at]);
  });
  const out = [...links];
  for (const indices of slots.values()) {
    const members = indices.map((at) => links[at]!);
    const usable = members.filter((link) => link.skip === undefined);
    const ranking = rankLinks(inputs, members, model);
    const byAccount = new Map(ranking.map((headroom) => [headroom.account, headroom]));
    const order = new Map(ranking.map((headroom, rank) => [headroom.account, rank]));
    const ordered = [...usable].sort((a, b) => order.get(a.account)! - order.get(b.account)!);
    const rest = members.filter((link) => link.skip !== undefined);
    [...ordered, ...rest].forEach((link, slot) => {
      const headroom = byAccount.get(link.account);
      out[indices[slot]!] = { ...link, group: { ...link.group!, ...(headroom ? { headroom } : {}) } };
    });
  }
  return out;
}

/** A group member and the account it runs as. */
export interface GroupMember {
  link: FallbackLink;
  account: string;
}

/** The group at the head of a chain that holds the session's own account: balancing applies to it. */
export interface HomeGroup {
  /** Always 0: only the first entry is a home group. */
  index: 0;
  written: FallbackGroupEntry;
  members: GroupMember[];
}

/**
 * The first entry of the chain as a group when it holds `ownAccount` (the
 * account the session would otherwise run as), else undefined. A member naming
 * no profile is the default login, or `unprofiled` when the subject runs a
 * login of its own.
 */
export function homeGroupOf(
  config: HundredfoldConfig, entries: readonly FallbackChainEntry[], ownAccount: string, unprofiled?: string,
): HomeGroup | undefined {
  const written = fallbackGroupOf(entries[0]);
  if (!written) return undefined;
  const members = written.group.map((link): GroupMember => ({ link, account: linkAccount(link, config, unprofiled) }));
  return members.some((member) => member.account === ownAccount) ? { index: 0, written, members } : undefined;
}

/** Where a start pick is made: whose chain holds the group, the account the session would otherwise run as, and the model it will run. */
export interface StartPickContext {
  source: FallbackChainSource;
  ownAccount: string;
  model?: string;
}

/**
 * What a new session starting on `ownAccount` would be pinned to now: the ranking
 * over the home group's members that can serve it. `resolved` is the subject's
 * resolved chain after its own target, which says what each other member may do
 * (a member ruled out for the session, or dropped as a repeat, is not a
 * candidate). The default login is no candidate for a subject whose own login is
 * a named profile: a session has no way to say "the default login" over a profile.
 * Undefined when nothing is a candidate.
 */
export function startPickOf(inputs: GroupRankInputs, home: HomeGroup, resolved: readonly ResolvedFallbackLink[], context: StartPickContext): AccountPick | undefined {
  const { ownAccount } = context;
  const candidates = home.members.flatMap(({ link, account }): GroupCandidate[] => {
    if (account !== ownAccount) {
      const member = resolved.find((candidate) => candidate.account === account && candidate.group !== undefined);
      if (!member || member.skip !== undefined || (account === DEFAULT_CLAUDE_ACCOUNT && ownAccount !== DEFAULT_CLAUDE_ACCOUNT)) return [];
    }
    return [accountCandidate(inputs, account, fallbackLinkLabel(link))];
  });
  return pickGroupAccount(candidates, {
    now: inputs.now ?? new Date(), model: context.model,
    trigger: "start", source: context.source, groupIndex: home.index,
  });
}
