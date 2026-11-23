import { isRemoteClaudeAccount } from "../shared/engine-account.js";
import type { JsonObject, Session } from "../shared/types.js";

/**
 * The balancer's pin on a remote employee's session (`transportMeta.remoteAccountPin`): the remote
 * account the session was started on when that is not its employee's own login on the host
 * (docs/design/fallback-account-groups.md, section 11).
 *
 * It lives in the transport meta and never in `sessions.claude_config_dir`: that column holds a
 * directory on the gateway, and a remote session ignores it by design, so a remote path there would
 * read as a local profile the day its employee turned local.
 */
export interface RemoteAccountPin {
  /** The picked remote account's key: `claude@<user>@<host>:<profile key>`. */
  account: string;
  /** Its profile directory on the host. */
  configDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The pin a session's `transportMeta` holds, or undefined when it holds none or a malformed one. */
export function readRemoteAccountPin(meta: Session["transportMeta"] | null | undefined): RemoteAccountPin | undefined {
  const raw = (meta as Record<string, unknown> | null | undefined)?.remoteAccountPin;
  if (!isRecord(raw) || typeof raw.account !== "string" || typeof raw.configDir !== "string") return undefined;
  return raw.account && raw.configDir && isRemoteClaudeAccount(raw.account) ? { account: raw.account, configDir: raw.configDir } : undefined;
}

/** The transport meta with the pin set, removed (`null`), or as it was (`undefined`). */
export function metaWithRemoteAccountPin(meta: JsonObject | undefined, pin: RemoteAccountPin | null | undefined): JsonObject | undefined {
  if (pin === undefined) return meta;
  if (pin === null) {
    if (!meta || !("remoteAccountPin" in meta)) return meta;
    const { remoteAccountPin: _gone, ...rest } = meta;
    return rest;
  }
  return { ...(meta ?? {}), remoteAccountPin: { account: pin.account, configDir: pin.configDir } };
}

/** A profile key is eight hex digits (`claudeProfileKey`), so a pinned account is its host's base key plus `:<key>`. */
const PROFILE_KEY_SUFFIX = /:[0-9a-f]{8}$/;

/** The login's key without its profile suffix: `claude@<user>@<host>`. */
function hostBaseOf(account: string): string {
  return account.replace(PROFILE_KEY_SUFFIX, "");
}

/**
 * Whether a pin was made on the host its employee is on now: its account is a profile on the employee's
 * `user@host`. `employeeAccount` is the employee's own login key, with or without a profile of its own.
 */
export function pinIsOnHostOf(pin: RemoteAccountPin, employeeAccount: string): boolean {
  if (!isRemoteClaudeAccount(employeeAccount) || !PROFILE_KEY_SUFFIX.test(pin.account)) return false;
  return hostBaseOf(pin.account) === employeeAccount || hostBaseOf(pin.account) === hostBaseOf(employeeAccount);
}

/**
 * The session's pin, when it still applies: only while the employee's current `user@host` is the one the
 * pin was made on. Otherwise ignored, and the session runs as its employee's login, as before.
 */
export function honouredRemoteAccountPin(meta: Session["transportMeta"] | null | undefined, employeeAccount: string | undefined): RemoteAccountPin | undefined {
  const pin = readRemoteAccountPin(meta);
  return pin && employeeAccount !== undefined && pinIsOnHostOf(pin, employeeAccount) ? pin : undefined;
}
