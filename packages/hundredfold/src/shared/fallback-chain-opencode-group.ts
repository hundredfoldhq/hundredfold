import { declaredOpencodeAccounts, type OpencodeAccount } from "./opencode-accounts-config.js";
import { fallbackGroupOf, type FallbackChainEntry, type FallbackGroupEntry, type FallbackLink } from "./fallback-chain-wire.js";
import type { HundredfoldConfig } from "./types.js";

/**
 * What an opencode account group means once a chain is resolved
 * (docs/design/fallback-account-groups.md, section 10): an opencode account is a
 * provider id, so a member stands for the session's own model key served by the
 * member's provider (`opencode-go/glm-5` on account `go-a`, `opencode-go-b/glm-5`
 * on `go-b`), and its ranking key is the health key of that provider,
 * `opencode/<provider>`. Pure: config alone, no health and no readings.
 */

/** The ranking and health key of an opencode account: `opencode/<provider>`. */
export function opencodeAccountKey(provider: string): string {
  return `opencode/${provider}`;
}

/** Whether a ranking key is an opencode account's (a Claude account key never starts this way). */
export function isOpencodeAccountKey(account: string): boolean {
  return account.startsWith("opencode/");
}

/** The provider an opencode account key names (`opencode/opencode-go-b` gives `opencode-go-b`), or undefined for a key that is not one. */
export function opencodeAccountKeyProvider(account: string): string | undefined {
  return isOpencodeAccountKey(account) && account.length > "opencode/".length ? account.slice("opencode/".length) : undefined;
}

/** The provider of a `provider/model` id, or undefined when it names none. */
export function opencodeProviderOf(model: string | null | undefined): string | undefined {
  const slash = model ? model.indexOf("/") : -1;
  return model && slash > 0 ? model.slice(0, slash) : undefined;
}

/** The model id without its provider (`opencode-go/glm-5` gives `glm-5`), or undefined when there is no key to name. */
export function opencodeModelKeyOf(model: string | null | undefined): string | undefined {
  const slash = model ? model.indexOf("/") : -1;
  return model && slash > 0 && slash < model.length - 1 ? model.slice(slash + 1) : undefined;
}

/** The model an opencode session of this subject runs on when its own target names none: the engine's configured model. */
export function opencodeOwnModel(config: HundredfoldConfig, own: string | null | undefined): string | undefined {
  return own || config.engines.opencode?.model || undefined;
}

/** The declared opencode account whose provider serves `model`: the session's own account. None means the model's provider is no declared account, and the session is never balanced. */
export function ownOpencodeAccount(config: HundredfoldConfig, model: string | null | undefined): OpencodeAccount | undefined {
  const provider = opencodeProviderOf(model);
  return provider === undefined ? undefined : declaredOpencodeAccounts(config).find((account) => account.provider === provider);
}

/** The ranking key of a resolved opencode link (its model's provider), or undefined for a link that names none. */
export function opencodeLinkAccountKey(link: Pick<FallbackLink, "engine" | "model">): string | undefined {
  const provider = link.engine === "opencode" ? opencodeProviderOf(link.model) : undefined;
  return provider === undefined ? undefined : opencodeAccountKey(provider);
}

/** A member of an opencode group as the resolver runs it. */
export interface OpencodeMemberTarget {
  target: FallbackLink;
  /** The member cannot serve this session at all: its own model has no key to carry over. The resolver skips it as `model-not-served`. */
  unserved: boolean;
}

/**
 * The target an opencode group member stands for: `{engine: opencode, model: <member provider>/<model key>}`,
 * the model key being the session's own model without its provider. A member naming no declared account keeps its
 * `profile`, so the resolver reads it as `profile-unknown`. Whether the account serves the key is the model
 * registry's question (the resolver's existing `model-not-served` check), not this one's.
 */
export function opencodeMemberTarget(config: HundredfoldConfig, link: FallbackLink, ownModel: string | null | undefined): OpencodeMemberTarget {
  const account = declaredOpencodeAccounts(config).find((candidate) => candidate.name === link.profile);
  if (!account) return { target: link, unserved: false };
  const key = opencodeModelKeyOf(ownModel);
  return { target: { engine: "opencode", model: `${account.provider}/${key ?? ""}` }, unserved: key === undefined };
}

/** Whether a written group is a group of opencode accounts: every member is an opencode link. */
export function isOpencodeGroup(written: FallbackGroupEntry): boolean {
  return written.group.length > 0 && written.group.every((link) => link.engine === "opencode");
}

/** Whether the written chain's first entry is an opencode group. */
export function opensWithOpencodeGroup(entries: readonly FallbackChainEntry[]): boolean {
  const written = fallbackGroupOf(entries[0]);
  return written !== null && isOpencodeGroup(written);
}
