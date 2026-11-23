/**
 * Words and numbers that give a phantom utterance away. A knock or a tap can get past the VAD, and speech to text
 * then writes something for it ("Thank you", "Amen", a lone "You") with little confidence behind it. Anything that
 * asks to be sent to the assistant as the person's own words is checked here first; a dropped one is treated like
 * an empty transcript.
 */
import type { ResolvedVoiceConfig } from "../shared/voice-config.js";
import type { FinishedUtterance } from "./utterance-capture.js";

export type PhantomFilter = ResolvedVoiceConfig["filter"];

/** Lower case, punctuation gone, spaces collapsed: "Thank you." and "thank  you" are the same words. */
export function normalizeWords(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * A high no-speech chance alone is not enough when the provider also says how sure it was: Whisper-style servers often
 * report one for short clips that were decoded confidently, so (like Whisper itself) a transcript is dropped on it only
 * when the confidence is also low, or when no confidence was reported at all.
 */
function providerDoubt(quality: FinishedUtterance["quality"], filter: PhantomFilter): string | null {
  const confidence = quality?.confidence;
  if (confidence !== undefined && confidence < filter.minConfidence) {
    return `the provider's confidence was ${confidence.toFixed(2)} (below ${filter.minConfidence})`;
  }
  if (quality?.noSpeechProb !== undefined && quality.noSpeechProb > filter.noSpeechThreshold && confidence === undefined) {
    return `the provider put the chance of no speech at ${quality.noSpeechProb.toFixed(2)} (above ${filter.noSpeechThreshold}) and gave no confidence`;
  }
  return null;
}

function briefPhantom(text: string, speechMs: number | undefined, filter: PhantomFilter): string | null {
  if (filter.phantomMaxMs <= 0 || speechMs === undefined || speechMs >= filter.phantomMaxMs) return null;
  const words = normalizeWords(text);
  if (words === "" || !filter.phantomPhrases.some((phrase) => normalizeWords(phrase) === words)) return null;
  return `a clip voiced for ${speechMs} ms came back as a known phantom phrase`;
}

/** Why this utterance should not be sent, or null when it should. The reason carries numbers, never the person's words. */
export function phantomReason(utterance: Pick<FinishedUtterance, "text" | "speechMs" | "quality">, filter: PhantomFilter): string | null {
  return providerDoubt(utterance.quality, filter) ?? briefPhantom(utterance.text, utterance.speechMs, filter);
}
