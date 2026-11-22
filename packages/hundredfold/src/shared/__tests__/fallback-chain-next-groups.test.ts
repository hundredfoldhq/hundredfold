import { describe, expect, it } from "vitest";
import { effectivePosition, linksLeftOver, nextFallbackLink } from "../fallback-chain-next.js";
import type { FallbackGroupEntry, ResolvedFallbackLink } from "../fallback-chain-wire.js";

/** Walking a chain that holds a balanced group: the group's members are a set, whatever order a resolution put them in. */

const now = new Date("2026-11-20T12:00:00.000Z");
const WRITTEN: FallbackGroupEntry = { group: [{ engine: "claude" }, { engine: "claude", profile: "a" }, { engine: "claude", profile: "b" }, { engine: "claude", profile: "c" }] };
const OTHER: FallbackGroupEntry = { group: [{ engine: "claude", profile: "x" }, { engine: "claude", profile: "y" }] };

function plain(name: string, extra: Partial<ResolvedFallbackLink> = {}): ResolvedFallbackLink {
  return { engine: name, key: `${name}||`, account: name, label: name, origin: "config", ...extra };
}

function member(name: string, written: FallbackGroupEntry = WRITTEN, index = 0, extra: Partial<ResolvedFallbackLink> = {}): ResolvedFallbackLink {
  return { engine: "claude", profile: name, key: `claude|${name}|`, account: `claude:${name}`, label: name, origin: "config", group: { index, written }, ...extra };
}

const own = plain("claude");
const next = (links: ResolvedFallbackLink[], position: number, tried: string[], health = {}) => nextFallbackLink(links, { position, tried: [own.key, ...tried] }, health, now);
const nextKey = (links: ResolvedFallbackLink[], position: number, tried: string[], health = {}) => next(links, position, tried, health)?.link.key;

describe("a group block is a set", () => {
  it("walks the members in the resolved order and then moves past the block", () => {
    const links = [own, member("b"), member("c"), member("a"), plain("codex")];
    expect(nextKey(links, 0, [])).toBe("claude|b|");
    expect(nextKey(links, 1, ["claude|b|"])).toBe("claude|c|");
    expect(nextKey(links, 2, ["claude|b|", "claude|c|"])).toBe("claude|a|");
    expect(nextKey(links, 3, ["claude|b|", "claude|c|", "claude|a|"])).toBe("codex||");
  });

  it("takes a member that a re-ordering put behind the cursor, instead of skipping it", () => {
    // The run is on c (tried: b, c). A later resolution ranks a first: the walk is on c at index 3, a sits at index 1.
    const links = [own, member("a"), member("b"), member("c"), plain("codex")];
    const result = next(links, 3, ["claude|b|", "claude|c|"]);
    expect(result).toMatchObject({ index: 1, link: { key: "claude|a|" } });
  });

  it("does not revisit a member that was tried before a re-ordering", () => {
    // Tried b and c; the cursor recorded index 1 (then b), but the new order has b at 3: nothing tried is offered again.
    const links = [own, member("a"), member("c"), member("b"), plain("codex")];
    expect(nextKey(links, 1, ["claude|b|", "claude|c|"])).toBe("claude|a|");
    expect(nextKey(links, 1, ["claude|a|", "claude|b|", "claude|c|"])).toBe("codex||");
  });

  it("considers every member before a plain link that sits between them and the cursor", () => {
    // A plain link written after the group but ranked into the cursor's way cannot jump the block.
    const links = [own, member("a"), plain("codex"), member("b")];
    expect(nextKey(links, 1, ["claude|a|"])).toBe("claude|b|");
  });

  it("takes the next untried block's members as a set as soon as the walk reaches its first member", () => {
    const links = [own, plain("codex"), member("x", OTHER, 1), member("y", OTHER, 1)];
    expect(nextKey(links, 0, [])).toBe("codex||");
    // Reaching the block, every member counts, whichever side of the cursor it is on.
    const reordered = [own, member("y", OTHER, 1), plain("codex"), member("x", OTHER, 1)];
    expect(nextKey(reordered, 2, ["codex||"])).toBe("claude|y|");
  });

  it("keeps two groups apart", () => {
    const links = [own, member("a"), member("x", OTHER, 1), member("b"), member("y", OTHER, 1)];
    // The first group is walked whole before the second, since the walk met it first.
    expect(nextKey(links, 0, [])).toBe("claude|a|");
    expect(nextKey(links, 1, ["claude|a|"])).toBe("claude|b|");
    expect(nextKey(links, 3, ["claude|a|", "claude|b|"])).toBe("claude|x|");
  });

  it("passes over a member ruled out or spent, with the reason, and still takes the others", () => {
    const links = [own, member("a", WRITTEN, 0, { skip: "profile-unknown" }), member("b"), member("c")];
    const spent = { "claude:b": { state: "exhausted" as const, until: new Date(now.getTime() + 3600_000).toISOString() } };
    expect(next(links, 0, [], spent)).toMatchObject({ link: { key: "claude|c|" }, skipped: [{ key: "claude|a|", reason: "profile-unknown" }, { key: "claude|b|", reason: "exhausted" }] });
    // Nothing healthy left: the second pass takes the spent member before leaving the block.
    expect(nextKey([own, member("b"), plain("codex")], 0, [], spent)).toBe("codex||");
    expect(nextKey([own, member("b")], 0, [], spent)).toBe("claude|b|");
  });

  it("still comes back to a link behind the cursor that was passed over for its health", () => {
    const links = [own, plain("codex"), member("a"), member("b")];
    const spent = { codex: { state: "exhausted" as const, until: new Date(now.getTime() + 3600_000).toISOString() } };
    // codex was passed over for its limit; the group is done; the run is not out while codex is untried.
    expect(nextKey(links, 3, ["claude|a|", "claude|b|"], spent)).toBe("codex||");
  });

  it("finds nothing when every member and link is tried, and leftovers name every link after the cursor", () => {
    const links = [own, member("a"), member("b")];
    expect(next(links, 2, ["claude|a|", "claude|b|"])).toBeUndefined();
    expect(linksLeftOver(links, { position: 2, tried: [own.key, "claude|a|", "claude|b|"] }, {}, now)).toEqual([{ key: "claude|a|", reason: "tried" }]);
  });

  it("walks a chain with no group exactly as before", () => {
    const links = [own, plain("codex"), plain("grok"), plain("pi")];
    expect(nextKey(links, 0, [])).toBe("codex||");
    expect(next(links, 1, ["codex||", "grok||"])).toMatchObject({ index: 3, skipped: [{ key: "grok||", reason: "tried" }] });
  });
});

describe("effectivePosition with a group", () => {
  it("is the recorded position while it points at a tried member, else past the furthest tried one", () => {
    const links = [own, member("a"), member("b"), member("c")];
    expect(effectivePosition(links, { position: 2, tried: [own.key, "claude|b|"] })).toBe(2);
    // A re-ordering moved b from index 2 to 3: the cursor goes with it.
    const moved = [own, member("a"), member("c"), member("b")];
    expect(effectivePosition(moved, { position: 2, tried: [own.key, "claude|b|"] })).toBe(3);
  });
});
