/**
 * A session created for a spoken start has no first message yet: the operator
 * tapped the voice control on a new chat, and what they say becomes it. The row
 * carries a marker until then, so the two things that depend on the gap can
 * tell it from any other session: the title the first message gives it, and the
 * cleanup of a voice conversation that ends without one.
 */
import type { JsonObject, Session } from "../shared/types.js";
import { getMessages, getSession, promptExcerptOf, updateSession } from "./registry.js";

const KEY = "awaitingFirstMessage";

/** The meta a spawn stores: the given one, marked when the spawn waits for its first message. */
export function awaitingFirstMessageMeta(input: { awaitFirstMessage?: boolean }, meta: JsonObject | undefined): JsonObject | undefined {
  return input.awaitFirstMessage ? { ...(meta ?? {}), [KEY]: true } : meta;
}

export function isAwaitingFirstMessage(session: Pick<Session, "transportMeta"> | undefined): boolean {
  return session?.transportMeta?.[KEY] === true;
}

/** Whether a session was made for a spoken start and still holds no message. */
export function isEmptySpokenStart(sessionId: string): boolean {
  const session = getSession(sessionId);
  return !!session && !session.workItemId && isAwaitingFirstMessage(session) && getMessages(sessionId).length === 0;
}

const BARE_TITLE = /^#(\d+)$/;

/**
 * The first message names the session the way a prompt-created one is named
 * (`#N - first words`), and fills its excerpt. Once only: a session that has
 * a title of its own, or an excerpt, is left alone.
 */
export function nameFromFirstMessage(session: Session, text: string): void {
  if (!isAwaitingFirstMessage(session)) return;
  const bare = BARE_TITLE.exec(session.title ?? "");
  const cleaned = text.replace(/\n/g, " ").replace(/@\w+/g, "").replace(/\s+/g, " ").trim();
  const meta = { ...(session.transportMeta ?? {}) };
  delete meta[KEY];
  updateSession(session.id, {
    transportMeta: meta,
    ...(bare && cleaned ? { title: `#${bare[1]} - ${cleaned.slice(0, 30).trim()}${cleaned.length > 30 ? "..." : ""}` } : {}),
    ...(session.promptExcerpt ? {} : { promptExcerpt: promptExcerptOf(text) ?? null }),
  });
}

/** The shared message-accept path's hook: names the session when it is a spoken start still waiting for its first message. */
export function nameSpokenStartFromMessage(sessionId: string, text: string): void {
  const session = getSession(sessionId);
  if (session && isAwaitingFirstMessage(session)) nameFromFirstMessage(session, text);
}
