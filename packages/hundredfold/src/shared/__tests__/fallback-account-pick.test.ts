import { describe, expect, it } from "vitest";
import { ENGINE_HEALTH_REFRESH_INTERVAL_MS } from "../engine-health-interval.js";
import { ACCOUNT_READING_FRESH_MS, pickGroupAccount, rankGroupAccounts, type GroupCandidate } from "../fallback-account-pick.js";
import type { UsageSample } from "../claude-usage-history.js";

/** The balancer: headroom from the tightest applicable window, tiers, tie-breaks, and the pick's reason. */

const now = new Date("2026-11-20T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const secs = (ms: number): number => Math.floor(ms / 1000);

type Win = [name: string, usedPercent: number, resetsInMs?: number];

function sample(ageMs: number, windows: Win[]): UsageSample {
  return { at: now.getTime() - ageMs, windows: windows.map(([name, usedPercent, resetsIn = 3 * HOUR]) => ({ name, usedPercent, resetsAt: secs(now.getTime() + resetsIn) })) };
}

function account(name: string, reading?: UsageSample, extra: Partial<GroupCandidate> = {}): GroupCandidate {
  return { account: name, label: name, exhausted: false, ...(reading ? { reading } : {}), ...extra };
}

const rank = (candidates: GroupCandidate[], options: { model?: string | null; active?: Record<string, number> } = {}) =>
  rankGroupAccounts(candidates, { now, model: options.model, activeSessions: (a) => options.active?.[a] ?? 0 });

const order = (candidates: GroupCandidate[], options?: Parameters<typeof rank>[1]): string[] => rank(candidates, options).map((r) => r.account);

describe("freshness", () => {
  it("is twice the engine-health refresh interval", () => {
    expect(ACCOUNT_READING_FRESH_MS).toBe(2 * ENGINE_HEALTH_REFRESH_INTERVAL_MS);
    expect(ACCOUNT_READING_FRESH_MS).toBe(30 * MIN);
  });

  it("calls a sample fresh at the limit, stale beyond it and unknown when there is none", () => {
    const states = rank([
      account("edge", sample(30 * MIN, [["5h", 10]])),
      account("old", sample(30 * MIN + 1, [["5h", 10]])),
      account("none"),
    ]).map((r) => [r.account, r.state]);
    expect(states).toEqual([["edge", "fresh"], ["old", "stale"], ["none", "unknown"]]);
  });
});

describe("headroom", () => {
  it("is 100 minus the tightest window, in whole percent (floor)", () => {
    const [a] = rank([account("a", sample(MIN, [["5h", 20], ["7d", 61.4]]))]);
    expect(a).toMatchObject({ headroomPercent: 38, tightest: { window: "7d", usedPercent: 61.4 } });
    expect(a!.tightest!.resetsAt).toBe(new Date(now.getTime() + 3 * HOUR).toISOString());
    expect(a!.readingAt).toBe(new Date(now.getTime() - MIN).toISOString());
  });

  it("counts a window that has already reset as unused", () => {
    const [a] = rank([account("a", sample(MIN, [["5h", 95, -MIN], ["7d", 30]]))]);
    expect(a).toMatchObject({ headroomPercent: 70, tightest: { window: "7d" } });
    const [b] = rank([account("b", sample(MIN, [["5h", 95, -MIN]]))]);
    expect(b).toMatchObject({ headroomPercent: 100 });
    expect(b!.tightest).toBeUndefined();
  });

  it("lets the tightest window decide the order between accounts", () => {
    expect(order([
      account("short-tight", sample(MIN, [["5h", 90], ["7d", 10]])),
      account("long-tight", sample(MIN, [["5h", 10], ["7d", 60]])),
    ])).toEqual(["long-tight", "short-tight"]);
  });

  it("applies a 7d <model> window only to that model's family, and every window when the model is unknown", () => {
    const opusHeavy = account("opus-heavy", sample(MIN, [["5h", 10], ["7d", 20], ["7d Opus", 95]]));
    const other = account("other", sample(MIN, [["5h", 10], ["7d", 50]]));
    expect(order([opusHeavy, other], { model: "opus" })).toEqual(["other", "opus-heavy"]);
    expect(order([opusHeavy, other], { model: "claude-opus-4-1" })).toEqual(["other", "opus-heavy"]);
    expect(order([opusHeavy, other], { model: "claude-sonnet-4-5" })).toEqual(["opus-heavy", "other"]);
    expect(order([opusHeavy, other])).toEqual(["other", "opus-heavy"]);
    expect(order([opusHeavy, other], { model: "" })).toEqual(["other", "opus-heavy"]);
    expect(rank([opusHeavy], { model: "sonnet" })[0]!.tightest?.window).toBe("7d");
  });

  it("matches the family word case-insensitively and keeps 7d and 5h always applicable", () => {
    const a = account("a", sample(MIN, [["7d OPUS", 90]]));
    expect(rank([a], { model: "Opus" })[0]!.headroomPercent).toBe(10);
    expect(rank([account("b", sample(MIN, [["7d", 90]]))], { model: "sonnet" })[0]!.headroomPercent).toBe(10);
  });
});

describe("tiers", () => {
  it("ranks fresh before stale before unknown before exhausted, whatever the headroom", () => {
    expect(order([
      account("exhausted", sample(MIN, [["5h", 0]]), { exhausted: true }),
      account("unknown"),
      account("stale", sample(HOUR, [["5h", 80]])),
      account("fresh", sample(MIN, [["5h", 90]])),
    ])).toEqual(["fresh", "stale", "unknown", "exhausted"]);
  });

  it("reads an exhausted account's reading too, and orders the exhausted by the earliest reopening", () => {
    const ranked = rank([
      account("late", sample(MIN, [["5h", 100]]), { exhausted: true, reopensAt: now.getTime() + 5 * HOUR }),
      account("unstated", undefined, { exhausted: true }),
      account("soon", sample(MIN, [["5h", 100]]), { exhausted: true, reopensAt: now.getTime() + HOUR }),
    ]);
    expect(ranked.map((r) => r.account)).toEqual(["soon", "late", "unstated"]);
    expect(ranked.every((r) => r.state === "exhausted")).toBe(true);
    expect(ranked[0]).toMatchObject({ headroomPercent: 0 });
  });

  it("an account that cannot be read is never preferred over one that can, even a nearly full one", () => {
    expect(order([account("unknown"), account("nearly-full", sample(MIN, [["5h", 99]]))])).toEqual(["nearly-full", "unknown"]);
  });
});

describe("ties", () => {
  const equal = (name: string): GroupCandidate => account(name, sample(MIN, [["5h", 40]]));

  it("fall to the fewest active sessions, then to the written order", () => {
    expect(order([equal("a"), equal("b"), equal("c")], { active: { a: 2, b: 0, c: 1 } })).toEqual(["b", "c", "a"]);
    expect(order([equal("a"), equal("b"), equal("c")], { active: { a: 1, b: 1, c: 1 } })).toEqual(["a", "b", "c"]);
    expect(order([equal("c"), equal("b"), equal("a")])).toEqual(["c", "b", "a"]);
  });

  it("compare headroom in whole percent before looking at sessions", () => {
    const a = account("a", sample(MIN, [["5h", 40.9]]));
    const b = account("b", sample(MIN, [["5h", 40.1]]));
    // 40.9 used leaves 59.1 and 40.1 used leaves 59.9: both are 59 in whole percent, so sessions decide.
    expect(rank([a, b]).map((r) => r.headroomPercent)).toEqual([59, 59]);
    expect(order([a, b], { active: { a: 1 } })).toEqual(["b", "a"]);
  });

  it("do not let sessions outweigh headroom", () => {
    expect(order([account("busy", sample(MIN, [["5h", 10]])), account("idle", sample(MIN, [["5h", 50]]))], { active: { busy: 9 } })).toEqual(["busy", "idle"]);
  });

  it("records the active session count on each candidate", () => {
    expect(rank([equal("a")], { active: { a: 3 } })[0]!.activeSessions).toBe(3);
    expect(rank([equal("a")])[0]!.activeSessions).toBe(0);
  });
});

describe("pickGroupAccount", () => {
  const ctx = { now, trigger: "start" as const, source: "employee" as const, groupIndex: 0 };

  it("picks the most headroom and says so, with the ranking", () => {
    const pick = pickGroupAccount([account("a", sample(MIN, [["5h", 70]])), account("b", sample(MIN, [["5h", 20]]))], ctx)!;
    expect(pick).toMatchObject({ at: now.toISOString(), trigger: "start", source: "employee", groupIndex: 0, picked: "b", reason: "most-headroom" });
    expect(pick.candidates.map((c) => c.account)).toEqual(["b", "a"]);
  });

  it("says tie when headroom is equal and sessions or order decided it", () => {
    const equal = (name: string) => account(name, sample(MIN, [["5h", 40]]));
    expect(pickGroupAccount([equal("a"), equal("b")], { ...ctx, activeSessions: (a) => (a === "a" ? 1 : 0) })).toMatchObject({ picked: "b", reason: "tie" });
  });

  it("says only-candidate for a single account, and no-readings when nothing can be read", () => {
    expect(pickGroupAccount([account("a", sample(MIN, [["5h", 5]]))], ctx)).toMatchObject({ picked: "a", reason: "only-candidate" });
    expect(pickGroupAccount([account("a"), account("b")], ctx)).toMatchObject({ picked: "a", reason: "no-readings" });
  });

  it("says all-exhausted and picks the account that reopens first", () => {
    const pick = pickGroupAccount([
      account("a", undefined, { exhausted: true, reopensAt: now.getTime() + 4 * HOUR }),
      account("b", undefined, { exhausted: true, reopensAt: now.getTime() + HOUR }),
    ], { ...ctx, trigger: "switch", source: "engine", groupIndex: 2 })!;
    expect(pick).toMatchObject({ picked: "b", reason: "all-exhausted", trigger: "switch", source: "engine", groupIndex: 2 });
  });

  it("is deterministic for a given state", () => {
    const candidates = [account("a", sample(MIN, [["5h", 30]])), account("b", sample(MIN, [["5h", 30]])), account("c")];
    expect(pickGroupAccount(candidates, ctx)).toEqual(pickGroupAccount([...candidates], ctx));
  });

  it("has nothing to pick for a group with no candidate", () => {
    expect(pickGroupAccount([], ctx)).toBeUndefined();
  });
});
