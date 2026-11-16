import type { ServerResponse } from "node:http";
import { UNIDENTIFIED_TOOL_CALL_ERROR } from "../mcp/identity.js";
import type { Session } from "../shared/types.js";
import { getSession } from "../sessions/registry.js";
import { reportingParentSessionId } from "../work-items/employee-session-delegation.js";
import { json } from "./route-helpers.js";
import { isDescendantOf, type CallerIdentity } from "./session-comm-guards.js";

/** An agent's reach over a session: one it spawned (directly or transitively) or delegated to. */
export function sessionIsWithinReach(session: Session, callerId: string): boolean {
  return isDescendantOf(session.id, callerId, getSession) || reportingParentSessionId(session) === callerId;
}

/**
 * Whether the caller may act on another session's turns: the operator always,
 * an agent only on a session it spawned (directly or transitively) or delegated
 * to. A tool call that lost its identity fails closed. Answers the refusal
 * itself and returns false; the stop route and the meter's compact route share
 * it, because both act on a session's turns on its behalf.
 */
export function callerMayActOnSession(
  res: ServerResponse,
  session: Session,
  caller: CallerIdentity,
  refusal: { verb: string; instead: string },
): boolean {
  if (caller.kind === "unidentified-tool") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return false;
  }
  if (caller.kind === "session" && !sessionIsWithinReach(session, caller.callerId)) {
    json(res, {
      error: `session ${session.id} is not a descendant of your session — agents may only ${refusal.verb} sessions they spawned (directly or transitively) or delegated to. ${refusal.instead}`,
    }, 403);
    return false;
  }
  return true;
}

/**
 * Whether `callerId` is above `session`: a session it was spawned under
 * (directly or transitively), or one on the chain of sessions it reports to.
 * A message from such a session is an instruction from whoever owns the work,
 * which resets the target's session-comm budgets (session-comm-guards.ts).
 */
export function isAboveSession(session: Session, callerId: string): boolean {
  if (session.id === callerId) return false;
  if (isDescendantOf(session.id, callerId, getSession)) return true;
  const seen = new Set<string>([session.id]);
  let current: Session | undefined = session;
  for (let depth = 0; depth < 64 && current; depth++) {
    const up = reportingParentSessionId(current);
    if (!up || seen.has(up)) return false;
    if (up === callerId) return true;
    seen.add(up);
    current = getSession(up);
  }
  return false;
}

/**
 * The nearest session above `session`, on the chain it reports to, that is not
 * `peerId` and can still message it (`canMessage`): the session a budget
 * refusal tells the caller to ask, because a message from it resets the
 * caller's budgets. Null when there is none, and the operator is the way on.
 */
export function coordinatorSessionId(
  session: Session,
  peerId: string,
  canMessage: (candidate: Session) => boolean,
): string | null {
  const seen = new Set<string>([session.id]);
  let current: Session | undefined = session;
  for (let depth = 0; depth < 64 && current; depth++) {
    const up = reportingParentSessionId(current);
    if (!up || seen.has(up)) return null;
    seen.add(up);
    const candidate = getSession(up);
    if (!candidate) return null;
    if (up !== peerId && canMessage(candidate)) return up;
    current = candidate;
  }
  return null;
}
