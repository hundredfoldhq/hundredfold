/**
 * Whether the words heard so far read as the middle of a thought, so a pause after them is more likely a
 * breath than the end of the turn. A guess from the text alone: it errs towards "finished" (an unknown last
 * word is finished) because holding too long costs every reply, while holding too little only costs one cut-in.
 */

/** Words a sentence does not stop on. */
const OPEN_WORDS = new Set([
  "a", "an", "the", "this", "that", "these", "those", "my", "your", "our", "their", "his", "her", "its",
  "and", "but", "or", "so", "because", "if", "when", "while", "although", "though", "unless", "until", "since", "than", "then", "also",
  "to", "of", "in", "on", "at", "for", "with", "from", "by", "about", "into", "onto", "over", "under", "between", "through", "as",
  "is", "are", "was", "were", "am", "be", "been", "do", "does", "did", "have", "has", "had", "will", "would", "can", "could", "should", "might", "may", "must",
  "i", "i'm", "i've", "i'd", "i'll", "we", "we're", "you", "he", "she", "they", "it", "what", "which", "who", "whose", "how", "why", "where",
  "um", "uh", "er", "erm", "like", "well", "okay", "ok",
]);

export function looksUnfinished(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (/[,;:—–…-]$|\.\.\.$/.test(trimmed)) return true;
  if (/[.?!]["')\]]*$/.test(trimmed)) return false;
  const last = trimmed.split(/\s+/).pop()!.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
  return OPEN_WORDS.has(last);
}
