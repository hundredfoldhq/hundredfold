import type { Session } from "../shared/types.js";
import type { ApiContext } from "./api.js";

/** Tell every view that these message bubbles of `session` are gone, and the queue is shorter for it where `depth` says so. */
export function announceRemovedMessages(context: ApiContext, session: Pick<Session, "id" | "sessionKey" | "sourceRef">, messageIds: string[], extra: { depth?: number } = {}): void {
  if (messageIds.length === 0 && extra.depth === undefined) return;
  context.emit("queue:updated", {
    sessionId: session.id,
    sessionKey: session.sessionKey || session.sourceRef || session.id,
    ...extra,
    ...(messageIds.length > 0 ? { withdrawnMessageIds: messageIds } : {}),
  });
}
