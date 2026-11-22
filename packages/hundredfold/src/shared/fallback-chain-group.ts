import { latestAccountReading } from "./fallback-chain-limits.js";
import { isEngineExhausted, type EngineHealthReading } from "./engine-health.js";
import { isLinkExhausted, isLinkSignedOut, type FallbackHealthInputs } from "./fallback-chain-health.js";
import {
  isOpencodeAccountKey, isOpencodeGroup, opencodeAccountKey, opencodeLinkAccountKey, opencodeModelKeyOf, ownOpencodeAccount,
} from "./fallback-chain-opencode-group.js";
import { declaredOpencodeAccounts } from "./opencode-accounts-config.js";
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

/** The health keys that rule an opencode account out for a session on `model`: the provider's own, and the session's model on it (`opencode/<provider>/<model key>`). */
function opencodeHealthKeys(account: string, model: string | null | undefined): string[] {
  const key = opencodeModelKeyOf(model);
  return key === undefined ? [account] : [account, `${account}/${key}`];
}

/** Whether health holds an opencode account's provider, or the session's model on it, at its limit now (an expired or invalid key is such a hold), and when the last of those holds reopens. */
function opencodeStanding(health: EngineHealthReading, account: string, model: string | null | undefined, now: Date): { exhausted: boolean; reopensAt: number } {
  const holds = opencodeHealthKeys(account, model).filter((key) => isEngineExhausted(health, key, now));
  const reopens = holds.map((key) => Date.parse(health[key]?.until ?? ""));
  return { exhausted: holds.length > 0, reopensAt: reopens.length > 0 && reopens.every(Number.isFinite) ? Math.max(...reopens) : Number.NaN };
}

/** The standing of a Claude account: exhausted by health or signed out, and when health says it reopens. */
function claudeStanding(health: EngineHealthReading, account: string, now: Date): { exhausted: boolean; reopensAt: number } {
  const identity = { engine: "claude", model: undefined, account };
  const exhausted = isLinkExhausted(health, identity, now) || isLinkSignedOut(health, identity, now);
  return { exhausted, reopensAt: Date.parse(health[account]?.until ?? "") };
}

/**
 * An account's candidate: its latest usage sample (the injected readings when given, else the one on disk)
 * and whether health or a signed-out login rules it out. `account` is a Claude account key or an opencode
 * account's `opencode/<provider>`; for the latter `model` (the session's own) names the model whose own hold counts.
 */
export function accountCandidate(inputs: FallbackHealthInputs, account: string, label: string, model?: string | null): GroupCandidate {
  const now = inputs.now ?? new Date();
  const { exhausted, reopensAt } = isOpencodeAccountKey(account) ? opencodeStanding(inputs.health, account, model, now) : claudeStanding(inputs.health, account, now);
  return {
    account,
    label,
    exhausted,
    reading: inputs.limits === undefined ? latestAccountReading(account) : inputs.limits[account],
    ...(exhausted && Number.isFinite(reopensAt) ? { reopensAt } : {}),
  };
}

/** The key a group member is ranked, read and charged under: its account for a Claude member, `opencode/<provider>` for an opencode member (whose own `account` is the engine's). */
export function groupMemberKey(link: Pick<ResolvedFallbackLink, "engine" | "model" | "account">): string {
  return opencodeLinkAccountKey(link) ?? link.account;
}

/** The ranking of some group links (the members of a group), best first, for a session that will run `model`. */
export function rankLinks(inputs: GroupRankInputs, links: readonly Pick<ResolvedFallbackLink, "engine" | "model" | "account" | "label">[], model: string | undefined): AccountHeadroom[] {
  const candidates = links.map((link) => accountCandidate(inputs, groupMemberKey(link), link.label, model));
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
    const ordered = [...usable].sort((a, b) => order.get(groupMemberKey(a))! - order.get(groupMemberKey(b))!);
    const rest = members.filter((link) => link.skip !== undefined);
    [...ordered, ...rest].forEach((link, slot) => {
      const headroom = byAccount.get(groupMemberKey(link));
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
      const member = resolved.find((candidate) => groupMemberKey(candidate) === account && candidate.group !== undefined);
      if (!member || member.skip !== undefined || (account === DEFAULT_CLAUDE_ACCOUNT && ownAccount !== DEFAULT_CLAUDE_ACCOUNT)) return [];
    }
    return [accountCandidate(inputs, account, fallbackLinkLabel(link), context.model)];
  });
  return pickGroupAccount(candidates, {
    now: inputs.now ?? new Date(), model: context.model,
    trigger: "start", source: context.source, groupIndex: home.index,
  });
}

/**
 * The first entry of an opencode subject's chain as a group when it is an opencode group holding the
 * session's own account: the declared account whose provider serves `ownModel`. None when the model's
 * provider is no declared account (such a subject is never balanced), the group is not an opencode
 * group, or it does not hold the own account. A member's key is `opencode/<provider>` of its account;
 * a member naming no declared account has none and is left out.
 */
export function opencodeHomeGroupOf(config: HundredfoldConfig, entries: readonly FallbackChainEntry[], ownModel: string | null | undefined): (HomeGroup & { ownAccount: string }) | undefined {
  const written = fallbackGroupOf(entries[0]);
  const own = ownOpencodeAccount(config, ownModel);
  if (!written || !own || !isOpencodeGroup(written)) return undefined;
  const accounts = declaredOpencodeAccounts(config);
  const members = written.group.flatMap((link): GroupMember[] => {
    const account = accounts.find((candidate) => candidate.name === link.profile);
    return account ? [{ link, account: opencodeAccountKey(account.provider) }] : [];
  });
  const ownAccount = opencodeAccountKey(own.provider);
  return members.some((member) => member.account === ownAccount) ? { index: 0, written, members, ownAccount } : undefined;
}
