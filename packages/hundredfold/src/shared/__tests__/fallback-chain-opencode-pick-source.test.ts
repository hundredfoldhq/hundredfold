import { beforeEach, describe, expect, it } from "vitest";
import { resetAccountCredits } from "../fallback-account-pick.js";
import { sessionFallbackChain } from "../fallback-chain.js";
import type { AccountPick, FallbackChainEntry } from "../fallback-chain-wire.js";
import type { Employee, HundredfoldConfig, JsonObject, ModelRegistry } from "../types.js";
import { makeSession } from "../../sessions/__tests__/helpers/session-fixture.js";

/** A pinned opencode session keeps the chain its group came from, read for its own engine. */

const now = new Date("2026-11-20T12:00:00.000Z");
const GROUP = { group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }] };
const TAIL = { engine: "claude" };
const OWN_CHAIN = [{ engine: "claude" }, { engine: "codex" }];

function config(fallback: FallbackChainEntry[] = [GROUP, TAIL]): HundredfoldConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt" },
      opencode: {
        bin: "opencode", model: "opencode-go/glm-5", fallback,
        accounts: { "go-a": { provider: "opencode-go" }, "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY" } },
      },
    },
  } as unknown as HundredfoldConfig;
}

function entry(name: string, ids: string[]): ModelRegistry[string] {
  return { name, available: true, defaultModel: ids[0] ?? "", effortMechanism: "none" as const, models: ids.map((id) => ({ id, label: id, supportsEffort: false, effortLevels: [] })) };
}
const registry = {
  claude: entry("claude", ["opus"]),
  codex: entry("codex", ["gpt"]),
  opencode: entry("opencode", ["opencode-go/glm-5", "opencode-go-b/glm-5"]),
} as unknown as ModelRegistry;

function pick(source: AccountPick["source"], picked: string): JsonObject {
  const record: AccountPick = {
    at: now.toISOString(), trigger: "start", source, groupIndex: 0, picked, reason: "weighted",
    candidates: [{ account: picked, label: picked, state: "fresh", headroomPercent: 30, tightest: { window: "5h", usedPercent: 70, resetsAt: "2026-11-20T15:00:00.000Z" }, readingAt: "2026-11-20T11:59:00.000Z", weight: 30, sharePercent: 100 }],
  };
  return record as unknown as JsonObject;
}

const worker = (fallback?: FallbackChainEntry[], engine = "opencode", model = "opencode-go/glm-5"): Employee =>
  ({ name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine, model, persona: "p", ...(fallback ? { fallback: fallback as Employee["fallback"] } : {}) });

function resolve(options: { config?: HundredfoldConfig; employee?: Employee; session: Parameters<typeof makeSession>[0] }) {
  return sessionFallbackChain({ config: options.config ?? config(), registry, health: {}, limits: {}, now, employee: options.employee, session: makeSession(options.session) });
}
const keys = (links: Array<{ key: string }>): string[] => links.map((link) => link.key);

beforeEach(resetAccountCredits);

describe("an opencode session keeps the chain its pick came from", () => {
  it("resolves from the engine chain once the employee gains a chain of its own", () => {
    const session = { engine: "opencode", model: "opencode-go-b/glm-5", employee: "dev", transportMeta: { accountPick: pick("engine", "opencode/opencode-go-b") } };
    const kept = resolve({ session, employee: worker(OWN_CHAIN as FallbackChainEntry[]) });
    expect(kept.source).toBe("engine");
    // The group's original member is a fallback of the pinned session, and the engine's tail follows.
    expect(keys(kept.links)).toEqual(["opencode||opencode-go-b/glm-5", "opencode||opencode-go/glm-5", "claude||"]);
    // The same session with no pick takes the employee's chain, so the read is what holds it on the engine's.
    const unpinned = resolve({ session: { ...session, transportMeta: {} }, employee: worker(OWN_CHAIN as FallbackChainEntry[]) });
    expect(unpinned.source).toBe("employee");
    expect(keys(unpinned.links)).toEqual(["opencode||opencode-go-b/glm-5", "claude||", "codex||"]);
  });

  it("resolves from the employee chain when the pick names it", () => {
    const own = [GROUP, { engine: "codex" }] as FallbackChainEntry[];
    const { source, links } = resolve({
      session: { engine: "opencode", model: "opencode-go-b/glm-5", employee: "dev", transportMeta: { accountPick: pick("employee", "opencode/opencode-go-b") } },
      employee: worker(own),
    });
    expect(source).toBe("employee");
    expect(keys(links)).toEqual(["opencode||opencode-go-b/glm-5", "opencode||opencode-go/glm-5", "codex||"]);
  });

  it("does not read an opencode pick left on a Claude session", () => {
    const session = { engine: "claude", model: "opus", employee: "dev", transportMeta: { accountPick: pick("engine", "opencode/opencode-go-b") } };
    const employee = worker(OWN_CHAIN as FallbackChainEntry[], "claude", "opus");
    const withRecord = resolve({ session, employee });
    const without = resolve({ session: { ...session, transportMeta: {} }, employee });
    expect(withRecord.source).toBe("employee");
    expect(keys(withRecord.links)).toEqual(keys(without.links));
  });

  it("does not read a Claude account's pick left on an opencode session", () => {
    const session = { engine: "opencode", model: "opencode-go-b/glm-5", employee: "dev", transportMeta: { accountPick: pick("engine", "claude:other") } };
    const { source } = resolve({ session, employee: worker(OWN_CHAIN as FallbackChainEntry[]) });
    expect(source).toBe("employee");
  });
});
