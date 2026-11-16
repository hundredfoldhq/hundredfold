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

/**
 * The budget of a transcript that travels in one command-line argument (a
 * remote session's system prompt shares that argument, argv-limit.ts), so it
 * stays well short of the 128 KiB limit. Each message is clipped first, so a
 * single long one cannot crowd out the rest.
 */
export const TRANSCRIPT_MAX_BYTES = 24_000;
export const TRANSCRIPT_MESSAGE_MAX_BYTES = 4_000;

/** `text` cut to at most `max` UTF-8 bytes, marked where it was cut. */
export function clipToBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  const marker = " […clipped]";
  let clipped = Buffer.from(text).subarray(0, max - Buffer.byteLength(marker)).toString("utf8");
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  clipped = clipped.replace(/\uFFFD$/, "");
  return `${clipped}${marker}`;
}

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
  if (message.role === "user" || message.role === "assistant") return `${message.role.toUpperCase()}: ${clipToBytes(message.content, TRANSCRIPT_MESSAGE_MAX_BYTES)}`;
  if (isFromAnotherSession(message)) return `MESSAGE FROM ANOTHER SESSION: ${clipToBytes(engineText(message), TRANSCRIPT_MESSAGE_MAX_BYTES)}`;
  return undefined;
}

/** How much of a long message from another session is looked for in a prompt that clipped it. */
const CLIPPED_MATCH_CHARS = 200;

/**
 * Whether `message` is the one `prompt` answers. The prompt may carry text added
 * around it: after a user message (the board reminder), or framing around a
 * message from another session (its banner and reply hint). A notification is
 * matched as whole lines, so a short earlier message ("ok") is not mistaken for
 * a prompt that merely contains it. A long one the prompt clipped is matched by
 * its opening lines and the session it came from.
 */
export function isCurrentMessage(message: SessionMessage, prompt: string): boolean {
  if (message.role === "user") {
    const content = message.content.trim();
    return content !== "" && prompt.trimStart().startsWith(content);
  }
  return isFromAnotherSession(message) && isCurrentRelay(message, prompt);
}

/** Whether `prompt` carries the message from another session `message`, whole or clipped. */
function isCurrentRelay(message: SessionMessage, prompt: string): boolean {
  const text = engineText(message).trim();
  if (text === "") return false;
  const lines = `\n${prompt}\n`;
  if (lines.includes(`\n${text}\n`)) return true;
  if (text.length <= CLIPPED_MATCH_CHARS) return false;
  const origin = message.meta?.["childSessionId"] ?? message.meta?.["fromSessionId"];
  return typeof origin === "string" && origin !== "" && prompt.includes(origin) && lines.includes(`\n${text.slice(0, CLIPPED_MATCH_CHARS)}`);
}

/** `messages` without the one `prompt` answers (the newest that matches), which the prompt carries itself. */
export function withoutCurrentMessage(messages: readonly SessionMessage[], prompt: string): SessionMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCurrentMessage(messages[i]!, prompt)) return [...messages.slice(0, i), ...messages.slice(i + 1)];
  }
  return [...messages];
}

/**
 * The newest transcript lines of `messages`, oldest first: at most `maxLines`
 * of them and `TRANSCRIPT_MAX_BYTES` together, the oldest dropped first.
 */
export function syncTranscriptLines(messages: readonly SessionMessage[], maxLines = SYNC_TRANSCRIPT_MESSAGES): string[] {
  const lines: string[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0 && lines.length < maxLines; i--) {
    const line = syncTranscriptLine(messages[i]!);
    if (line === undefined) continue;
    const size = Buffer.byteLength(line) + 2;
    if (bytes + size > TRANSCRIPT_MAX_BYTES) break;
    bytes += size;
    lines.unshift(line);
  }
  return lines;
}

/** The transcript of `messages`, within the budget of `syncTranscriptLines`. */
export function syncTranscript(messages: readonly SessionMessage[], maxLines = SYNC_TRANSCRIPT_MESSAGES): string {
  return syncTranscriptLines(messages, maxLines).join("\n\n");
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
