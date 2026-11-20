import { BOARD_REMINDER_LABEL } from "./board-reminder.js";

/**
 * What Claude Code's own compaction takes away, and the one piece of it that is
 * put back.
 *
 * Claude Code compacts a session by itself when its context fills, between turns
 * or in the middle of one. The system prompt (persona, operating rules, a scoped
 * department's scope) is not part of the conversation, so a summary cannot drop
 * it, and Claude Code reads the working directory's `CLAUDE.md` again straight
 * after. What a summary does replace is the conversation, and with it the Todo
 * board reminder that rode on the turn's own message: a compaction in the middle
 * of a turn leaves the rest of that turn without it.
 *
 * Claude Code runs the `SessionStart` hook with `source: "compact"` after every
 * compaction, whoever started it, and what the hook prints is added to the
 * conversation. The hook relay already posts that event to the gateway; the
 * gateway answers it with the reminder the session's latest turn carried, and the
 * relay prints it. Once per compaction, with nothing stored in the conversation
 * the summary could cut again.
 */

/** The sessions' latest reminders, oldest first, so a long-lived gateway keeps a bounded few. */
const MAX_REMEMBERED_SESSIONS = 2000;
const latest = new Map<string, string>();

/**
 * Note the reminder the session's turn carries, or that it carries none (a
 * session without the Todo tools, an instance that turned it off, or an engine
 * command such as `/compact`, which must reach the engine as written).
 */
export function rememberCompactionReminder(sessionId: string, reminder: string | undefined): void {
  latest.delete(sessionId);
  if (!reminder) return;
  latest.set(sessionId, reminder);
  if (latest.size > MAX_REMEMBERED_SESSIONS) {
    const oldest = latest.keys().next().value;
    if (oldest !== undefined) latest.delete(oldest);
  }
}

/** The hook output a Claude Code `SessionStart` hook prints to add context to the conversation. */
export interface SessionStartHookOutput {
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
}

/**
 * The reply to a relayed hook: the reminder to print when the hook is the start
 * of a session after a compaction and the session has one, otherwise nothing.
 */
export function compactionHookOutput(
  sessionId: string,
  hook: { hook_event_name?: unknown; source?: unknown },
): SessionStartHookOutput | undefined {
  if (hook.hook_event_name !== "SessionStart" || hook.source !== "compact") return undefined;
  const reminder = latest.get(sessionId);
  if (!reminder) return undefined;
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${BOARD_REMINDER_LABEL} ${reminder}` } };
}

export function resetCompactionRemindersForTests(): void {
  latest.clear();
}
