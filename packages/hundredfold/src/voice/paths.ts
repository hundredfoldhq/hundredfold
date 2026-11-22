/** The path of a voice socket: `/ws/voice/:sessionId`. Kept apart from the upgrade handler so routers can read it cheaply. */
const VOICE_PATH = /^\/ws\/voice\/([^/]+)$/;

/** The session id a voice upgrade path names, or null when the path is not one. */
export function voiceSessionId(requestUrl: string): string | null {
  const match = requestUrl.split("?")[0].match(VOICE_PATH);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
