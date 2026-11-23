import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorMessage, connectorStub, eventually, scriptedEngine } from "./helpers/turn-parity-harness.js";
import { HOUR, MINUTE, START, answer, fallbackConfig, fallbackExpiryHarness, limitedUntil } from "./helpers/fallback-expiry-harness.js";
import type { Employee, EngineResult, EngineRunOpts } from "../../shared/types.js";

/**
 * A remote employee's new sessions are balanced across the group at the head of its chain, the way a gateway session's are:
 * a real SessionManager over a Claude stand-in whose every launch is the ssh command the engine builds (the real
 * `buildSshSpawnArgs`, with `CLAUDE_CONFIG_DIR` taken from the target the turn ran with), answered by a local shell standing in
 * for the host. The pick pins the session to a remote account declared on the employee's own `user@host` in
 * `transportMeta.remoteAccountPin`, and every launch, wake and return then runs on the pinned directory.
 */

const hoisted = vi.hoisted(() => ({ ready: [] as Array<Record<string, unknown>> }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) => {
      if (command !== "ssh") return actual.spawn(command, args as string[], options);
      // ssh joins the words after the destination with spaces and hands them to the remote shell: a local `sh` does the same.
      return actual.spawn("sh", ["-c", args.slice(args.indexOf("--") + 2).join(" ")], options);
    }) as typeof actual.spawn,
  };
});

// Only the host check is replaced, so a turn's readiness target (the directory it probes) can be read off.
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  ensureRemoteReady: vi.fn(async (target: Record<string, unknown>) => {
    hoisted.ready.push({ ...target });
    return { ready: true, facts: { home: "/home/me", stageDir: "/home/me/.stage", nodeBin: process.execPath, hundredfoldVersion: "0.0.0", entryDir: "/home/me/entry" } };
  }),
}));

const { registry, healthPath, reset, settled, override } = await fallbackExpiryHarness("hundredfold-remote-account-group-");
const { SessionManager } = await import("../manager.js");
const { buildSshSpawnArgs } = await import("../../engines/remote-stage.js");
const { remoteClaudeAccountKey, registerEmployeeAccountResolver } = await import("../../shared/engine-account.js");
const { resolveRemoteClaudeConfigDir, sshDestination } = await import("../../shared/remote-target.js");
const { resetAccountCredits } = await import("../../shared/fallback-account-pick.js");
const { recordEngineUnavailable } = await import("../../shared/engine-health.js");
const { sessionRemoteTarget, ownClaudeAccount, threadSlot } = await import("../session-account.js");
const { remoteScopeFor } = await import("../session-cwd.js");

const LIMITS_DIR = path.join(path.dirname(path.dirname(healthPath)), "tmp", "engine-limits");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-remote-group-"));
const FAKE_CLAUDE = path.join(ROOT, "fake-claude");
fs.writeFileSync(FAKE_CLAUDE, "#!/bin/sh\nprintf '%s' \"${CLAUDE_CONFIG_DIR-unset}\"\n", { mode: 0o755 });
fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });

const HOST = { remoteHost: "build-host", remoteUser: "me" };
const HOME_DIR = "/home/me/.claude-own";
const SPARE_DIR = "/home/me/.claude-spare";
const AWAY_DIR = "/home/other/.claude-away";
const OWN_KEY = remoteClaudeAccountKey(HOST, HOME_DIR);
const SPARE_KEY = remoteClaudeAccountKey(HOST, SPARE_DIR);
const AWAY_KEY = remoteClaudeAccountKey({ remoteHost: "away-host", remoteUser: "other" }, AWAY_DIR);
const REMOTE = { root: ROOT, mount: "/mnt/hundredfold" };

const GROUP = { group: [{ engine: "claude" }, { engine: "claude", profile: "spare" }, { engine: "claude", profile: "away" }] };
const OPENCODE = { engine: "opencode", model: "x-provider/model-x" };

const worker = { name: "a-worker", engine: "claude", model: "opus", persona: "Remote group fixture", ...HOST, remoteCwd: path.join(ROOT, "work"), remoteClaudeConfigDir: HOME_DIR } as unknown as Employee;

