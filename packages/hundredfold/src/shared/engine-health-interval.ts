/**
 * How often to re-read every engine's quota windows. Without it the health store
 * is written almost only by a turn that already failed, so each new session pays
 * one wasted turn to discover an engine is out of allowance. Fifteen minutes is
 * finer than any quota window resets and costs a few short-lived CLI spawns.
 *
 * Kept in `shared` so what reads the usage samples that refresh writes (the
 * account balancer's freshness rule) and the timer that writes them cannot drift.
 */
export const ENGINE_HEALTH_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
