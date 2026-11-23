/**
 * The dictation slice of the `api` object. Dictation sends a finished recording, decoded to 16 kHz mono PCM16,
 * to the gateway, which runs it through the speech-to-text provider voice mode is set up with.
 *
 * It does not go through the JSON verbs: it posts a raw body and needs its own abort timer, so it takes
 * `authFetch` directly.
 */

export interface DictationHttp {
  authFetch: (path: string, init?: RequestInit) => Promise<Response>
}

/** A long dictation can take a while to decode; five minutes is the ceiling after which something is wrong rather than slow. */
const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === "string" && body.error) return body.error
  } catch { /* not JSON */ }
  return `API error: ${res.status}`
}

export function createDictationApi({ authFetch }: DictationHttp) {
  return {
    /** The text of `pcm` (16 kHz mono 16-bit samples). Rejects with the gateway's own words when voice mode cannot do it. */
    transcribeRecording: async (pcm: Int16Array): Promise<{ text: string }> => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
      try {
        const res = await authFetch("/api/voice/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Blob([pcm.buffer as ArrayBuffer]),
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(await errorMessage(res))
        return res.json()
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error("Transcription timed out (5 min)")
        }
        throw err
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
