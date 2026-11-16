import { describe, expect, it } from "vitest";
import { resolveMessageDelivery, runningTurnAction, shouldInterruptRunningTurn } from "../message-interrupt.js";

describe("shouldInterruptRunningTurn", () => {
  const base = { isNotification: false, prompt: "stop, do this instead", interruptOnNewMessage: undefined, turnRunning: true };

  it("lets an operator message cut a running turn off, unless configured not to", () => {
    expect(shouldInterruptRunningTurn(base)).toBe(true);
    expect(shouldInterruptRunningTurn({ ...base, interruptOnNewMessage: false })).toBe(false);
  });

  it("never interrupts for a notification, or when nothing is running", () => {
    expect(shouldInterruptRunningTurn({ ...base, isNotification: true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, turnRunning: false })).toBe(false);
  });

  it("queues /compact behind the running turn instead", () => {
    expect(shouldInterruptRunningTurn({ ...base, prompt: "/compact" })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, prompt: "  /compact keep the ids" })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, prompt: "/compaction is next" })).toBe(true);
  });

  it("lets a running auto-compaction finish instead of throwing it away", () => {
    expect(shouldInterruptRunningTurn({ ...base, autoCompacting: true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, autoCompacting: false })).toBe(true);
  });

  it("honours a per-message queue choice over the interrupting default", () => {
    expect(shouldInterruptRunningTurn({ ...base, delivery: "queue" })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "queue", interruptOnNewMessage: true })).toBe(false);
  });

  it("honours a per-message send-now choice over a queueing default", () => {
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", interruptOnNewMessage: false })).toBe(true);
  });

  it("keeps the guards above an explicit send-now choice", () => {
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", isNotification: true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", turnRunning: false })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", autoCompacting: true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", prompt: "/compact" })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", queuePaused: () => true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, queuePaused: () => true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", queuePaused: () => false })).toBe(true);
  });
});

describe("resolveMessageDelivery", () => {
  it("prefers an explicit delivery, then the legacy interrupt boolean", () => {
    expect(resolveMessageDelivery({ delivery: "queue", interrupt: true })).toBe("queue");
    expect(resolveMessageDelivery({ delivery: "now", interrupt: false })).toBe("now");
    expect(resolveMessageDelivery({ interrupt: true })).toBe("now");
    expect(resolveMessageDelivery({ interrupt: false })).toBe("queue");
  });

  it("leaves anything else to the caller's default", () => {
    expect(resolveMessageDelivery({})).toBeUndefined();
    expect(resolveMessageDelivery({ delivery: "later" })).toBeUndefined();
    expect(resolveMessageDelivery({ delivery: 1, interrupt: "yes" })).toBeUndefined();
  });
});

describe("runningTurnAction", () => {
  type Action = ReturnType<typeof runningTurnAction>;
  const notification = { isNotification: true, prompt: "🏷️ you were tagged", interruptOnNewMessage: undefined as boolean | undefined, turnRunning: true };
  const flagged = { ...notification, reachRunningTurn: true };
  const steerable = { canSteer: () => true };
  const notSteerable = { canSteer: () => false };

  // Each row: the situation, then what a flagged mention and an unflagged notification do in it.
  const rows: Array<{ name: string; extra: Record<string, unknown>; flagged: Action; unflagged: Action }> = [
    { name: "no turn running", extra: { turnRunning: false, ...steerable }, flagged: "queue", unflagged: "queue" },
    { name: "running, engine can steer", extra: steerable, flagged: "steer", unflagged: "queue" },
    { name: "running, engine cannot steer", extra: notSteerable, flagged: "promote", unflagged: "queue" },
    { name: "running, no steering offered at all", extra: {}, flagged: "promote", unflagged: "queue" },
    { name: "interruptOnNewMessage off, engine can steer", extra: { interruptOnNewMessage: false, ...steerable }, flagged: "steer", unflagged: "queue" },
    { name: "interruptOnNewMessage off, engine cannot steer", extra: { interruptOnNewMessage: false, ...notSteerable }, flagged: "promote", unflagged: "queue" },
    { name: "interruptOnNewMessage on, engine cannot steer", extra: { interruptOnNewMessage: true, ...notSteerable }, flagged: "promote", unflagged: "queue" },
    { name: "interruptOnNewMessage on, engine can steer", extra: { interruptOnNewMessage: true, ...steerable }, flagged: "steer", unflagged: "queue" },
    { name: "queue paused", extra: { queuePaused: () => true, ...steerable }, flagged: "queue", unflagged: "queue" },
    { name: "queue not paused", extra: { queuePaused: () => false, ...steerable }, flagged: "steer", unflagged: "queue" },
    { name: "auto-compacting", extra: { autoCompacting: true, ...steerable }, flagged: "queue", unflagged: "queue" },
    { name: "a compact command", extra: { prompt: "/compact keep the ids", ...steerable }, flagged: "queue", unflagged: "queue" },
  ];

  it.each(rows)("$name: a flagged mention $flagged, an unflagged notification $unflagged", (row) => {
    expect(runningTurnAction({ ...flagged, ...row.extra })).toBe(row.flagged);
    expect(runningTurnAction({ ...notification, ...row.extra })).toBe(row.unflagged);
  });

  it("never answers interrupt for a flagged mention, whatever else is set", () => {
    for (const interruptOnNewMessage of [undefined, true, false]) {
      for (const delivery of [undefined, "queue" as const, "now" as const]) {
        for (const extra of [steerable, notSteerable, {}]) {
          expect(runningTurnAction({ ...flagged, interruptOnNewMessage, delivery, ...extra })).not.toBe("interrupt");
        }
      }
    }
  });

  it("never asks the engine whether it can steer when nothing could be steered", () => {
    let asked = 0;
    const canSteer = () => { asked++; return true; };
    runningTurnAction({ ...notification, canSteer });
    runningTurnAction({ ...flagged, turnRunning: false, canSteer });
    runningTurnAction({ ...flagged, queuePaused: () => true, canSteer });
    expect(asked).toBe(0);
  });

  it("ignores a per-message delivery choice for a flagged mention, which no request can make", () => {
    expect(runningTurnAction({ ...flagged, delivery: "queue", ...steerable })).toBe("steer");
    expect(runningTurnAction({ ...flagged, delivery: "queue", ...notSteerable })).toBe("promote");
    expect(runningTurnAction({ ...flagged, delivery: "now", ...notSteerable })).toBe("promote");
  });

  it("leaves everything unflagged exactly as shouldInterruptRunningTurn has it", () => {
    const base = { isNotification: false, prompt: "stop, do this instead", interruptOnNewMessage: undefined as boolean | undefined, turnRunning: true };
    for (const extra of [{}, { interruptOnNewMessage: false }, { delivery: "queue" as const }, { delivery: "now" as const, interruptOnNewMessage: false },
      { prompt: "/compact" }, { autoCompacting: true }, { turnRunning: false }, { queuePaused: () => true }, { isNotification: true }, { isNotification: true, delivery: "now" as const }]) {
      expect(runningTurnAction({ ...base, ...extra, ...steerable })).toBe(shouldInterruptRunningTurn({ ...base, ...extra }) ? "interrupt" : "queue");
    }
  });
});
