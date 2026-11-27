/**
 * The native shell rejects with a serialised `{ code, message }`, not an
 * `Error`, so `instanceof Error` alone drops every reason it gives. Read the
 * message from either shape and fall back only when there is none.
 */
export function nativeErrorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error) return reason.message || fallback
  if (typeof reason === "string") return reason.trim() || fallback
  if (reason && typeof reason === "object") {
    const message = (reason as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }
  return fallback
}