/** `used` percent in each account's 5h window, read fresh at the current (faked) time. */
function writeUsage(used: Record<string, number>): void {
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor((Date.now() + 24 * HOUR) / 1000);
  for (const [account, percent] of Object.entries(used)) {
    fs.writeFileSync(path.join(LIMITS_DIR, `claude-usage-history.${encodeURIComponent(account)}.json`), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: percent, resetsAt: later }] }]));
  }
}

/** What each launch of the Claude stand-in ran with: the target it was given, the ssh command built from it and what the host's shell saw. */
interface Launch { dir: string | undefined; command: string; hostSaw: string; resume?: string }

/** A Claude whose every run is a real ssh command (answered by a local shell) built the way the engine builds it. */
function remoteClaude(script: EngineResult[]) {
  const launches: Launch[] = [];
  const queue = [...script];
  const engine = {
    name: "claude",
    launches,
    async run(opts: EngineRunOpts) {
      const dir = resolveRemoteClaudeConfigDir(opts, REMOTE);
      const args = buildSshSpawnArgs({
        destination: sshDestination(opts as never), tunnelPort: 0, gatewayPort: 0, reverseTunnel: false, allocateTty: false,
        remoteCwd: opts.remoteCwd!, remoteEnv: dir ? { CLAUDE_CONFIG_DIR: dir } : {}, unsetRemoteEnv: dir ? [] : ["CLAUDE_CONFIG_DIR"],
        bin: FAKE_CLAUDE, args: [],
      });
      const hostSaw = await new Promise<string>((resolve, reject) => {
        const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout!.on("data", (chunk) => { out += String(chunk); });
        child.on("error", reject);
        child.on("close", () => resolve(out));
      });
      launches.push({ dir, command: args.join(" "), hostSaw, ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}) });
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
    isAlive: () => false, kill: () => {}, killAll: () => {},
  };
  return engine;
}

function profileOf(name: string): Record<string, unknown> {
  return name === "spare" ? { ...HOST, configDir: SPARE_DIR } : { remoteHost: "away-host", remoteUser: "other", configDir: AWAY_DIR };
}

/** A session manager for the remote employee, with the group at the head of its chain (the employee's, or the engine's when `onEngine`). */
function build(script: EngineResult[], opts: { onEngine?: boolean } = {}) {
  const cfg = fallbackConfig() as any;
  cfg.remote = REMOTE;
  cfg.engines.claude = {
    bin: process.execPath, model: "opus", accounts: { spare: profileOf("spare"), away: profileOf("away") },
    ...(opts.onEngine ? { fallback: [GROUP, OPENCODE] } : {}),
  };
  cfg.engines.opencode = { bin: process.execPath, model: "x-provider/model-x" };
  cfg.models.claude = { default: "opus", models: [{ id: "opus" }, { id: "sonnet" }] };
  cfg.models.opencode = { default: "x-provider/model-x", models: [] };
  const claude = remoteClaude(script);
  const opencode: any = scriptedEngine("opencode", [answer("opencode answer", "oc-thread")]);
  const manager = new SessionManager(cfg, new Map([["claude", claude], ["opencode", opencode]]) as never, "remote-group-boot");
  const employee = (opts.onEngine ? worker : { ...worker, fallback: [GROUP, OPENCODE] }) as Employee;
  return { manager, claude, opencode, employee, cfg };
}

type Built = ReturnType<typeof build>;

async function turn(built: Built, key: string, text: string, who: Employee = built.employee): Promise<string> {
  const answers = (id: string) => registry.getMessages(id).filter((m) => m.role === "assistant").length;
  const existing = registry.getSessionBySessionKey(key);
  const before = existing ? answers(existing.id) : 0;
  const routed = await built.manager.route(connectorMessage(key, text), connectorStub(), { employee: who as never });
  const id = routed!.sessionId;
  await eventually(() => answers(id) > before && settled(id));
  return id;
}

const at = (ms: number) => vi.setSystemTime(new Date(START.getTime() + ms));
const meta = (id: string) => registry.getSession(id)!.transportMeta as { accountPick?: { picked: string; reason: string }; remoteAccountPin?: { account: string; configDir: string } } | null;
const pickOf = (id: string) => meta(id)?.accountPick;
const pinOf = (id: string) => meta(id)?.remoteAccountPin;
const claudeAnswers = (count: number): EngineResult[] => Array.from({ length: count }, (_, n) => answer(`answer ${n}`, `thread-${n}`));

