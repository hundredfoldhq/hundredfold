import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A remote session pinned to another account on its host (`transportMeta.remoteAccountPin`) runs as that account everywhere a
 * launch or a reading asks which: the directory every launch is given, the session's own account (and so its thread slot,
 * health and signed-in scope), the swap a walk or a creation reroute makes off it and the return to it. The directory is
 * the standing override's, else the pin's, else the employee's; a pin made on another `user@host` is ignored.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: () => true,
}));
let health: Record<string, { state: "exhausted"; until: string; recheckAt: string }> = {};
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  readEngineHealth: () => health,
}));

import { claudeAuthScope } from "../claude-auth-watch.js";
import { rerouteAtCreation } from "../fallback-reroute.js";
import { pinAccountAtCreation } from "../account-pin.js";
import { launchFor } from "../substitute-launch.js";
import { sessionFallbackChain } from "../../shared/fallback-chain.js";
import { chooseSubstituteOrReason, type ChooseSubstituteInput } from "../rate-limit-substitute.js";
import { rateLimitAccount, substituteHealth } from "../rate-limit-account.js";
import { metaWithRemoteAccountPin, pinIsOnHostOf, readRemoteAccountPin } from "../remote-account-pin.js";
import { ownClaudeAccountOf, sessionRemoteTarget, threadSlot, withStandingRemoteAccount } from "../session-account.js";
import { availabilityRegistry } from "../availability-registry.js";
import { remoteScopeFor } from "../session-cwd.js";
import { registerEmployeeAccountResolver, remoteClaudeAccountKey } from "../../shared/engine-account.js";
import { makeSession } from "./helpers/session-fixture.js";
import type { Employee, HundredfoldConfig } from "../../shared/types.js";

const HOST = { remoteHost: "build-host", remoteUser: "me" };
const HOME_DIR = "/home/me/.claude-own";
const SPARE_DIR = "/home/me/.claude-spare";
const OTHER_DIR = "/home/me/.claude-other";
const OWN_KEY = remoteClaudeAccountKey(HOST, HOME_DIR);
const SPARE_KEY = remoteClaudeAccountKey(HOST, SPARE_DIR);
const OTHER_KEY = remoteClaudeAccountKey(HOST, OTHER_DIR);
const PIN = { account: SPARE_KEY, configDir: SPARE_DIR };

const GROUP = { group: [{ engine: "claude" }, { engine: "claude", profile: "spare" }, { engine: "claude", profile: "other" }] };
const config = {
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", accounts: { spare: { ...HOST, configDir: SPARE_DIR }, other: { ...HOST, configDir: OTHER_DIR } } },
    opencode: { bin: "opencode" },
  },
  remote: { root: "/srv/work", mount: "/mnt/hundredfold" },
} as unknown as HundredfoldConfig;

const employee = (over: Partial<Employee> = {}) => ({
  name: "dev", engine: "claude", model: "opus", ...HOST, remoteCwd: "/srv/work/dev", remoteClaudeConfigDir: HOME_DIR,
  fallback: [GROUP, { engine: "opencode", model: "x/m" }], ...over,
}) as unknown as Employee;
const pinned = (pin: unknown = PIN, over: Record<string, unknown> = {}) => makeSession({ employee: "dev", transportMeta: { remoteAccountPin: pin } as never, ...over });
const target = (who: Employee, session: ReturnType<typeof makeSession>) => sessionRemoteTarget(who, remoteScopeFor(config.remote, session), session);

beforeEach(() => {
  health = {};
  registerEmployeeAccountResolver((name) => (name === "dev" ? OWN_KEY : undefined));
});

