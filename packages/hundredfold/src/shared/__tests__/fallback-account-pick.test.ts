import { beforeEach, describe, expect, it } from "vitest";
import { ENGINE_HEALTH_REFRESH_INTERVAL_MS } from "../engine-health-interval.js";
import { ACCOUNT_READING_FRESH_MS, pickGroupAccount, rankGroupAccounts, recordAccountStart, resetAccountCredits, type GroupCandidate } from "../fallback-account-pick.js";
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

beforeEach(resetAccountCredits);

const rank = (candidates: GroupCandidate[], options: { model?: string | null } = {}) =>
  rankGroupAccounts(candidates, { now, model: options.model });

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

describe("ties in the ranking", () => {
  const equal = (name: string): GroupCandidate => account(name, sample(MIN, [["5h", 40]]));

  it("fall to the order written", () => {
    expect(order([equal("a"), equal("b"), equal("c")])).toEqual(["a", "b", "c"]);
    expect(order([equal("c"), equal("b"), equal("a")])).toEqual(["c", "b", "a"]);
  });

  it("compare headroom in whole percent", () => {
    const a = account("a", sample(MIN, [["5h", 40.9]]));
    const b = account("b", sample(MIN, [["5h", 40.1]]));
    // 40.9 used leaves 59.1 and 40.1 used leaves 59.9: both are 59 in whole percent, so the written order decides.
    expect(rank([a, b]).map((r) => r.headroomPercent)).toEqual([59, 59]);
    expect(order([b, a])).toEqual(["b", "a"]);
  });
});

describe("weights", () => {
  it("are the headroom of a fresh reading and half the headroom of a stale one", () => {
    const ranked = rank([account("fresh", sample(MIN, [["5h", 40]])), account("stale", sample(HOUR, [["5h", 40]])), account("other", sample(MIN, [["5h", 90]]))]);
    expect(Object.fromEntries(ranked.map((r) => [r.account, r.weight]))).toEqual({ fresh: 60, stale: 30, other: 10 });
  });

  it("are 0 for an account at its limit and for one with no headroom, however fresh its reading", () => {
    const ranked = rank([account("full", sample(MIN, [["5h", 100]])), account("out", sample(MIN, [["5h", 10]]), { exhausted: true }), account("ok", sample(MIN, [["5h", 50]]))]);
    expect(Object.fromEntries(ranked.map((r) => [r.account, r.weight]))).toEqual({ ok: 50, full: 0, out: 0 });
  });

  it("give an account with no reading nothing while another account has one, and 1 each when none has", () => {
    expect(rank([account("known", sample(MIN, [["5h", 50]])), account("blind")]).map((r) => [r.account, r.weight])).toEqual([["known", 50], ["blind", 0]]);
    expect(rank([account("a"), account("b")]).map((r) => r.weight)).toEqual([1, 1]);
    // An exhausted account's reading does not count as "another has one".
    expect(rank([account("out", sample(MIN, [["5h", 10]]), { exhausted: true }), account("blind")]).map((r) => [r.account, r.weight])).toEqual([["blind", 1], ["out", 0]]);
  });

  it("report each share as the weight over the sum, in whole percent", () => {
    const ranked = rank([account("a", sample(MIN, [["5h", 40]])), account("b", sample(MIN, [["5h", 60]])), account("c", sample(MIN, [["5h", 100]]))]);
    expect(ranked.map((r) => [r.account, r.sharePercent])).toEqual([["a", 60], ["b", 40], ["c", 0]]);
    expect(rank([account("x", sample(MIN, [["5h", 100]]))])[0]!.sharePercent).toBe(0);
  });
});

