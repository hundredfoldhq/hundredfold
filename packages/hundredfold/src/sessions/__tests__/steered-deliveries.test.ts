import { describe, expect, it } from "vitest";
import { registerSteeredDelivery, settleSteeredDelivery } from "../steered-deliveries.js";

describe("steered deliveries", () => {
  it("answers what became of the hand-over once it is known, then forgets it", async () => {
    let resolve!: (outcome: "steered" | "withdrawn") => void;
    registerSteeredDelivery("row-a", new Promise((done) => { resolve = done; }));
    const settled = settleSteeredDelivery("row-a");
    resolve("steered");
    expect(await settled).toBe("steered");
    expect(await settleSteeredDelivery("row-a")).toBeUndefined();
  });

  it("reads a rejection as taken back, so the row runs rather than being lost", async () => {
    registerSteeredDelivery("row-b", Promise.reject(new Error("engine went away")));
    expect(await settleSteeredDelivery("row-b")).toBe("withdrawn");
  });

  it("has nothing to say about a row that was never handed to a turn", async () => {
    expect(await settleSteeredDelivery("row-never")).toBeUndefined();
    expect(await settleSteeredDelivery(undefined)).toBeUndefined();
  });
});
