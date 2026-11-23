import type { IncomingMessage } from "node:http";
import { authSessionUserId, verifiedAuthDeviceId } from "../gateway/auth.js";
import type { AccountsRuntime } from "./runtime.js";
import { getUserById } from "./users.js";

type AccountRequest = Pick<IncomingMessage, "headers">;

/**
 * The account a web request was made by: the owner whose password sign-in minted the request's device. Only a device
 * whose session cookie verifies names anyone (an id cookie alone, a paired device and the bearer token carry no
 * account), and with an accounts runtime the account must still exist and be active. Never throws: an unreadable
 * device store or accounts table reads as no account, so the session is stored unattributed rather than the request failing.
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
    return user && user.status === "active" ? user.id : undefined;
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