describe("pickGroupAccount", () => {
  const ctx = { now, trigger: "start" as const, source: "employee" as const, groupIndex: 0 };
  const share = (headroom: number[]): GroupCandidate[] => headroom.map((left, at) => account(`a${at}`, sample(MIN, [["5h", 100 - left]])));

  /** Picks `count` times, charging each start as a real one, and counts where they went. */
  function run(candidates: GroupCandidate[], count: number): Record<string, number> {
    const counts: Record<string, number> = {};
    for (let i = 0; i < count; i++) {
      const pick = pickGroupAccount(candidates, ctx)!;
      recordAccountStart(pick);
      counts[pick.picked] = (counts[pick.picked] ?? 0) + 1;
    }
    return counts;
  }

  it("splits 100 starts exactly as the headroom: 60/40, 90/10 and 50/50", () => {
    expect(run(share([60, 40]), 100)).toEqual({ a0: 60, a1: 40 });
    resetAccountCredits();
    expect(run(share([90, 10]), 100)).toEqual({ a0: 90, a1: 10 });
    resetAccountCredits();
    expect(run(share([50, 50]), 100)).toEqual({ a0: 50, a1: 50 });
  });

  it("alternates in the smooth order rather than sending a run to one account", () => {
    const picked: string[] = [];
    for (let i = 0; i < 10; i++) {
      const pick = pickGroupAccount(share([60, 40]), ctx)!;
      recordAccountStart(pick);
      picked.push(pick.picked);
    }
    // The standard smooth weighted round-robin sequence for weights 3:2, repeated: no run of more than two for one account.
    expect(picked.join(" ")).toBe("a0 a1 a0 a1 a0 a0 a1 a0 a1 a0");
  });

  it("splits a burst of 10 at equal headroom 5/5, and a burst of 10 over three accounts 4/3/3 by written order", () => {
    expect(run(share([50, 50]), 10)).toEqual({ a0: 5, a1: 5 });
    resetAccountCredits();
    expect(run(share([30, 30, 30]), 10)).toEqual({ a0: 4, a1: 3, a2: 3 });
  });

  it("gives an exhausted account none, and an account with headroom its share", () => {
    const candidates = [...share([70, 30]), account("out", sample(MIN, [["5h", 0]]), { exhausted: true })];
    expect(run(candidates, 100)).toEqual({ a0: 70, a1: 30 });
  });

  it("charges nothing until a start is recorded: a pick, a preview and a validation are the same pick", () => {
    const candidates = share([60, 40]);
    const first = pickGroupAccount(candidates, ctx)!;
    for (let i = 0; i < 5; i++) expect(pickGroupAccount(candidates, ctx)).toEqual(first);
    recordAccountStart(first);
    expect(pickGroupAccount(candidates, ctx)!.picked).toBe("a1");
  });

  it("keeps a credit table per set of accounts, so another group is not charged", () => {
    run(share([60, 40]), 7);
    const other = [account("x", sample(MIN, [["5h", 40]])), account("y", sample(MIN, [["5h", 40]]))];
    expect(pickGroupAccount(other, ctx)!.picked).toBe("x");
    // The same accounts in another written order are the same set and share its credits.
    const reordered = share([60, 40]).reverse();
    const forward = pickGroupAccount(share([60, 40]), ctx)!.picked;
    expect(pickGroupAccount(reordered, ctx)!.picked).toBe(forward);
  });

  it("follows a change of headroom between starts instead of replaying the old split", () => {
    expect(run(share([50, 50]), 10)).toEqual({ a0: 5, a1: 5 });
    const shifted = share([90, 10]);
    const next = run(shifted, 100);
    expect(next.a0! + next.a1!).toBe(100);
    expect(next.a0).toBeGreaterThanOrEqual(89);
    expect(next.a0).toBeLessThanOrEqual(91);
  });

  it("records the pick with the weights, shares and ranking at the time", () => {
    const pick = pickGroupAccount([account("a", sample(MIN, [["5h", 70]])), account("b", sample(MIN, [["5h", 20]]))], ctx)!;
    expect(pick).toMatchObject({ at: now.toISOString(), trigger: "start", source: "employee", groupIndex: 0, reason: "weighted" });
    expect(pick.candidates.map((c) => [c.account, c.weight, c.sharePercent])).toEqual([["b", 80, 73], ["a", 30, 27]]);
  });

  it("says only-candidate for a single account, and no-readings when nothing can be read", () => {
    expect(pickGroupAccount([account("a", sample(MIN, [["5h", 5]]))], ctx)).toMatchObject({ picked: "a", reason: "only-candidate" });
    expect(pickGroupAccount([account("a"), account("b")], ctx)).toMatchObject({ picked: "a", reason: "no-readings" });
    resetAccountCredits();
    expect(run([account("a"), account("b")], 10)).toEqual({ a: 5, b: 5 });
  });

  it("says all-exhausted when every weight is 0, and picks the account that reopens first", () => {
    const pick = pickGroupAccount([
      account("a", undefined, { exhausted: true, reopensAt: now.getTime() + 4 * HOUR }),
      account("b", undefined, { exhausted: true, reopensAt: now.getTime() + HOUR }),
    ], { ...ctx, trigger: "switch", source: "engine", groupIndex: 2 })!;
    expect(pick).toMatchObject({ picked: "b", reason: "all-exhausted", trigger: "switch", source: "engine", groupIndex: 2 });
    // Accounts that are readable but have no headroom left are also all-zero.
    expect(pickGroupAccount([account("full", sample(MIN, [["5h", 100]])), account("out", undefined, { exhausted: true })], ctx)).toMatchObject({ picked: "full", reason: "all-exhausted" });
    // Charging an all-zero pick changes nothing.
    recordAccountStart(pick);
    expect(pickGroupAccount([account("a", sample(MIN, [["5h", 50]])), account("b", sample(MIN, [["5h", 50]]))], ctx)!.picked).toBe("a");
  });

  it("is deterministic for a given state", () => {
    const candidates = [account("a", sample(MIN, [["5h", 30]])), account("b", sample(MIN, [["5h", 30]])), account("c")];
    expect(pickGroupAccount(candidates, ctx)).toEqual(pickGroupAccount([...candidates], ctx));
  });

  it("has nothing to pick for a group with no candidate", () => {
    expect(pickGroupAccount([], ctx)).toBeUndefined();
  });
});
