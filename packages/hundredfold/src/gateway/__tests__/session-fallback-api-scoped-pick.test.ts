import { describe, expect, it } from "vitest";
import type { AccountPick, ResolvedFallbackLink } from "../../shared/fallback-chain-wire.js";
import type { SessionFallbackView } from "../../shared/session-fallback-config.js";
import { withoutUsage } from "../session-fallback-api.js";

/** What a department-scoped caller is shown of a balanced session: the pick and the group's state, never the usage numbers behind them. */

const headroom = { account: "claude:a", label: "claude · a", state: "fresh" as const, headroomPercent: 40, tightest: { window: "5h", usedPercent: 60, resetsAt: "2026-11-20T15:00:00.000Z" }, readingAt: "2026-11-20T11:59:00.000Z", weight: 40, sharePercent: 60 };
const pick: AccountPick = { at: "2026-11-20T12:00:00.000Z", trigger: "start", source: "engine", groupIndex: 0, picked: "claude:a", reason: "weighted", candidates: [headroom, { ...headroom, account: "claude" }] };
const written = { group: [{ engine: "claude" }, { engine: "claude", profile: "a" }] };

function link(extra: Partial<ResolvedFallbackLink>): ResolvedFallbackLink {
  return { engine: "claude", key: "claude|a|opus", account: "claude:a", label: "claude · a", origin: "config", ...extra };
}

function view(links: ResolvedFallbackLink[], withPick = true): SessionFallbackView {
  return {
    mode: "fallback", modeSource: "default", target: null, targetSource: "config", allowedEngines: ["claude"],
    chain: { source: "engine", links, position: 0, servedBy: null, next: null, hops: [], ...(withPick ? { pick } : {}) },
  } as SessionFallbackView;
}

describe("withoutUsage", () => {
  it("strips the headroom numbers from the pick's candidates and keeps its reason, choice, weights and shares", () => {
    const { pick: shown } = withoutUsage(view([link({})])).chain;
    expect(shown).toMatchObject({ picked: "claude:a", reason: "weighted", trigger: "start", source: "engine", groupIndex: 0 });
    for (const candidate of shown!.candidates) {
      expect(Object.keys(candidate).sort()).toEqual(["account", "label", "sharePercent", "state", "weight"]);
    }
    expect(shown!.candidates[0]).toMatchObject({ state: "fresh", weight: 40, sharePercent: 60 });
  });

  it("strips the group member's ranking numbers and the link's usedPercent and window, keeping state, reset and the group", () => {
    const [shown] = withoutUsage(view([link({ health: { state: "ok", until: "2026-11-20T15:00:00.000Z", usedPercent: 60, window: "5h" }, group: { index: 0, written, headroom } })])).chain.links;
    expect(shown!.health).toEqual({ state: "ok", until: "2026-11-20T15:00:00.000Z" });
    expect(shown!.group).toEqual({ index: 0, written, headroom: { account: "claude:a", label: "claude · a", state: "fresh", weight: 40, sharePercent: 60 } });
  });

  it("leaves a view with no pick and links with no group or health as they are", () => {
    const plain = view([link({})], false);
    expect(withoutUsage(plain).chain).toEqual(plain.chain);
    expect(withoutUsage(plain).chain).not.toHaveProperty("pick");
    expect(withoutUsage(plain).chain.links[0]).not.toHaveProperty("health");
  });

  it("does not alter the view it is given", () => {
    const original = view([link({ group: { index: 0, written, headroom } })]);
    const snapshot = JSON.stringify(original);
    withoutUsage(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