describe("the pin record", () => {
  it("is read only when it is well formed, and set, removed or left by the write", () => {
    expect(readRemoteAccountPin({ remoteAccountPin: PIN } as never)).toEqual(PIN);
    for (const bad of [null, "x", { account: SPARE_KEY }, { configDir: SPARE_DIR }, { account: "claude:abcd1234", configDir: SPARE_DIR }, { account: SPARE_KEY, configDir: "" }]) {
      expect(readRemoteAccountPin({ remoteAccountPin: bad } as never)).toBeUndefined();
    }
    expect(readRemoteAccountPin(null)).toBeUndefined();
    expect(metaWithRemoteAccountPin({ a: 1 }, PIN)).toEqual({ a: 1, remoteAccountPin: PIN });
    expect(metaWithRemoteAccountPin({ a: 1, remoteAccountPin: PIN as never }, null)).toEqual({ a: 1 });
    expect(metaWithRemoteAccountPin({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(metaWithRemoteAccountPin(undefined, null)).toBeUndefined();
  });

  it("is on the host of an employee whose login is on the same user@host, with or without a profile of its own, and on no other", () => {
    expect(pinIsOnHostOf(PIN, OWN_KEY)).toBe(true);
    expect(pinIsOnHostOf(PIN, remoteClaudeAccountKey(HOST, undefined))).toBe(true);
    expect(pinIsOnHostOf(PIN, remoteClaudeAccountKey({ remoteHost: "build-host", remoteUser: "someone" }, HOME_DIR))).toBe(false);
    expect(pinIsOnHostOf(PIN, remoteClaudeAccountKey({ remoteHost: "other-host", remoteUser: "me" }, HOME_DIR))).toBe(false);
    expect(pinIsOnHostOf(PIN, "claude")).toBe(false);
    expect(pinIsOnHostOf(PIN, "claude:abcd1234")).toBe(false);
  });
});

describe("the directory every launch is given", () => {
  const who = employee();

  it("is the pin's for a pinned session and the employee's for any other", () => {
    expect(target(who, pinned())).toMatchObject({ remoteHost: "build-host", remoteClaudeConfigDir: SPARE_DIR });
    expect(target(who, makeSession({ employee: "dev" }))).toMatchObject({ remoteClaudeConfigDir: HOME_DIR });
  });

  it("is a standing override's before the pin's, and the employee's while an override stands on its own login", () => {
    const onOther = pinned(PIN, { transportMeta: { remoteAccountPin: PIN, engineOverride: { substituteAccount: OTHER_KEY, substituteConfigDir: OTHER_DIR, originalAccount: SPARE_KEY } } as never });
    expect(target(who, onOther)).toMatchObject({ remoteClaudeConfigDir: OTHER_DIR });
    const onOwn = pinned(PIN, { transportMeta: { remoteAccountPin: PIN, engineOverride: { substituteAccount: OWN_KEY, substituteConfigDir: HOME_DIR, originalAccount: SPARE_KEY } } as never });
    expect(target(who, onOwn)).toMatchObject({ remoteClaudeConfigDir: HOME_DIR });
    // An own login with the host's default profile has no directory: the pin must not stand in for it.
    const plain = employee({ remoteClaudeConfigDir: undefined });
    const onDefault = pinned(PIN, { transportMeta: { remoteAccountPin: PIN, engineOverride: { substituteAccount: remoteClaudeAccountKey(HOST, undefined), substituteConfigDir: null, originalAccount: SPARE_KEY } } as never });
    expect(target(plain, onDefault)?.remoteClaudeConfigDir).toBeUndefined();
  });

  it("ignores a pin made on another user@host", () => {
    const moved = employee({ remoteHost: "moved-host", remoteClaudeConfigDir: "/home/me/.claude-moved" });
    registerEmployeeAccountResolver(() => remoteClaudeAccountKey({ remoteHost: "moved-host", remoteUser: "me" }, "/home/me/.claude-moved"));
    expect(target(moved, pinned())).toMatchObject({ remoteHost: "moved-host", remoteClaudeConfigDir: "/home/me/.claude-moved" });
    expect(withStandingRemoteAccount({ remoteHost: "moved-host", remoteUser: "me", remoteClaudeConfigDir: "/x" }, pinned())).toEqual({ remoteHost: "moved-host", remoteUser: "me", remoteClaudeConfigDir: "/x" });
  });

  it("is never taken from the profile column of the row", () => {
    const row = makeSession({ employee: "dev", claudeConfigDir: "/srv/operator/.claude-local" });
    expect(target(who, row)).toMatchObject({ remoteClaudeConfigDir: HOME_DIR });
    expect(target(who, pinned(PIN, { claudeConfigDir: "/srv/operator/.claude-local" }))).toMatchObject({ remoteClaudeConfigDir: SPARE_DIR });
  });
});

describe("the session's own account", () => {
  const who = employee();

  it("is the pinned account for its thread slot, its limit and its signed-in scope, and the employee's login otherwise", () => {
    const session = pinned();
    expect(threadSlot(session, "claude")).toBe(SPARE_KEY);
    expect(ownClaudeAccountOf(session, who)).toBe(SPARE_KEY);
    expect(rateLimitAccount("claude", who, session)).toEqual({ claudeProfile: null, account: SPARE_KEY });
    expect(claudeAuthScope(who, session)).toBe(`me@build-host:${SPARE_DIR}`);
    const plain = makeSession({ employee: "dev" });
    expect(threadSlot(plain, "claude")).toBe(OWN_KEY);
    expect(rateLimitAccount("claude", who, plain).account).toBe(OWN_KEY);
    expect(claudeAuthScope(who, plain)).toBe(`me@build-host:${HOME_DIR}`);
  });

  it("is the employee's when the pin was made on another host", () => {
    registerEmployeeAccountResolver(() => remoteClaudeAccountKey({ remoteHost: "moved-host", remoteUser: "me" }, "/home/me/.claude-moved"));
    const moved = employee({ remoteHost: "moved-host", remoteClaudeConfigDir: "/home/me/.claude-moved" });
    expect(threadSlot(pinned(), "claude")).toBe(remoteClaudeAccountKey({ remoteHost: "moved-host", remoteUser: "me" }, "/home/me/.claude-moved"));
    expect(claudeAuthScope(moved, pinned())).toBe("me@moved-host:/home/me/.claude-moved");
  });

  it("reads its health as the pinned account's", () => {
    const spent = { state: "exhausted" as const, until: new Date(Date.now() + 3600_000).toISOString(), recheckAt: new Date(Date.now() + 3600_000).toISOString() };
    const read = substituteHealth({ [SPARE_KEY]: spent }, who, pinned());
    expect(read.claude).toBe(spent);
    expect(substituteHealth({ [SPARE_KEY]: spent }, who, makeSession({ employee: "dev" })).claude).toBeUndefined();
  });
});

describe("the walk off a pinned session", () => {
  const who = employee();
  const remote = { ...HOST, remoteCwd: "/srv/work/dev", remoteClaudeConfigDir: HOME_DIR };
  const decide = (session: ReturnType<typeof makeSession>, account: string, run?: unknown) => chooseSubstituteOrReason({
    config, engines: new Set(["claude", "opencode"]), session, employee: who, account, remote, remoteTarget: remote, ...(run ? { run } : {}),
  } as unknown as ChooseSubstituteInput);

  it("takes the group's other member on the host by its directory, and the employee's login on the employee's, whichever the session is pinned to", () => {
    const fromSpare = decide(pinned(), SPARE_KEY);
    // The employee's login ranks first (written order) and runs on the employee's directory, not the pinned one.
    expect(fromSpare.choice).toMatchObject({ engine: "claude", accounts: { original: SPARE_KEY, substitute: OWN_KEY, substituteConfigDir: HOME_DIR } });
    health = { [OWN_KEY]: { state: "exhausted", until: new Date(Date.now() + 3600_000).toISOString(), recheckAt: new Date(Date.now() + 3600_000).toISOString() } };
    expect(decide(pinned(), SPARE_KEY).choice).toMatchObject({ accounts: { original: SPARE_KEY, substitute: OTHER_KEY, substituteConfigDir: OTHER_DIR } });
  });

  it("is chained on the employee's login as one of its links, not dropped as the session's own", () => {
    const { chain } = decide(pinned(), SPARE_KEY);
    expect(chain!.links[0]!.account).toBe(SPARE_KEY);
    expect(chain!.links.filter((link) => link.engine === "claude").map((link) => link.account)).toEqual(expect.arrayContaining([SPARE_KEY, OWN_KEY, OTHER_KEY]));
    expect(chain!.links.filter((link) => link.account === SPARE_KEY)).toHaveLength(1);
  });

  it("returns a swap onto the pinned account to the pinned directory when the pinned account is the target", () => {
    // A session standing on its employee's login (an override) whose own account is the pinned one: the way back is the pin's directory.
    const standing = pinned(PIN, { transportMeta: { remoteAccountPin: PIN, engineOverride: { substituteAccount: OWN_KEY, substituteConfigDir: HOME_DIR, originalAccount: SPARE_KEY } } as never });
    expect(target(who, standing)).toMatchObject({ remoteClaudeConfigDir: HOME_DIR });
    const back = decide(standing, OWN_KEY);
    expect(back.chain!.links[0]!.account).toBe(SPARE_KEY);
  });
});

describe("a creation reroute off a pinned account", () => {
  const registry = availabilityRegistry({}, (name) => name === "claude" || name === "opencode");
  const args = (health: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    config, employee: employee(), engine: "claude", model: "opus", registry, scope: { scoped: false, remote: true, host: "me@build-host" }, health,
    pin: { accountPick: { source: "employee", groupIndex: 0, picked: SPARE_KEY, trigger: "start", reason: "weighted", at: new Date().toISOString(), candidates: [] }, remoteAccountPin: PIN },
    ...over,
  }) as unknown as Parameters<typeof rerouteAtCreation>[0];
  const spent = (hours: number) => ({ state: "exhausted", until: new Date(Date.now() + hours * 3600_000).toISOString(), recheckAt: new Date(Date.now() + hours * 3600_000).toISOString() });

  it("moves onto the employee's own login on the employee's directory, with the pinned account as the one it returns to", () => {
    const choice = rerouteAtCreation(args({ [SPARE_KEY]: spent(2) }))!;
    expect(choice).toMatchObject({ engine: "claude", reroute: { account: { original: SPARE_KEY, substitute: OWN_KEY, configDir: HOME_DIR } } });
  });

  it("returns an account off the Claude target to the pinned account when it goes to another engine", () => {
    const choice = rerouteAtCreation(args({ [SPARE_KEY]: spent(2), [OWN_KEY]: spent(2), [OTHER_KEY]: spent(2) }))!;
    expect(choice).toMatchObject({ engine: "opencode" });
    expect(choice.reroute.account).toBeUndefined();
  });

  it("starts where it would for a pinned account that is healthy", () => {
    expect(rerouteAtCreation(args({ [OWN_KEY]: spent(2) }))).toBeUndefined();
  });
});

describe("a pinned session's chain and launches", () => {
  const registry = availabilityRegistry({}, (name) => name === "claude" || name === "opencode");
  const remote = { ...HOST, remoteCwd: "/srv/work/dev", remoteClaudeConfigDir: HOME_DIR };
  const engineChain = { ...config, engines: { ...config.engines, claude: { ...(config.engines.claude as object), fallback: [GROUP, { engine: "opencode", model: "x/m" }] } } } as unknown as HundredfoldConfig;
  const pick = (source: string) => ({ source, groupIndex: 0, picked: SPARE_KEY, trigger: "start", reason: "weighted", at: new Date().toISOString(), candidates: [] });

  it("keeps the chain the pick came from after its employee is given a chain of its own", () => {
    const edited = employee({ fallback: [{ engine: "opencode", model: "x/m" }] });
    const session = makeSession({ employee: "dev", transportMeta: { remoteAccountPin: PIN, accountPick: pick("engine") } as never });
    const { source, links } = sessionFallbackChain({ config: engineChain, employee: edited, session, registry, health: {}, scope: { scoped: false, remote: true, host: "me@build-host" } });
    expect(source).toBe("engine");
    expect(links.filter((link) => link.engine === "claude").map((link) => link.account)).toEqual(expect.arrayContaining([SPARE_KEY, OWN_KEY, OTHER_KEY]));
    // Without the pick the same session reads the employee's new chain.
    const unpicked = sessionFallbackChain({ config: engineChain, employee: edited, session: makeSession({ employee: "dev", transportMeta: { remoteAccountPin: PIN } as never }), registry, health: {}, scope: { scoped: false, remote: true, host: "me@build-host" } });
    expect(unpicked.source).toBe("employee");
  });

  it("launches a link that is the session's own pinned account on the pinned directory, and its employee's login on the employee's", () => {
    const input = (session: ReturnType<typeof makeSession>, account: string) => ({ config, session, employee: employee(), account, remote, remoteTarget: remote }) as unknown as ChooseSubstituteInput;
    const link = (account: string) => ({ engine: "claude", account, key: account, label: account, origin: "config" }) as never;
    // The session stands on its employee's login (an override), so a link naming the pinned account is a swap back onto the pin's directory.
    const standing = pinned(PIN, { transportMeta: { remoteAccountPin: PIN, engineOverride: { substituteAccount: OWN_KEY, substituteConfigDir: HOME_DIR, originalAccount: SPARE_KEY } } as never });
    expect(launchFor(input(standing, OWN_KEY), false, link(SPARE_KEY))).toMatchObject({ accounts: { original: OWN_KEY, substitute: SPARE_KEY, substituteConfigDir: SPARE_DIR } });
    expect(launchFor(input(pinned(), SPARE_KEY), false, link(OWN_KEY))).toMatchObject({ accounts: { original: SPARE_KEY, substitute: OWN_KEY, substituteConfigDir: HOME_DIR } });
    expect(launchFor(input(pinned(), SPARE_KEY), false, link(OTHER_KEY))).toMatchObject({ accounts: { substitute: OTHER_KEY, substituteConfigDir: OTHER_DIR } });
  });

  it("still launches on the pinned directory after the account is undeclared: the directory is in the record", () => {
    const undeclared = { ...config, engines: { ...config.engines, claude: { bin: "claude", model: "opus" } } } as unknown as HundredfoldConfig;
    const standing = pinned(PIN, { transportMeta: { remoteAccountPin: PIN, engineOverride: { substituteAccount: OWN_KEY, substituteConfigDir: HOME_DIR, originalAccount: SPARE_KEY } } as never });
    const input = { config: undeclared, session: standing, employee: employee(), account: OWN_KEY, remote, remoteTarget: remote } as unknown as ChooseSubstituteInput;
    expect(launchFor(input, false, { engine: "claude", account: SPARE_KEY, key: SPARE_KEY, label: "spare", origin: "config" } as never)).toMatchObject({ accounts: { original: OWN_KEY, substitute: SPARE_KEY, substituteConfigDir: SPARE_DIR } });
    expect(target(employee(), standing)).toMatchObject({ remoteClaudeConfigDir: HOME_DIR });
    expect(target(employee(), pinned())).toMatchObject({ remoteClaudeConfigDir: SPARE_DIR });
  });

  it("reads another host's health records as no record when it picks", () => {
    const spent = { state: "exhausted" as const, until: new Date(Date.now() + 3600_000).toISOString(), recheckAt: new Date(Date.now() + 3600_000).toISOString() };
    const limits = Object.fromEntries([OWN_KEY, SPARE_KEY].map((account) => [account, { at: Date.now(), windows: [{ name: "5h", usedPercent: 50, resetsAt: Math.floor(Date.now() / 1000) + 3600 }] }]));
    const chosen = (host: string) => pinAccountAtCreation({
      config: engineChain, employee: employee({ fallback: undefined }), engine: "claude", model: "opus",
      inputs: { health: { [SPARE_KEY]: { ...spent, host } as never }, limits: limits as never },
    }).accountPick!.candidates.find((candidate) => candidate.account === SPARE_KEY);
    expect(chosen("other-host")).toMatchObject({ state: "fresh" });
    expect(chosen("build-host")).toMatchObject({ state: "exhausted", weight: 0 });
  });
});
