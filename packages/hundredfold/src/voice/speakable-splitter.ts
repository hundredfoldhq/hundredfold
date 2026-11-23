/**
 * Streamed reply text to speakable sentences (FR-005, FR-006). Deltas arrive in
 * arbitrary pieces; a sentence is handed on only once its end is certain, so
 * the first one can be spoken while the reply is still being written.
 *
 * What is never spoken: fenced code, table rows, paths, links, ids, markdown
 * marks (the last three by `toSpeakable`). It stays in the chat as text.
 */
import { toSpeakable } from "./speakable.js";

/** A sentence ends at a terminator followed by space, or at a line break (as `splitTtsSentences`). */
const BOUNDARY = /(?<=[.!?…])\s+|\n+/g;
/** Longest run spoken without a terminator before it is cut at a comma or space. */
const MAX_UNBROKEN = 280;

const TABLE_ROW = /^\s*\|.*\|\s*$|^[\s|:+-]{3,}$/;
const LIST_MARKER = /^[ \t]*(?:[-*•]|\d+[.)])\s+/;
const PATH_TOKEN = /(?<![\w])(?:~|\.{0,2})(?:\/[\w.@+~-]+){2,}\/?|(?<![\w/])[\w.-]+(?:\/[\w.@+-]+)+\.[A-Za-z0-9]{1,8}\b/g;

/** A fence opener or closer. */
function isFence(line: string): boolean {
  return line.trimStart().startsWith("```");
}

/**
 * Whether a partly received line could still turn out to be code, a table row or a numbered list item (whose
 * "1." is not a sentence end), so it must wait for its line to finish.
 */
function undecidable(tail: string): boolean {
  const t = tail.trimStart();
  return t.startsWith("|") || (t.startsWith("`") && t.length < 3) || isFence(t) || /^\d+[.)](\s|$)/.test(t);
}

/** One spoken sentence from a raw chunk, or "" when nothing in it is worth saying. */
export function speakableSentence(raw: string): string {
  const spoken = toSpeakable(raw).replace(PATH_TOKEN, " ").replace(/\s{2,}/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(spoken) ? spoken : "";
}

export class SpeakableSplitter {
  /** Text of finished lines that passed the filter, not yet cut into sentences. */
  private pending = "";
  /** The line still being received. */
  private tail = "";
  private inFence = false;

  /** Take a reply delta; returns the sentences it completed. */
  push(delta: string): string[] {
    this.tail += delta;
    let at: number;
    while ((at = this.tail.indexOf("\n")) !== -1) {
      this.takeLine(this.tail.slice(0, at));
      this.tail = this.tail.slice(at + 1);
    }
    return this.cut(false);
  }

  /** The reply ended: what is left is spoken as it is. */
  flush(): string[] {
    if (this.tail) this.takeLine(this.tail);
    this.tail = "";
    const out = this.cut(true);
    this.pending = "";
    this.inFence = false;
    return out;
  }

  /** Forget everything held, as a barge-in does to a reply nobody will hear the rest of. */
  reset(): void {
    this.pending = "";
    this.tail = "";
    this.inFence = false;
  }

  private takeLine(line: string): void {
    if (isFence(line)) {
      this.inFence = !this.inFence;
      return;
    }
    if (this.inFence || TABLE_ROW.test(line)) return;
    this.pending += `${line.replace(LIST_MARKER, "")}\n`;
  }

  private cut(final: boolean): string[] {
    const tail = !this.inFence && !undecidable(this.tail) ? this.tail : "";
    const text = this.pending + tail;
    const sentences: string[] = [];
    let last = 0;
    for (const match of text.matchAll(BOUNDARY)) {
      sentences.push(text.slice(last, match.index));
      last = match.index + match[0].length;
    }
    let rest = text.slice(last);
    // A long run with no terminator is cut at its last comma or space so speech can start.
    while (rest.length > MAX_UNBROKEN) {
      const window = rest.slice(0, MAX_UNBROKEN);
      const comma = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
      const space = window.lastIndexOf(" ");
      const stop = comma > 40 ? comma + 1 : space > 0 ? space : MAX_UNBROKEN;
      sentences.push(rest.slice(0, stop));
      last += stop;
      rest = rest.slice(stop);
    }
    if (final && rest.trim()) {
      sentences.push(rest);
      last = text.length;
    }
    this.consume(last, tail.length);
    return sentences.map(speakableSentence).filter((sentence) => sentence.length > 0);
  }

  /** Drop the first `used` characters of the scanned text from the buffers it came from. */
  private consume(used: number, tailLength: number): void {
    const fromPending = Math.min(used, this.pending.length);
    this.pending = this.pending.slice(fromPending);
    const fromTail = used - fromPending;
    if (fromTail > 0 && tailLength > 0) this.tail = this.tail.slice(fromTail);
  }
}
