import { STRUCTURED_MESSAGE_BODY_MAX_CHARS } from "./types.js";

/**
 * A notification is logged twice over: `content` is the short banner the web UI
 * shows, and `meta.fullMessage` keeps the body the engine was handed. Agents
 * reading a transcript must get the body, not the banner.
 */

/** The `fullMessage` meta fields for `text`: the body, and its real length when the stored copy is clipped. */
export function fullMessageMeta(text: string): { fullMessage: string; fullMessageChars?: number } {
  if (text.length <= STRUCTURED_MESSAGE_BODY_MAX_CHARS) return { fullMessage: text };
  return { fullMessage: text.slice(0, STRUCTURED_MESSAGE_BODY_MAX_CHARS), fullMessageChars: text.length };
}

/** Re-read the `fullMessage` fields from untrusted meta, keeping the cap and a length only when it says the copy is clipped. */
export function readFullMessageMeta(meta: Record<string, unknown>): { fullMessage: string; fullMessageChars?: number } | undefined {
  if (typeof meta.fullMessage !== "string") return undefined;
  const fullMessage = meta.fullMessage.slice(0, STRUCTURED_MESSAGE_BODY_MAX_CHARS);
  const chars = meta.fullMessageChars;
  const clipped = typeof chars === "number" && Number.isSafeInteger(chars) && chars > fullMessage.length;
  return clipped ? { fullMessage, fullMessageChars: chars } : { fullMessage };
}

interface LoggedMessageLike {
  role?: unknown;
  content?: unknown;
  meta?: unknown;
}

function metaString(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  return typeof value === "string" ? value.trim() : "";
}

function metaObject(meta: unknown): Record<string, unknown> | undefined {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : undefined;
}

/** One line saying who a notification is from. */
function notificationHeading(content: string, meta: Record<string, unknown>): string {
  if (meta.kind === "agent-relay") {
    const fromLabel = metaString(meta, "fromLabel") || "another session";
    const fromSessionId = metaString(meta, "fromSessionId");
    return fromSessionId ? `📨 Message from session ${fromSessionId} (${fromLabel}):` : `📨 Message from ${fromLabel}:`;
  }
  // A child callback's banner opens with who replied ("📩 X replied"); the rest of it is the clipped body.
  const heading = content.split("\n", 1)[0]!.trim() || "📩 Notification:";
  const childSessionId = metaString(meta, "childSessionId");
  return childSessionId && !heading.includes(childSessionId) ? `${heading} (child session ${childSessionId})` : heading;
}

/**
 * The text an agent should read for one logged message. A notification that
 * kept its body reads as a one-line heading plus the whole body; a body the
 * store had to clip says so, with where the whole text went. Everything else
 * is its `content` unchanged.
 */
export function agentReadableContent(message: LoggedMessageLike): string {
  const content = typeof message.content === "string" ? message.content : "";
  const meta = message.role === "notification" ? metaObject(message.meta) : undefined;
  const full = meta ? readFullMessageMeta(meta) : undefined;
  if (!meta || !full?.fullMessage.trim()) return content;
  const clippedNote = full.fullMessageChars === undefined
    ? ""
    : `\n\n[This stored copy holds the first ${full.fullMessage.length.toLocaleString("en-US")} of ${full.fullMessageChars.toLocaleString("en-US")} characters. `
      + "The receiving session was handed the whole message when it was delivered.]";
  return `${notificationHeading(content, meta)}\n\n${full.fullMessage}${clippedNote}`;
}