beforeEach(() => {
  reset();
  resetAccountCredits();
  hoisted.ready.length = 0;
  registerEmployeeAccountResolver((name) => (name === worker.name ? OWN_KEY : undefined));
});
afterEach(() => {
  vi.useRealTimers();
  registerEmployeeAccountResolver(undefined);
});

describe("new sessions of a remote employee are spread by headroom", () => {
  it("splits ten spaced starts 60/40 between its own login and the declared account on its host, and never takes another host's", async () => {
    const built = build(claudeAnswers(1));
    const ids: string[] = [];
    for (let n = 0; n < 10; n++) {
      // Each start is charged at once; the readings are read again as the clock moves past the refresh interval.
      writeUsage({ [OWN_KEY]: 40, [SPARE_KEY]: 60, [AWAY_KEY]: 0 });
      at(n * 20 * MINUTE);
      ids.push(await turn(built, `stub:spaced-${n}`, "go"));
    }
    const picks = ids.map((id) => pickOf(id)!.picked);
    expect(picks.filter((account) => account === OWN_KEY)).toHaveLength(6);
    expect(picks.filter((account) => account === SPARE_KEY)).toHaveLength(4);
    expect(picks.slice(0, 5)).toEqual([OWN_KEY, SPARE_KEY, OWN_KEY, SPARE_KEY, OWN_KEY]);
    expect(picks).not.toContain(AWAY_KEY);
    // Each session ran where it was pinned.
    expect(built.claude.launches.map((launch) => launch.dir)).toEqual(picks.map((account) => (account === SPARE_KEY ? SPARE_DIR : HOME_DIR)));
  }, 120_000);

  it("splits a burst inside one reading interval, because each start is charged to its account at once", async () => {
    writeUsage({ [OWN_KEY]: 50, [SPARE_KEY]: 50 });
    const built = build(claudeAnswers(1));
    const ids: string[] = [];
    for (let n = 0; n < 4; n++) ids.push(await turn(built, `stub:burst-${n}`, "go"));
    const picks = ids.map((id) => pickOf(id)!.picked);
    expect(picks.filter((account) => account === OWN_KEY)).toHaveLength(2);
    expect(picks.filter((account) => account === SPARE_KEY)).toHaveLength(2);
  }, 60_000);

  it("balances on the engine's chain when the employee writes none, and on its own when it does", async () => {
    writeUsage({ [OWN_KEY]: 95, [SPARE_KEY]: 5 });
    const onEngine = build(claudeAnswers(1), { onEngine: true });
    const fromEngine = await turn(onEngine, "stub:engine-chain", "go");
    expect(pickOf(fromEngine)).toMatchObject({ picked: SPARE_KEY });
    expect(registry.getSession(fromEngine)!.transportMeta).toMatchObject({ accountPick: { source: "engine" } });
    resetAccountCredits();
    const onEmployee = build(claudeAnswers(1));
    const fromEmployee = await turn(onEmployee, "stub:employee-chain", "go");
    expect(registry.getSession(fromEmployee)!.transportMeta).toMatchObject({ accountPick: { source: "employee", picked: SPARE_KEY } });
  }, 60_000);
});

