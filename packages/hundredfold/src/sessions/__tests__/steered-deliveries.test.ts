import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Real rows on a throwaway home: what a hand-over's outcome does to the queue row.
process.env.HUNDREDFOLD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-steered-deliveries-"));

type Reg = typeof import("../registry.js");
type Steered = typeof import("../steered-deliveries.js");
let reg: Reg;
let steered: Steered;
let logger: typeof import("../../shared/logger.js").logger;

beforeAll(async () => {
  reg = await import("../registry.js");
  steered = await import("../steered-deliveries.js");
  ({ logger } = await import("../../shared/logger.js"));
  (await import("../../shared/db.js")).initDb();
});
afterEach(() => {
  steered.setSteerSettleTimeoutForTest();
  vi.restoreAllMocks();
});

const deferred = () => {
  let resolve!: (outcome: "steered" | "withdrawn") => void;
  const promise = new Promise<"steered" | "withdrawn">((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const row = (name: string) => reg.enqueueQueueItem("s-steer", `lane-${name}`, name, { internal: true });

describe("steered deliveries", () => {
  it("completes a parked row at once when the hand-over is taken in, keeping its message, and forgets it", async () => {
    const id = row("taken-in");
    const outcome = deferred();
    steered.registerSteeredDelivery(id, outcome.promise);

    outcome.resolve("steered");
    await flush();

    expect(reg.getQueueItem(id)?.status).toBe("completed");
    expect(await steered.settleSteeredDelivery(id)).toBeUndefined();
  });

  it("leaves a withdrawn row parked for its slot to run, then answers withdrawn once", async () => {
    const id = row("taken-back");
    steered.registerSteeredDelivery(id, Promise.resolve("withdrawn"));
    await flush();

    expect(reg.getQueueItem(id)?.status).toBe("pending");
    expect(await steered.settleSteeredDelivery(id)).toBe("withdrawn");
    expect(await steered.settleSteeredDelivery(id)).toBeUndefined();
  });

  it("reads a rejection as taken back, so the row runs rather than being lost", async () => {
    const id = row("rejected");
    steered.registerSteeredDelivery(id, Promise.reject(new Error("engine went away")));
    await flush();

    expect(reg.getQueueItem(id)?.status).toBe("pending");
    expect(await steered.settleSteeredDelivery(id)).toBe("withdrawn");
  });

  it("leaves a row its slot already claimed to that slot, which is waiting on the answer", async () => {
    const id = row("claimed");
    const outcome = deferred();
    steered.registerSteeredDelivery(id, outcome.promise);
    expect(reg.markQueueItemRunning(id)).toBe(true);
    const waiting = steered.settleSteeredDelivery(id);

    outcome.resolve("steered");

    expect(await waiting).toBe("steered");
    expect(reg.getQueueItem(id)?.status).toBe("running");
  });

  it("forgets the hand-over of a row cancelled before its slot, when the outcome arrives", async () => {
    const id = row("cancelled");
    const outcome = deferred();
    steered.registerSteeredDelivery(id, outcome.promise);
    reg.cancelQueueItem(id);

    outcome.resolve("withdrawn");
    await flush();

    expect(await steered.settleSteeredDelivery(id)).toBeUndefined();
  });

  it("forgets a withdrawn hand-over whose row was cancelled afterwards, when the next one is registered", async () => {
    const id = row("withdrawn-then-cancelled");
    steered.registerSteeredDelivery(id, Promise.resolve("withdrawn"));
    await flush();
    expect(reg.getQueueItem(id)?.status).toBe("pending");
    reg.cancelQueueItem(id);

    steered.registerSteeredDelivery(row("next"), Promise.resolve("withdrawn"));

    expect(await steered.settleSteeredDelivery(id)).toBeUndefined();
  });

  it("stops waiting after the bound, runs the row and warns it may be answered twice; a late taken-in changes nothing", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    steered.setSteerSettleTimeoutForTest(20);
    const id = row("never-settles");
    const outcome = deferred();
    steered.registerSteeredDelivery(id, outcome.promise);
    reg.markQueueItemRunning(id);

    expect(await steered.settleSteeredDelivery(id)).toBe("withdrawn");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("may be answered twice"));

    outcome.resolve("steered");
    await flush();
    expect(reg.getQueueItem(id)?.status).toBe("running");
    expect(await steered.settleSteeredDelivery(id)).toBeUndefined();
  });

  it("has nothing to say about a row that was never handed to a turn", async () => {
    expect(await steered.settleSteeredDelivery("row-never")).toBeUndefined();
    expect(await steered.settleSteeredDelivery(undefined)).toBeUndefined();
  });
});
