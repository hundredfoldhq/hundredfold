import { describe, expect, it } from "vitest";
import { decideBargeIn, foregroundWorkOf, isLongWork, type BargeInInput } from "../barge-in-policy.js";

const NOW = 100_000;
const THRESHOLD = 5_000;

const base: BargeInInput = { turnRunning: true, longWork: null, nowMs: NOW, thresholdMs: THRESHOLD, soft: null, steerable: false };
const long = { tool: "Bash", startedAt: NOW - 8_000, description: "sleep 60" };
const young = { tool: "Bash", startedAt: NOW - 1_200, description: "sleep 60" };

describe("the barge-in decision table (contracts/providers.md)", () => {
  it("no turn running: a new turn, whatever the engine can do", () => {
    for (const soft of [null, { preserves: true }, { preserves: false }]) {
      expect(decideBargeIn({ ...base, turnRunning: false, soft, steerable: true })).toEqual({ kind: "new_turn" });
    }
  });

  it("a tool call younger than the threshold: wait out the rest of it, then decide again", () => {
    expect(decideBargeIn({ ...base, longWork: young, soft: { preserves: true } })).toEqual({ kind: "wait_then_decide", waitMs: THRESHOLD - 1_200 });
    expect(decideBargeIn({ ...base, longWork: young, steerable: true })).toEqual({ kind: "wait_then_decide", waitMs: THRESHOLD - 1_200 });
  });

  it("a call exactly at the threshold is long work", () => {
    const edge = { ...long, startedAt: NOW - THRESHOLD };
    expect(isLongWork(edge, NOW, THRESHOLD)).toBe(true);
    expect(decideBargeIn({ ...base, longWork: edge, soft: { preserves: true } })).toEqual({ kind: "soft_then_turn" });
  });

  it.each([
    ["no work, soft that preserves", null, { preserves: true }, false, "soft_then_turn"],
    ["no work, soft that does not preserve", null, { preserves: false }, true, "soft_then_turn"],
    ["long work, soft that preserves", long, { preserves: true }, false, "soft_then_turn"],
    ["long work, soft that preserves, steerable too", long, { preserves: true }, true, "soft_then_turn"],
    ["long work, soft that does not preserve, steerable", long, { preserves: false }, true, "steer_with_holding"],
    ["long work, soft that does not preserve, not steerable", long, { preserves: false }, false, "queue_with_holding"],
    ["long work, no soft, steerable", long, null, true, "steer_with_holding"],
    ["long work, no soft, not steerable", long, null, false, "queue_with_holding"],
    ["no work, no soft, steerable", null, null, true, "steer"],
    ["no work, no soft, not steerable", null, null, false, "interrupt_now"],
  ] as const)("%s → %s", (_name, longWork, soft, steerable, kind) => {
    expect(decideBargeIn({ ...base, longWork, soft, steerable }).kind).toBe(kind);
  });

  it("never picks interrupt_now while the engine reports a foreground call, in any combination", () => {
    const softs = [null, { preserves: true }, { preserves: false }];
    const combos = [young, long].flatMap((longWork) => softs.flatMap((soft) => [true, false].flatMap((steerable) => (
      [NOW, NOW + 3_000, NOW + 60_000].map((nowMs) => ({ ...base, longWork, soft, steerable, nowMs }))
    ))));
    expect(combos).toHaveLength(36);
    for (const input of combos) expect(decideBargeIn(input).kind).not.toBe("interrupt_now");
  });

  it("with the threshold at zero a young call is long at once", () => {
    expect(decideBargeIn({ ...base, longWork: young, thresholdMs: 0, steerable: true }).kind).toBe("steer_with_holding");
  });
});

describe("foregroundWorkOf", () => {
  it("is whatever the engine reports, and none for an engine with no way to say", () => {
    expect(foregroundWorkOf({ foregroundWork: () => long }, "s1")).toBe(long);
    expect(foregroundWorkOf({}, "s1")).toBeNull();
  });
});
