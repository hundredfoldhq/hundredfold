import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneSink, OpencodeCloneModel } from "../../shared/opencode-clone.js";
import type { ModelInfo, HundredfoldConfig, EngineRunOpts } from "../../shared/types.js";

/**
 * A fresh gateway's first turn on a declared account's model (docs/design/opencode-accounts.md, "Staging").
 *
 * An account's provider block is cloned from its base's catalogue records, which only a detailed model discovery
 * brings, and the gateway serves turns before its first discovery has landed. A turn staged in that window had a block
 * with no models, opencode refused it as `provider.no-route`, and the fallback walk held the model as one the account
 * cannot use. Here discovery is held open (the real catalogue, with `discoverOpencodeModels` answering only when told)
 * while a real turn starts against the fake opencode, which records the config it was handed.
 */

const SENTINEL = "sentinel-key-cold-0123456789abcdef";
const URL = "https://capture.example.test/v1";
const BASE_MODELS: OpencodeCloneModel[] = [
  { id: "alpha", name: "Alpha", npm: "@opencode/ai/providers/openai-compatible", endpoint: URL },
  { id: "gamma", name: "Gamma", npm: "@opencode/ai/providers/openai-compatible", endpoint: URL },
];
const CATALOGUE: ModelInfo[] = BASE_MODELS.map((m) => ({ id: `base-go/${m.id}`, label: m.name!, supportsEffort: false, effortLevels: [] }));

/** One held discovery per refresh, answered by the test: with the base's records, or with nothing. */
const discovery = vi.hoisted(() => ({
  held: [] as Array<{ answer: (withBase: boolean) => void }>,
}));
vi.mock("../../shared/opencode-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/opencode-discovery.js")>()),
  discoverOpencodeModels: (_bin: string, options: { clones?: CloneSink } = {}) =>
    new Promise((resolve) => {
      discovery.held.push({
        answer: (withBase) => {
          if (withBase && options.clones?.providers.has("base-go")) options.clones.models.set("base-go", BASE_MODELS);
          resolve(withBase ? { models: CATALOGUE, detailed: true } : { models: [], detailed: false });
        },
      });
    }),
}));
vi.mock("../opencode-internal-fallback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../opencode-internal-fallback.js")>()),
  hostHasInternalFallback: () => false,
  fallbackPluginAbortsTurns: () => false,
}));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-opencode.mjs");