describe("what a pick writes on a remote session's row", () => {
  it("pins a pick of another account in the transport meta, and never in the profile column", async () => {
    writeUsage({ [OWN_KEY]: 95, [SPARE_KEY]: 5 });
    const built = build(claudeAnswers(1));
    const id = await turn(built, "stub:pins", "go");
    expect(pinOf(id)).toEqual({ account: SPARE_KEY, configDir: SPARE_DIR });
    expect(registry.getSession(id)!.claudeConfigDir).toBeNull();
    expect(ownClaudeAccount(registry.getSession(id)!)).toBe(SPARE_KEY);
    expect(threadSlot(registry.getSession(id)!, "claude")).toBe(SPARE_KEY);
    expect(hoisted.ready.at(-1)).toMatchObject({ remoteHost: "build-host", remoteClaudeConfigDir: SPARE_DIR });
    expect(built.claude.launches[0]).toMatchObject({ dir: SPARE_DIR, hostSaw: SPARE_DIR });
    expect(built.claude.launches[0]!.command).toContain(`CLAUDE_CONFIG_DIR='${SPARE_DIR}'`);
  }, 30_000);

  it("writes nothing for a pick of the employee's own login, and the session runs on the employee's directory", async () => {
    writeUsage({ [OWN_KEY]: 5, [SPARE_KEY]: 95 });
    const built = build(claudeAnswers(1));
    const id = await turn(built, "stub:own-login", "go");
    expect(pickOf(id)).toMatchObject({ picked: OWN_KEY });
    expect(meta(id)).not.toHaveProperty("remoteAccountPin");
    expect(registry.getSession(id)!.claudeConfigDir).toBeNull();
    expect(built.claude.launches[0]).toMatchObject({ dir: HOME_DIR, hostSaw: HOME_DIR });
  }, 30_000);

  it("ignores a pin made on another user@host: the session runs as its employee's login", async () => {
    writeUsage({ [OWN_KEY]: 95, [SPARE_KEY]: 5 });
    const built = build(claudeAnswers(3));
    const id = await turn(built, "stub:other-host", "go");
    expect(pinOf(id)).toBeDefined();
    // The employee now sits on another machine (and another login there): the pin names a profile on the old one.
    const MOVED_DIR = "/home/me/.claude-moved";
    const movedKey = remoteClaudeAccountKey({ remoteHost: "moved-host", remoteUser: "me" }, MOVED_DIR);
    registerEmployeeAccountResolver((name) => (name === worker.name ? movedKey : undefined));
    const moved = { ...built.employee, remoteHost: "moved-host", remoteClaudeConfigDir: MOVED_DIR } as Employee;
    await turn(built, "stub:other-host", "again", moved);
    const session = registry.getSession(id)!;
    expect(built.claude.launches.at(-1)).toMatchObject({ dir: MOVED_DIR, hostSaw: MOVED_DIR });
    expect(sessionRemoteTarget(moved, remoteScopeFor(REMOTE, session), session)).toMatchObject({ remoteHost: "moved-host", remoteClaudeConfigDir: MOVED_DIR });
    expect(ownClaudeAccount(session)).toBe(movedKey);
  }, 60_000);
});

describe("a remote session pinned to an account keeps it", () => {
  it("over many turns, a resume and a restart, however its group's readings move", async () => {
    writeUsage({ [OWN_KEY]: 95, [SPARE_KEY]: 5 });
    const built = build(claudeAnswers(8));
    const key = "stub:sticky";
    const id = await turn(built, key, "one");
    const first = pickOf(id);
    expect(pinOf(id)).toEqual({ account: SPARE_KEY, configDir: SPARE_DIR });

    // Its account is now nearly spent and its employee's login nearly empty: nothing may move it.
    writeUsage({ [OWN_KEY]: 2, [SPARE_KEY]: 97 });
    for (const text of ["two", "three", "four"]) await turn(built, key, text);
    expect(pinOf(id)).toEqual({ account: SPARE_KEY, configDir: SPARE_DIR });
    expect(pickOf(id)).toEqual(first);

    // A restart: the row is recovered as interrupted and the next message resumes it.
    registry.updateSession(id, { status: "running" });
    registry.recoverStaleSessions();
    expect(registry.getSession(id)!.status).toBe("interrupted");
    await turn(built, key, "five");
    await turn(built, key, "six");
    expect(pinOf(id)).toEqual({ account: SPARE_KEY, configDir: SPARE_DIR });
    expect(pickOf(id)).toEqual(first);
    expect(new Set(built.claude.launches.map((launch) => launch.dir))).toEqual(new Set([SPARE_DIR]));
    expect(built.claude.launches.every((launch) => launch.hostSaw === SPARE_DIR)).toBe(true);
    expect(built.claude.launches).toHaveLength(6);
    expect(built.claude.launches.slice(1).every((launch) => launch.resume !== undefined)).toBe(true);
  }, 90_000);
});

