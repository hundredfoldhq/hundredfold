import { startHeartbeatScheduler } from "../heartbeats/scheduler.js";

/** Start the schedulers that enforce liveness for gateway-owned sessions. */
export function startSessionSchedulers(): () => void {
  const stopHeartbeatScheduler = startHeartbeatScheduler();
  return () => {
    stopHeartbeatScheduler();
  };
}
