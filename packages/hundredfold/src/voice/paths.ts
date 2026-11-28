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

/**
 * Whether a voice upgrade only asks to end a conversation its client left suspended (`?end=suspended`): a client
 * that paused voice mode and then ended it says goodbye this way, without taking over an attachment another of its
 * tabs or devices may be using.
 */
export function voiceEndsSuspended(requestUrl: string): boolean {
  const query = requestUrl.split("?")[1];
  return query !== undefined && new URLSearchParams(query).get("end") === "suspended";
}
