import type { IncomingMessage } from "node:http";
import { authSessionUserId, verifiedAuthDeviceId } from "../gateway/auth.js";
import type { AccountsRuntime } from "./runtime.js";
import { getUserById } from "./users.js";

type AccountRequest = Pick<IncomingMessage, "headers">;

/**
 * The account a web request was made by: the owner whose password sign-in minted the request's device. Only a device
 * whose session cookie verifies names anyone (an id cookie alone, a paired device and the bearer token carry no
 * account). The account must still exist, be active and be an owner (members never start sessions); without an
 * accounts runtime there is no table to check, so the device's account is taken as it stands. Never throws: an
 * unreadable device store or accounts table reads as no account, so the session is stored unattributed rather than
 * the request failing.
 */
export function requestAccountId(
  req: AccountRequest,
  hundredfoldHome: string,
  accounts: Pick<AccountsRuntime, "getDb"> | undefined,
): string | undefined {
  try {
    const userId = authSessionUserId(hundredfoldHome, verifiedAuthDeviceId(req.headers, hundredfoldHome));
    if (!userId) return undefined;
    if (!accounts) return userId;
    const user = getUserById(accounts.getDb(), userId);
    return user && user.status === "active" && user.instanceRole === "owner" ? user.id : undefined;
  } catch {
    return undefined;
  }
}

/** The email of the account a session is attributed to; null for no attribution, a forwarded proxy identity that is not an account, or an unreadable table. */
export function accountEmailOf(userId: string | null | undefined, accounts: Pick<AccountsRuntime, "getDb"> | undefined): string | null {
  if (!userId || !accounts) return null;
  try {
    return getUserById(accounts.getDb(), userId)?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the forwarded SSO identity from request headers, given the configured
 * `gateway.userHeader` (a single header name or a priority-ordered list). Node
 * lowercases incoming header keys, so we look up case-insensitively. Returns the
 * first present, non-empty, trimmed value; `undefined` when the config is unset
 * or no configured header is present. Unset config: the header is never read.
 */
export function resolveUserHeader(
  headers: Record<string, string | string[] | undefined>,
  userHeaderConfig: string | string[] | undefined,
): string | undefined {
  if (!userHeaderConfig) return undefined;
  const names = Array.isArray(userHeaderConfig) ? userHeaderConfig : [userHeaderConfig];
  for (const name of names) {
    if (!name) continue;
    const raw = headers[name.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/**
 * Who a request's new session is attributed to, at every route that starts one: the forwarded SSO identity when
 * `gateway.userHeader` is configured and present (it takes precedence), otherwise the signed-in account, otherwise
 * nobody. One helper so the same browser is attributed the same way on every route.
 */
export function requestUserId(
  req: AccountRequest,
  hundredfoldHome: string,
  accounts: Pick<AccountsRuntime, "getDb"> | undefined,
  userHeader: string | string[] | undefined,
): string | undefined {
  return resolveUserHeader(req.headers, userHeader) ?? requestAccountId(req, hundredfoldHome, accounts);
}
