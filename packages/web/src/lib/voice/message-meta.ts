import type { VoiceMessageMeta } from "@hundredfold/gateway-events"

const FIELD_CHECKS: { [K in keyof VoiceMessageMeta]-?: (value: unknown) => boolean } = {
  utteranceId: (v) => typeof v === "string",
  sttProvider: (v) => typeof v === "string",
  audioMs: (v) => typeof v === "number",
  spokenText: (v) => typeof v === "string",
  interrupted: (v) => typeof v === "boolean",
  ttfaMs: (v) => typeof v === "number" && v >= 0,
}

/** The `voice` facts on a message's `meta`, read defensively: anything malformed is left out. */
export function voiceMeta(meta: Record<string, unknown> | undefined): VoiceMessageMeta | null {
  const raw = meta?.voice
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const voice = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, valid] of Object.entries(FIELD_CHECKS)) if (valid(voice[key])) out[key] = voice[key]
  return Object.keys(out).length > 0 ? (out as VoiceMessageMeta) : null
}

export function formatTtfa(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

export interface UnheardSplit {
  /** The part the user heard, ending where playback stopped. */
  heard: string
  /** The rest, which was never spoken. */
  unheard: string
}

interface Token {
  word: string
  end: number
}

/** Tokens may not start inside these: the voice prompt keeps them out of speech. */
const UNSPOKEN = /```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/\S+|\]\([^)\n]*\)|^\|.*$/gm
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu
/** How far ahead of the last match a spoken word is searched for. */
const LOOKAHEAD_TOKENS = 80
/** Below this share of the spoken words found in the reply, the match is not trusted. */
const MIN_MATCH_RATIO = 0.6

function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (m) => " ".repeat(m.length))
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  for (const m of text.matchAll(WORD)) tokens.push({ word: m[0].toLowerCase().replace("’", "'"), end: (m.index ?? 0) + m[0].length })
  return tokens
}

function insideOpenFence(content: string, index: number): boolean {
  const fences = content.slice(0, index).match(/^```/gm)
  return (fences?.length ?? 0) % 2 === 1
}

function endOfFence(content: string, index: number): number {
  const close = content.indexOf("\n```", index)
  if (close === -1) return content.length
  const lineEnd = content.indexOf("\n", close + 1)
  return lineEnd === -1 ? content.length : lineEnd
}

/** Keeps the sentence's closing punctuation and emphasis marks with the heard part. */
function withClosers(content: string, index: number): number {
  const closers = /^(?:[.!?…:;,]|["')\]*_~])*/.exec(content.slice(index))
  return index + (closers?.[0].length ?? 0)
}

/** Code and tables that directly follow heard words are part of what was heard: speech never reads them. */
function absorbUnspoken(content: string, index: number): number {
  const block = /^\s*(?:```[\s\S]*?(?:```|$)|(?:\|.*(?:\n|$))+)/
  let cut = index
  for (let m = block.exec(content.slice(cut)); m && m[0].trim(); m = block.exec(content.slice(cut))) cut += m[0].length
  return cut
}

/**
 * Where an interrupted reply stopped being heard. `spokenText` is what was
 * actually spoken (sentences with code, paths and links already left out), so
 * it is matched word by word against the reply's speakable text, in order, and
 * the reply is cut after the last word that matched. Returns null when there
 * is nothing to set apart or the match cannot be trusted.
 */
export function splitUnheard(content: string, spokenText: string): UnheardSplit | null {
  const spoken = tokenize(spokenText)
  if (spoken.length === 0) return content.trim() ? { heard: "", unheard: content.trim() } : null
  const reply = tokenize(blank(content, UNSPOKEN))
  let next = 0
  let matched = 0
  let lastEnd = -1
  for (const { word } of spoken) {
    const stop = Math.min(next + LOOKAHEAD_TOKENS, reply.length)
    for (let i = next; i < stop; i++) {
      if (reply[i].word !== word) continue
      next = i + 1
      matched++
      lastEnd = reply[i].end
      break
    }
  }
  if (lastEnd < 0 || matched / spoken.length < MIN_MATCH_RATIO) return null
  let cut = withClosers(content, lastEnd)
  if (insideOpenFence(content, cut)) cut = endOfFence(content, cut)
  cut = absorbUnspoken(content, cut)
  const unheard = content.slice(cut).trim()
  if (!unheard) return null
  return { heard: content.slice(0, cut).trimEnd(), unheard }
}
