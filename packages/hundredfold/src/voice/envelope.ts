/**
 * The voice envelope: instructions for a spoken conversation that ride the
 * prompt an engine receives, never the message the session stores (FR-019,
 * FR-020). The same pattern as the board reminder and the left-background
 * note: applied when the engine is called, read back out of the engine's own
 * transcript by {@link withoutVoiceEnvelope}.
 *
 * Shape of the prefix, ahead of the sender's text and a blank line:
 *
 *     [Voice mode]                       (the full prompt, first turn only)
 *     <prompt, any number of lines>
 *     [End of voice instructions]
 *     <style directions, when configured>   (inside the block)
 *     [Voice: transcribed from speech ...]
 *     [Voice: ...]                       (one line each: reminder, style, interrupted, backgrounded)
 *
 * A prompt that starts with `/` gets nothing: text in front of a command turns
 * it into text for the model.
 */

import { MAX_STYLE_PROMPT_CHARS } from "../shared/voice-config.js";

export const VOICE_PROMPT_OPEN = "[Voice mode]";
export const VOICE_PROMPT_CLOSE = "[End of voice instructions]";
export const VOICE_REMINDER = "[Voice: spoken reply. Short, plain sentences; no markdown or code read aloud.]";
export const VOICE_TRANSCRIBED = "[Voice: this was transcribed from speech and may contain misheard names or words; infer the intended meaning.]";

/** What the envelope is built from. */
export interface VoiceEnvelopeInput {
  /** The sender's text, to test for a leading `/`. */
  text: string;
  /** The voice prompt (built in or configured). */
  prompt: string;
  /** The operator's style directions (`voice.stylePrompt`); empty or absent adds nothing. They ride on every turn. */
  style?: string;
  /** The style was set on an earlier turn and is empty now: tell the engine to drop it (a reminder turn only). */
  styleCleared?: boolean;
  /** The full prompt goes on this turn, not just the reminder. */
  full: boolean;
  /** Extra one-line facts for this turn: an interruption, work moved to the background. */
  notes?: readonly string[];
}

export function isSlashText(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/** One line that cannot break the envelope: no newlines, no brackets of its own. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")")).trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The prompt text with anything that could close the block early removed. Stripped until nothing changes: a
 * token nested inside another (`[End of voice [End of voice instructions]instructions]`) reassembles after one pass.
 */
function safePrompt(prompt: string): string {
  let text = prompt;
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.split(VOICE_PROMPT_CLOSE).join("").split(VOICE_PROMPT_OPEN).join("");
  }
  return text.trim();
}

/** Heading of the style directions inside the full prompt block. */
export const VOICE_STYLE_HEADING = "Style directions from the user (follow these in how you sound):";

/**
 * The style directions as one line, for the turns that carry the reminder instead of the full prompt. It says it
 * replaces what came before: the first turn's block (and earlier lines) stay in the engine's history, so an
 * edited style must be told to win over them. A multi-line style is flattened to one line here.
 */
function styleLine(style: string): string {
  return `[Voice: style directions from the user, replacing any earlier style directions: ${oneLine(style, MAX_STYLE_PROMPT_CHARS)}]`;
}

/** Sent once when the style goes from set to empty: the earlier directions are still in the engine's history. */
export const VOICE_STYLE_CLEARED = "[Voice: the user's style directions were removed; ignore any earlier style directions.]";

/** The note for a turn that follows an interrupted reply. */
export function interruptedNote(heardText: string): string {
  const heard = oneLine(heardText, 400);
  const clause = heard ? `the user heard only: "${heard}"` : "the user heard none of it";
  return `[Voice: your previous reply was interrupted by the user speaking; ${clause}. Answer what they just said.]`;
}

/** The note for a turn that follows long work moved to the background. */
export function backgroundedNote(tasks: readonly { taskId: string; description: string | null }[]): string {
  const named = tasks.map((task) => oneLine(task.description ?? task.taskId, 120)).join("; ");
  return `[Voice: work you were running was moved to the background and is still running (${named}). You will be told when it finishes.]`;
}

/** The prefix for this turn, ending in a blank line, or "" when the prompt is a command. */
export function buildVoiceEnvelope(input: VoiceEnvelopeInput): string {
  if (isSlashText(input.text)) return "";
  const lines: string[] = [];
  const style = safePrompt(input.style ?? "");
  if (input.full) {
    lines.push(VOICE_PROMPT_OPEN, safePrompt(input.prompt));
    if (style) lines.push("", VOICE_STYLE_HEADING, style);
    lines.push(VOICE_PROMPT_CLOSE, VOICE_TRANSCRIBED);
  } else {
    lines.push(VOICE_REMINDER);
    if (style) lines.push(styleLine(style));
    else if (input.styleCleared) lines.push(VOICE_STYLE_CLEARED);
  }
  for (const note of input.notes ?? []) lines.push(note);
  return `${lines.join("\n")}\n\n`;
}

/** The engine's text: the envelope ahead of the sender's words. */
export function withVoiceEnvelope(text: string, envelope: string | undefined): string {
  return envelope ? `${envelope}${text}` : text;
}

/** The prefix as it sits at the head of a prompt: block or one-line entries, then a blank line. */
const LEADING_ENVELOPE = new RegExp(
  `^(?:(?:${escape(VOICE_PROMPT_OPEN)}\\n[\\s\\S]*?\\n${escape(VOICE_PROMPT_CLOSE)}|\\[Voice: [^\\n]*\\])\\n)+\\n`,
);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A prompt read back from an engine's own transcript, without the envelope this
 * gateway put ahead of it, so a transcript sync matches the message the session
 * stored and never writes the envelope in as a new one.
 */
export function withoutVoiceEnvelope(text: string): string {
  return text.replace(LEADING_ENVELOPE, "");
}