function configWith(accounts: Record<string, unknown>): HundredfoldConfig {
  return { gateway: {}, engines: { default: "opencode", opencode: { bin: FAKE, accounts } }, sessions: {} } as unknown as HundredfoldConfig;
}
const CONFIG = configWith({ b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY", label: "Go B" } });
const ENV = { GO_B_KEY: SENTINEL };

/** Every module that holds catalogue state, fresh for each test: the catalogue is module state, and a test must start cold. */
async function cold() {
  vi.resetModules();
  const [engineMod, serverMod, accountsMod, modelsMod, catalogueMod, lifecycleMod, versionMod, pathsMod, failureMod, engineFailureMod, timingMod, servedMod, sharedAccountsMod] = await Promise.all([
    import("../opencode.js"),
    import("../opencode-server.js"),
    import("../opencode-accounts.js"),
    import("../../shared/models.js"),
    import("../../shared/opencode-catalogue.js"),
    import("../pty-lifecycle.js"),
    import("../../shared/opencode-bin-version.js"),
    import("../../shared/paths.js"),
    import("../../shared/opencode-failure.js"),
    import("../../shared/engine-failure.js"),
    import("../opencode-server-turn.js"),
    import("../opencode-model-served.js"),
    import("../../shared/opencode-accounts.js"),
  ]);
  versionMod.clearOpencodeVersionCache();
  timingMod.SERVER_TURN_TIMING.statusPollMs = 30_000;
  timingMod.SERVER_TURN_TIMING.connectMs = 15_000;
  timingMod.SERVER_TURN_TIMING.closeWaitMs = 2_000;
  // The gateway's reader reads the live catalogue on every call (gateway/opencode-account-reach.ts).
  const read = (config: HundredfoldConfig = CONFIG) => () => accountsMod.opencodeAccountStaging(config, ENV);
  return { ...engineMod, ...serverMod, ...accountsMod, ...modelsMod, ...catalogueMod, ...lifecycleMod, ...failureMod, ...engineFailureMod, ...servedMod, ...sharedAccountsMod, HOME: pathsMod.HUNDREDFOLD_HOME, read };
}

let home = "";
const stagedLog = () => path.join(home, "staged-cold-start.log");
const staged = (): Array<{ verb: string; config: Record<string, unknown> | null }> =>
  (fs.existsSync(stagedLog()) ? fs.readFileSync(stagedLog(), "utf8").split("\n").filter(Boolean) : []).map((line) => JSON.parse(line));
const stagedModels = (line: { config: Record<string, unknown> | null } | undefined) =>
  Object.keys((line?.config as { provider?: Record<string, { models: Record<string, unknown> }> } | null)?.provider?.["go-b"]?.models ?? {});

function runOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return { prompt: "hello", cwd: home, sessionId: "sess-cold", bin: FAKE, model: "go-b/alpha", ...over };
}

/** Let the turn get as far as it will without discovery: the version probe and anything else it awaits. */
async function settleABit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/** The held discovery, once the refresh has got as far as asking for it (after its version probe). */
async function heldDiscovery(): Promise<{ answer: (withBase: boolean) => void }> {
  await vi.waitFor(() => expect(discovery.held.length).toBeGreaterThan(0));
  return discovery.held.shift()!;
}

beforeEach(async () => {
  discovery.held = [];
  home = (await import("../../shared/paths.js")).HUNDREDFOLD_HOME;
  fs.rmSync(stagedLog(), { force: true });
  process.env.FAKE_OPENCODE_STAGED_LOG = stagedLog();
  process.env.FAKE_OPENCODE_STAGED_ENV = "GO_B_KEY";
});

afterEach(() => {
  for (const name of ["FAKE_OPENCODE_STAGED_LOG", "FAKE_OPENCODE_STAGED_ENV", "FAKE_OPENCODE_VERSION"]) delete process.env[name];
  fs.rmSync(stagedLog(), { force: true });
});

describe("the first turn on an account model, before the first discovery has landed", { timeout: 30_000 }, () => {
  it("waits for discovery and is staged with the account's models (run mode)", async () => {
    process.env.FAKE_OPENCODE_VERSION = "2.0.32";
    const m = await cold();
    // As the gateway boots: the refresh is begun, and its first await (the version probe) not yet over.
    const refresh = m.refreshOpencodeModels(CONFIG);
    expect(m.opencodeClonesPending("base-go")).toBe(true);
    const engine = new m.OpencodeEngine({ mode: () => "run", accounts: m.read() });
    const turn = engine.run(runOpts({ sessionId: "sess-cold-run" }));
    await settleABit();
    expect(staged()).toEqual([]); // nothing launched on an empty block
    (await heldDiscovery()).answer(true);
    await refresh;
    const result = await turn;
    expect(result.error).toBeUndefined();
    const [seen] = staged();
    expect(seen?.verb).toBe("run");
    expect(stagedModels(seen)).toEqual(["alpha", "gamma"]);
  });

  it("waits for discovery and starts its server with the account's models (server mode)", async () => {
    const m = await cold();
    const read = m.read();
    const pool = new m.OpencodeServerPool(new m.PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false }), { bin: () => FAKE, accounts: read });
    try {
      const refresh = m.refreshOpencodeModels(CONFIG);
      const engine = new m.OpencodeEngine({ mode: () => "server", servers: pool, accounts: read });
      const turn = engine.run(runOpts({ sessionId: "sess-cold-server" }));
      await settleABit();
      expect(staged()).toEqual([]);
      (await heldDiscovery()).answer(true);
      await refresh;
      const result = await turn;
      expect(result.error).toBeUndefined();
      const serves = staged().filter((line) => line.verb === "serve");
      expect(serves).toHaveLength(1);
      expect(stagedModels(serves[0])).toEqual(["alpha", "gamma"]);
    } finally {
      await pool.stopAll();
    }
  });

  it("fails without launching, as model access (hop, hold the model), when discovery has finished without the base", async () => {
    process.env.FAKE_OPENCODE_VERSION = "2.0.32";
    const m = await cold();
    const refresh = m.refreshOpencodeModels(CONFIG);
    const engine = new m.OpencodeEngine({ mode: () => "run", accounts: m.read() });
    const turn = engine.run(runOpts({ sessionId: "sess-cold-none" }));
    (await heldDiscovery()).answer(false);
    await refresh;
    const result = await turn;
    expect(result.error).toBe('go-b/alpha is not served by account "b": model discovery found no models of its base "base-go" on this host');
    expect(result.conversationIntact).toBe(true);
    expect(staged()).toEqual([]);
    // As opencode's own refusal of the empty block was read on main: the walk hops, and only this model is held.
    expect(m.classifyOpencodeFailure(result.error)?.kind).toBe("model-access");
    // And so for every later turn: nothing is pending, so nothing waits.
    expect(m.opencodeClonesPending("base-go")).toBe(false);
    expect((await engine.run(runOpts({ sessionId: "sess-cold-none-2" }))).error).toBe(result.error);
  });

  it("fails without launching, with no failure class (nothing held, no hop), when discovery is still running at the timeout", async () => {
    const m = await cold();
    const refresh = m.refreshOpencodeModels(CONFIG);
    const accounts = m.read()()!;
    expect(accounts.unstaged("go-b/alpha")).toEqual({ account: "b", base: "base-go" });
    const staging = await m.accountsOnceStaged(runOpts(), accounts, m.read(), { timeoutMs: 200 });
    expect(staging).toEqual({ result: { sessionId: "", result: "", error: m.UNLOADED_ACCOUNT_MODELS_ERROR, conversationIntact: true } });
    expect(m.classifyOpencodeFailure(m.UNLOADED_ACCOUNT_MODELS_ERROR)).toBeUndefined();
    expect([...m.classifyEngineFailureText(m.UNLOADED_ACCOUNT_MODELS_ERROR).classes]).toEqual(["terminal"]);
    (await heldDiscovery()).answer(true);
    await refresh;
  });

  it("is stopped by an interrupt during the wait, reported live while it waits, and launches nothing (run mode)", async () => {
    process.env.FAKE_OPENCODE_VERSION = "2.0.32";
    const m = await cold();
    const refresh = m.refreshOpencodeModels(CONFIG);
    const engine = new m.OpencodeEngine({ mode: () => "run", accounts: m.read() });
    const turn = engine.run(runOpts({ sessionId: "sess-cold-kill" }));
    await settleABit();
    expect(engine.isAlive("sess-cold-kill")).toBe(true);
    engine.kill("sess-cold-kill", "Interrupted by the operator");
    const result = await turn;
    expect(result.error).toBe("Interrupted by the operator");
    expect(engine.isAlive("sess-cold-kill")).toBe(false);
    (await heldDiscovery()).answer(true);
    await refresh;
    await settleABit();
    expect(staged()).toEqual([]);
  });

  it("is stopped by an interrupt during the wait, and starts no server (server mode)", async () => {
    const m = await cold();
    const read = m.read();
    const pool = new m.OpencodeServerPool(new m.PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false }), { bin: () => FAKE, accounts: read });
    try {
      const refresh = m.refreshOpencodeModels(CONFIG);
      const engine = new m.OpencodeEngine({ mode: () => "server", servers: pool, accounts: read });
      const turn = engine.run(runOpts({ sessionId: "sess-cold-kill-server" }));
      await settleABit();
      expect(engine.isAlive("sess-cold-kill-server")).toBe(true);
      engine.killAll();
      expect((await turn).error).toBe("Interrupted: gateway shutting down");
      (await heldDiscovery()).answer(true);
      await refresh;
      await settleABit();
      expect(staged()).toEqual([]);
      expect(pool.size()).toBe(0);
    } finally {
      await pool.stopAll();
    }
  });

  it("waits for a reload's refresh that adds a new base, though an earlier discovery has detailed the catalogue", async () => {
    process.env.FAKE_OPENCODE_VERSION = "2.0.32";
    const m = await cold();
    // A gateway already up: its first discovery landed, with no account declared yet.
    const first = m.refreshOpencodeModels(configWith({}));
    (await heldDiscovery()).answer(true);
    await first;
    expect(m.opencodeClonesPending("base-go")).toBe(false);
    // The reload declares the account; its refresh is still running when the turn starts.
    const reload = m.refreshOpencodeModels(CONFIG);
    expect(m.opencodeClonesPending("base-go")).toBe(true);
    const engine = new m.OpencodeEngine({ mode: () => "run", accounts: m.read() });
    const turn = engine.run(runOpts({ sessionId: "sess-cold-reload" }));
    await settleABit();
    expect(staged()).toEqual([]);
    (await heldDiscovery()).answer(true);
    await reload;
    expect((await turn).error).toBeUndefined();
    expect(stagedModels(staged()[0])).toEqual(["alpha", "gamma"]);
  });

  it("starts at once when the account's models are already known", async () => {
    process.env.FAKE_OPENCODE_VERSION = "2.0.32";
    const m = await cold();
    const refresh = m.refreshOpencodeModels(CONFIG);
    (await heldDiscovery()).answer(true);
    await refresh;
    expect(m.opencodeClonesPending("base-go")).toBe(false);
    const engine = new m.OpencodeEngine({ mode: () => "run", accounts: m.read() });
    expect((await engine.run(runOpts({ sessionId: "sess-warm" }))).error).toBeUndefined();
    expect(stagedModels(staged()[0])).toEqual(["alpha", "gamma"]);
  });
});

describe("opencodeClonesSettled", () => {
  it("resolves at once with nothing pending, and after its timeout when discovery never answers", async () => {
    const m = await cold();
    const started = Date.now();
    await m.opencodeClonesSettled("base-go", 5_000); // no refresh: nothing to wait for
    expect(Date.now() - started).toBeLessThan(1_000);
    const refresh = m.refreshOpencodeModels(CONFIG);
    const waited = Date.now();
    await m.opencodeClonesSettled("base-go", 200);
    expect(Date.now() - waited).toBeGreaterThanOrEqual(150);
    expect(m.opencodeClonesPending("base-go")).toBe(true);
    (await heldDiscovery()).answer(true);
    await refresh;
  });
});
