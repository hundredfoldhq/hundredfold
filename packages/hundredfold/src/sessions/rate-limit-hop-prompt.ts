import { getMessages } from "./registry.js";
import { catchUpPrompt, currentMessageSection, syncTranscript, syncTranscriptLine, withoutCurrentMessage } from "./turn/sync-transcript.js";

/**
 * The prompt a fallback chain hop sends, by what the target already has.
 *
 * - A thread of its own (same engine and account, or one a run used before):
 *   resumed, and told what it missed since it last answered (`since`, its slot's
 *   `lastSyncedAt`). Nothing missed, nothing added: the prompt as it is.
 * - No thread: a fresh conversation handed the session so far.
 */

const HANDOFF_MESSAGES = 12;
const HANDOFF_INTRO = "Continue this conversation and respond to the current message.";
const RESUMED_INTRO = "This session moved between engines or accounts after usage limits, so this conversation missed some of what was said. "
  + "Sync your context with this transcript (most recent last), then respond to the current message.";

/**
 * The prompt for an engine with no thread of its own to resume: the last twelve
 * messages, then the current one. The current message is stated, not looked for
 * as the transcript's last line: a message from another session is logged as a
 * notification, and a handoff that left it to the transcript read the previous
 * request as the last one and answered it again.
 */
export function handoffPrompt(sessionId: string, prompt: string): string {
  const history = syncTranscript(withoutCurrentMessage(getMessages(sessionId), prompt), HANDOFF_MESSAGES);
  return [HANDOFF_INTRO, history ? `Conversation so far:\n\n${history}` : "", currentMessageSection(prompt)].filter(Boolean).join("\n\n");
}

/** The prompt for a resumed thread: the transcript it missed since `since`, then the prompt; the prompt itself when it missed nothing. */
export function resumedPrompt(sessionId: string, since: string | undefined, prompt: string): string {
  const sinceMs = Date.parse(since ?? "");
  if (!Number.isFinite(sinceMs)) return prompt;
  const earlier = withoutCurrentMessage(getMessages(sessionId).filter((message) => message.timestamp >= sinceMs), prompt)
    .filter((message) => syncTranscriptLine(message) !== undefined);
  return earlier.length === 0 ? prompt : catchUpPrompt({ earlier, prompt, intro: RESUMED_INTRO });
}
