import { describe, expect, it } from "vitest";
import { decideBargeIn, foregroundWorkOf, isLongWork, UNREPORTED_WORK, type BargeInInput } from "../barge-in-policy.js";

const NOW = 100_000;
const THRESHOLD = 5_000;

const base: BargeInInput = { turnRunning: true, longWork: null, nowMs: NOW, thresholdMs: THRESHOLD, soft: false, backgrounding: true, steerable: false };
/** A running Bash: a soft interrupt backgrounds it. */
const long = { tool: "Bash", startedAt: NOW - 8_000, description: "sleep 60", backgroundable: true };
/** A running MCP call: a soft interrupt would abort it, so it is not backgroundable. */
const longMcp = { ...long, tool: "mcp__search", backgroundable: false };
const young = { tool: "Bash", startedAt: NOW - 1_200, description: "sleep 60", backgroundable: true };

describe("the barge-in decision table (contracts/providers.md)", () => {
  it("no turn running: a new turn, whatever the engine can do", () => {
    for (const soft of [true, false]) {
      expect(decideBargeIn({ ...base, turnRunning: false, soft, steerable: true })).toEqual({ kind: "new_turn" });
    }
  });

  it("a tool call younger than the threshold: wait out the rest of it, then decide again", () => {
    expect(decideBargeIn({ ...base, longWork: young, soft: true })).toEqual({ kind: "wait_then_decide", waitMs: THRESHOLD - 1_200 });
    expect(decideBargeIn({ ...base, longWork: young, steerable: true })).toEqual({ kind: "wait_then_decide", waitMs: THRESHOLD - 1_200 });
  });

  it("a call exactly at the threshold is long work", () => {
    const edge = { ...long, startedAt: NOW - THRESHOLD };
    expect(isLongWork(edge, NOW, THRESHOLD)).toBe(true);
    expect(decideBargeIn({ ...base, longWork: edge, soft: true })).toEqual({ kind: "soft_then_turn" });
  });

  it.each([
    ["no work, soft interrupt", { longWork: null, soft: true, backgrounding: true, steerable: false }, "soft_then_turn"],
    ["no work, soft interrupt, backgrounding off", { longWork: null, soft: true, backgrounding: false, steerable: false }, "soft_then_turn"],
    ["long Bash, soft interrupt", { longWork: long, soft: true, backgrounding: true, steerable: false }, "soft_then_turn"],
    ["long Bash, soft interrupt, also steerable", { longWork: long, soft: true, backgrounding: true, steerable: true }, "soft_then_turn"],
    ["long MCP call, soft interrupt, steerable", { longWork: longMcp, soft: true, backgrounding: true, steerable: true }, "steer_with_holding"],
    ["long MCP call, soft interrupt, not steerable", { longWork: longMcp, soft: true, backgrounding: true, steerable: false }, "queue_with_holding"],
    ["long Bash, soft interrupt, backgrounding off, steerable", { longWork: long, soft: true, backgrounding: false, steerable: true }, "steer_with_holding"],
    ["long Bash, soft interrupt, backgrounding off, not steerable", { longWork: long, soft: true, backgrounding: false, steerable: false }, "queue_with_holding"],
    ["long work, no soft interrupt, steerable", { longWork: long, soft: false, backgrounding: true, steerable: true }, "steer_with_holding"],
    ["long work, no soft interrupt, not steerable", { longWork: long, soft: false, backgrounding: true, steerable: false }, "queue_with_holding"],
    ["no work, no soft interrupt, steerable", { longWork: null, soft: false, backgrounding: true, steerable: true }, "steer"],
    ["no work, no soft interrupt, not steerable", { longWork: null, soft: false, backgrounding: true, steerable: false }, "interrupt_now"],
  ] as const)("%s → %s", (_name, input, kind) => {
    expect(decideBargeIn({ ...base, ...input }).kind).toBe(kind);
  });

  it("never picks interrupt_now while the engine reports a foreground call, in any combination", () => {
    const works = [young, long, longMcp];
    const combos = works.flatMap((longWork) => [true, false].flatMap((soft) => [true, false].flatMap((backgrounding) => [true, false].flatMap((steerable) => (
      [NOW, NOW + 3_000, NOW + 60_000].map((nowMs) => ({ ...base, longWork, soft, backgrounding, steerable, nowMs }))
    )))));
    expect(combos).toHaveLength(72);
    for (const input of combos) expect(decideBargeIn(input).kind).not.toBe("interrupt_now");
  });

  it("never soft-interrupts a call that would be aborted rather than backgrounded", () => {
    for (const steerable of [true, false]) {
      expect(decideBargeIn({ ...base, longWork: longMcp, soft: true, steerable }).kind).not.toBe("soft_then_turn");
    }
  });

  it("with the threshold at zero a young call is long at once", () => {
    expect(decideBargeIn({ ...base, longWork: young, thresholdMs: 0, steerable: true }).kind).toBe("steer_with_holding");
  });
});

describe("foregroundWorkOf", () => {
  it("is whatever the engine reports, and none only for an engine that reports none", () => {
    expect(foregroundWorkOf({ foregroundWork: () => long }, "s1")).toBe(long);
    expect(foregroundWorkOf({ foregroundWork: () => null }, "s1")).toBeNull();
  });

  it("an engine with no way to say is taken to be running long work that cannot be backgrounded", () => {
    const work = foregroundWorkOf({}, "s1");
    expect(work).toBe(UNREPORTED_WORK);
    expect(work).toMatchObject({ tool: "unknown", backgroundable: false });
    expect(isLongWork(work!, NOW, THRESHOLD)).toBe(true);
  });

  it("so on such an engine the decision is steer or queue with the holding line, never interrupt_now or a soft interrupt", () => {
    const longWork = foregroundWorkOf({}, "s1");
    expect(decideBargeIn({ ...base, longWork, steerable: true }).kind).toBe("steer_with_holding");
    expect(decideBargeIn({ ...base, longWork, steerable: false }).kind).toBe("queue_with_holding");
    expect(decideBargeIn({ ...base, longWork, soft: true, steerable: true }).kind).toBe("steer_with_holding");
  });

  it("interrupt_now is only for an engine that reports foreground work and reports none", () => {
    const reportsNone = foregroundWorkOf({ foregroundWork: () => null }, "s1");
    expect(decideBargeIn({ ...base, longWork: reportsNone }).kind).toBe("interrupt_now");
  });
});
