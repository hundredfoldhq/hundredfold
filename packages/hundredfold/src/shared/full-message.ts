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
  // Only a copy cut at the cap can be a clipped one.
  const clipped = fullMessage.length === STRUCTURED_MESSAGE_BODY_MAX_CHARS
    && typeof chars === "number" && Number.isSafeInteger(chars) && chars > fullMessage.length;
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
    const via = meta.viaOperator === true ? " via the operator" : "";
    const verb = via ? "relayed from" : "from";
    return fromSessionId ? `📨 Message ${verb} session ${fromSessionId} (${fromLabel})${via}:` : `📨 Message ${verb} ${fromLabel}${via}:`;
  }
  // A child callback's banner opens with who replied ("📩 X replied"); the rest of it is the clipped body.
  const heading = content.split("\n", 1)[0]!.trim() || "📩 Notification:";
  const childSessionId = metaString(meta, "childSessionId");
  return childSessionId && !heading.includes(childSessionId) ? `${heading} (child session ${childSessionId})` : heading;
}

/** Where a reader finds the rest of a body the store had to clip. */
function clippedNote(meta: Record<string, unknown>, full: { fullMessage: string; fullMessageChars?: number }): string {
  const held = full.fullMessage.length.toLocaleString("en-US");
  if (full.fullMessageChars === undefined && full.fullMessage.length < STRUCTURED_MESSAGE_BODY_MAX_CHARS) return "";
  const extent = full.fullMessageChars === undefined
    ? `This stored copy holds the first ${held} characters and may have been clipped.`
    : `This stored copy holds the first ${held} of ${full.fullMessageChars.toLocaleString("en-US")} characters.`;
  const childSessionId = metaString(meta, "childSessionId");
  const rest = meta.kind !== "agent-relay" && childSessionId
    ? `The full text is in child session ${childSessionId}: read_session { sessionId: "${childSessionId}" }.`
    : "The whole message goes to the receiving session's engine; only this copy is kept to read back.";
  return `\n\n[${extent} ${rest}]`;
}

/**
 * The text an agent should read for one logged message. A notification that
 * kept its body reads as a one-line heading plus the whole body; a body the
 * store had to clip says so, and where the rest is. Everything else is its
 * `content` unchanged.
 */
export function agentReadableContent(message: LoggedMessageLike): string {
  const content = typeof message.content === "string" ? message.content : "";
  const meta = message.role === "notification" ? metaObject(message.meta) : undefined;
  const full = meta ? readFullMessageMeta(meta) : undefined;
  if (!meta || !full?.fullMessage.trim()) return content;
  return `${notificationHeading(content, meta)}\n\n${full.fullMessage}${clippedNote(meta, full)}`;
}
