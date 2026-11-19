/**
 * The reason a limited engine's process is released with when its turn is handed to another
 * account or engine. The engine reads it to tell a move (the session keeps running elsewhere, and
 * is told what its old process held) from a stop.
 */
export const ENGINE_SWITCHED_REASON = "Interrupted: engine switched";

/**
 * Why a session's engine process ended under background tasks it started: `stopped` (a kill, or the
 * gateway shutting down), `moved` (a kill that handed the session to another account or engine), or
 * `ended` (anything else: an idle eviction, a respawn, a crash).
 */
export type LostBackgroundCause = "stopped" | "moved" | "ended";
