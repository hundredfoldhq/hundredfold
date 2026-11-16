import type { SessionMessage } from "../message-row.js";

/**
 * The prompt that brings an engine conversation up to date: a transcript of
 * what it has not seen, then the current message. Shared by the things that
 * owe a conversation a catch-up: a session that switched engines (`preflight.ts`)
 * and a thread a fallback chain hop resumes or starts after other targets
 * served turns (`rate-limit-hop-prompt.ts`).
 */

/** How many prior messages a synthesized catch-up transcript carries. */
export const SYNC_TRANSCRIPT_MESSAGES = 20;

/** Notification kinds that are a message from another session; any other is the gateway's own notice. */
export const FROM_ANOTHER_SESSION = new Set(["agent-relay", "child-reply", "child-error"]);

/** A logged message as the engine would have read it: a notification's full text, not its banner. */
export function engineText(message: Pick<SessionMessage, "content" | "meta">): string {
  const full = message.meta?.["fullMessage"];
  return typeof full === "string" && full.trim() ? full : message.content;
}

function isFromAnotherSession(message: Pick<SessionMessage, "role" | "meta">): boolean {
  const kind = message.meta?.["kind"];
  return message.role === "notification" && typeof kind === "string" && FROM_ANOTHER_SESSION.has(kind);
}

/**
 * One message as a catch-up transcript line, or nothing for a row the
 * transcript leaves out. A message from another session is kept: an agent's
 * briefs, follow-ups and verdicts arrive that way, and a transcript without
 * them reads as if the last request were still the one to answer.
 */
export function syncTranscriptLine(message: SessionMessage): string | undefined {
  if (message.role === "user" || message.role === "assistant") return `${message.role.toUpperCase()}: ${message.content}`;
  if (isFromAnotherSession(message)) return `MESSAGE FROM ANOTHER SESSION: ${engineText(message)}`;
  return undefined;
}

/**
 * Whether `message` is the one `prompt` answers. The prompt may carry text added
 * around it: after a user message (the board reminder), or framing around a
 * message from another session (its banner and reply hint).
 */
export function isCurrentMessage(message: SessionMessage, prompt: string): boolean {
  if (message.role === "user") {
    const content = message.content.trim();
    return content !== "" && prompt.trimStart().startsWith(content);
  }
  if (!isFromAnotherSession(message)) return false;
  const text = engineText(message).trim();
  return text !== "" && prompt.includes(text);
}

/** `messages` without the one `prompt` answers (the newest that matches), which the prompt carries itself. */
export function withoutCurrentMessage(messages: readonly SessionMessage[], prompt: string): SessionMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCurrentMessage(messages[i]!, prompt)) return [...messages.slice(0, i), ...messages.slice(i + 1)];
  }
  return [...messages];
}

/** The transcript lines of `messages`, newest `SYNC_TRANSCRIPT_MESSAGES` of them, oldest first. */
export function syncTranscript(messages: readonly SessionMessage[]): string {
  return messages
    .map(syncTranscriptLine)
    .filter((line): line is string => line !== undefined)
    .slice(-SYNC_TRANSCRIPT_MESSAGES)
    .join("\n\n");
}

/** The current message as the prompt's last section; nothing for a blank prompt. */
export function currentMessageSection(prompt: string): string {
  return prompt.trim() ? `CURRENT MESSAGE:\n${prompt}` : "";
}

/** The intro, the transcript of `earlier` and the current message, in that order. `earlier` leaves out the message `prompt` answers. */
export function catchUpPrompt(opts: { earlier: readonly SessionMessage[]; prompt: string; intro: string }): string {
  return [opts.intro, syncTranscript(opts.earlier), currentMessageSection(opts.prompt)].filter(Boolean).join("\n\n");
}

/**
 * `recentMessages` is what the conversation has not seen, oldest first; `prompt`
 * is the message to answer. The prompt is not repeated when the newest message
 * already is it.
 */
export function syncTranscriptPrompt(opts: { recentMessages: readonly SessionMessage[]; prompt: string; intro: string }): string {
  const { recentMessages, prompt, intro } = opts;
  const latest = recentMessages.at(-1);
  const promptAlreadyInTranscript = latest?.content === prompt
    && (latest.role === "user" || latest.role === "assistant");
  if (promptAlreadyInTranscript) return [intro, syncTranscript(recentMessages)].filter(Boolean).join("\n\n");
  return catchUpPrompt({ earlier: withoutCurrentMessage(recentMessages, prompt), prompt, intro });
}