describe("a remote session pinned to an account at a usage limit", () => {
  it("hops to its employee's login, then the rest of the chain, and returns to the pinned directory at the reset", async () => {
    writeUsage({ [OWN_KEY]: 95, [SPARE_KEY]: 5 });
    // spare (its own) is limited for three hours; its employee's login, the group's other member on this host, is limited for 90 minutes.
    const built = build([
      answer("first", "spare-thread"),
      limitedUntil(new Date(START.getTime() + 3 * HOUR)), answer("on own login", "own-thread"),
      limitedUntil(new Date(START.getTime() + 90 * MINUTE)),
      answer("back on spare", "spare-thread-2"),
    ]);
    const key = "stub:hops";
    const id = await turn(built, key, "one");
    expect(pinOf(id)).toEqual({ account: SPARE_KEY, configDir: SPARE_DIR });

    at(10 * MINUTE);
    await turn(built, key, "two");
    expect(override(id)).toMatchObject({ originalAccount: SPARE_KEY, substituteAccount: OWN_KEY, substituteConfigDir: HOME_DIR });
    expect(built.claude.launches.at(-1)).toMatchObject({ dir: HOME_DIR, hostSaw: HOME_DIR });
    expect(pinOf(id)).toEqual({ account: SPARE_KEY, configDir: SPARE_DIR }); // the pin is the session's own account throughout

    // Its employee's login is out too: only the rest of the chain is left, and it runs on opencode.
    at(20 * MINUTE);
    await turn(built, key, "three");
    expect(registry.getSession(id)!.engine).toBe("opencode");
    expect(override(id)).toMatchObject({ originalEngine: "claude" });

    // Past both resets: the session returns to the account it was pinned to, on that account's directory on the host.
    at(4 * HOUR);
    await turn(built, key, "four");
    expect(registry.getSession(id)!.engine).toBe("claude");
    expect(override(id)).toBeUndefined();
    expect(built.claude.launches.at(-1)).toMatchObject({ dir: SPARE_DIR, hostSaw: SPARE_DIR });
    expect(built.claude.launches.at(-1)!.command).toContain(`CLAUDE_CONFIG_DIR='${SPARE_DIR}'`);
    expect(pinOf(id)).toEqual({ account: SPARE_KEY, configDir: SPARE_DIR });
    expect(threadSlot(registry.getSession(id)!, "claude")).toBe(SPARE_KEY);
  }, 120_000);

  it("pins the account that reopens first when every member is spent at creation, starts on the rest of the chain, and returns to the pinned directory at its reset", async () => {
    writeUsage({ [OWN_KEY]: 95, [SPARE_KEY]: 5 });
    recordEngineUnavailable(SPARE_KEY, "usage limit", Math.floor((START.getTime() + 2 * HOUR) / 1000), START, { host: "build-host" });
    recordEngineUnavailable(OWN_KEY, "usage limit", Math.floor((START.getTime() + 5 * HOUR) / 1000), START, { host: "build-host" });
    const built = build([answer("back on spare", "spare-thread")]);
    const key = "stub:created-spent";
    const id = await turn(built, key, "one");
    expect(pickOf(id)).toMatchObject({ picked: SPARE_KEY, reason: "all-exhausted" });
    expect(pinOf(id)).toEqual({ account: SPARE_KEY, configDir: SPARE_DIR });
    expect(registry.getSession(id)!.engine).toBe("opencode");
    expect(override(id)).toMatchObject({ originalEngine: "claude" });

    at(3 * HOUR);
    await turn(built, key, "two");
    expect(registry.getSession(id)!.engine).toBe("claude");
    expect(built.claude.launches).toHaveLength(1);
    expect(built.claude.launches[0]).toMatchObject({ dir: SPARE_DIR, hostSaw: SPARE_DIR });
  }, 60_000);
});

describe("a session the balancer leaves alone is untouched", () => {
  it("has no pin and runs on its employee's login when its chain opens with no group", async () => {
    writeUsage({ [OWN_KEY]: 95, [SPARE_KEY]: 5 });
    const built = build(claudeAnswers(1));
    const plain = { ...built.employee, fallback: [OPENCODE] } as Employee;
    const id = await turn(built, "stub:no-group", "go", plain);
    expect(pickOf(id)).toBeUndefined();
    expect(meta(id) ?? {}).not.toHaveProperty("remoteAccountPin");
    expect(built.claude.launches[0]).toMatchObject({ dir: HOME_DIR, hostSaw: HOME_DIR });
  }, 30_000);
});
