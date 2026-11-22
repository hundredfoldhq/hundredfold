import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig, Session } from "../../shared/types.js";

/**
 * A remote employee's session is balanced by an engine-only switch onto Claude as a gateway session is, and the pick is its
 * `transportMeta.remoteAccountPin`: a pick of another account on its host sets it, a pick of the employee's own login removes
 * an earlier one, and a switch that names the employee's own login ("profile": "") removes it too. The profile column is never
 * written for it.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-remote-pin-switch-"));
process.env.HUNDREDFOLD_HOME = home;
const LIMITS_DIR = path.join(home, "tmp", "engine-limits");
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: () => true,
}));

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-remote-pin-switch-root-")));
const HOST = { remoteHost: "build-host", remoteUser: "me" };
const HOME_DIR = "/home/me/.claude-own";
const SPARE_DIR = "/home/me/.claude-spare";

const { resetDepartmentFixtures, writeEmployeeFile } = await import("../../gateway/__tests__/department-fixtures.js");
const { remoteClaudeAccountKey, registerEmployeeAccountResolver, accountForEmployee } = await import("../../shared/engine-account.js");
const { resetAccountCredits } = await import("../../shared/fallback-account-pick.js");
const { resolveSwitchTarget } = await import("../switch-target.js");
const { patchSessionTarget } = await import("../../gateway/session-target-patch.js");
const { applyPendingSwitch } = await import("../pending-switch-apply.js");
const { buildPendingSwitch } = await import("../switch-request.js");
const { sessionRemoteTarget, threadSlot } = await import("../session-account.js");
const { remoteScopeFor } = await import("../session-cwd.js");
const { readRemoteAccountPin } = await import("../remote-account-pin.js");
const { validateNewSessionSelection } = await import("../session-patch.js");
const { recordEngineUnavailable } = await import("../../shared/engine-health.js");

let registry: typeof import("../registry.js");
let orgRegistry: typeof import("../../gateway/org-registry.js");
const OWN_KEY = remoteClaudeAccountKey(HOST, HOME_DIR);
const SPARE_KEY = remoteClaudeAccountKey(HOST, SPARE_DIR);

const GROUP = { group: [{ engine: "claude" }, { engine: "claude", profile: "spare" }] };
const config = {
  gateway: { port: 7798, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", accounts: { spare: { ...HOST, configDir: SPARE_DIR } }, fallback: [GROUP, { engine: "opencode", model: "x-provider/model-x" }] },
    codex: { bin: "codex", model: "gpt-5.5" },
    opencode: { bin: process.execPath, model: "x-provider/model-x" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] },
    codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] },
    opencode: { default: "x-provider/model-x", models: [] },
  },
  remote: { root: ROOT, mount: "/mnt/hundredfold" },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
} as unknown as HundredfoldConfig;

function writeUsage(used: Record<string, number>): void {
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600;
  for (const [account, percent] of Object.entries(used)) {
    fs.writeFileSync(path.join(LIMITS_DIR, `claude-usage-history.${encodeURIComponent(account)}.json`), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: percent, resetsAt: later }] }]));
  }
}

beforeAll(async () => {
  registry = await import("../registry.js");
  orgRegistry = await import("../../gateway/org-registry.js");
  (await import("../../shared/db.js")).initDb();
  resetDepartmentFixtures();
  fs.mkdirSync(path.join(ROOT, "work"), { recursive: true });
  writeEmployeeFile("platform", "remote-dev", { department: "platform", ...HOST, remoteCwd: path.join(ROOT, "work"), remoteClaudeConfigDir: HOME_DIR });
  orgRegistry.refreshOrg(config);
  registerEmployeeAccountResolver((name) => {
    const employee = orgRegistry.orgRegistry(config).get(name);
    return employee ? accountForEmployee(employee, "claude") : undefined;
  });
});
afterAll(() => {
  fs.rmSync(HEALTH_PATH, { force: true });
  registerEmployeeAccountResolver(undefined);
});
beforeEach(async () => {
  (await import("../../shared/db.js")).initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  fs.rmSync(HEALTH_PATH, { force: true });
  resetAccountCredits();
  writeUsage({ [OWN_KEY]: 90, [SPARE_KEY]: 10 });
});

/** A remote employee's session parked on codex, as one is before a switch onto Claude. */
function codexSession(ref: string, extra: Record<string, unknown> = {}): Session {
  const created = registry.createSession({ engine: "codex", source: "web", sourceRef: ref, model: "gpt-5.5", employee: "remote-dev", ...extra });
  return registry.getSession(created.id)!;
}

const pickOf = (session: Session) => (session.transportMeta as { accountPick?: { picked: string; trigger: string } } | null)?.accountPick;
const emit = () => undefined;
const PIN = { account: SPARE_KEY, configDir: SPARE_DIR };

describe("resolveSwitchTarget for a remote employee's session", () => {
  it("balances an engine-only switch onto Claude, and the pick of another account on its host is the pin", () => {
    const resolved = resolveSwitchTarget(config, codexSession("web:r1"), { engine: "claude" }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, target: { engine: "claude", claudeConfigDir: null, balanced: true }, accountPick: { trigger: "switch", picked: SPARE_KEY }, remoteAccountPin: PIN });
  });

  it("writes nothing for a pick of its own login on a session with no pin", () => {
    writeUsage({ [OWN_KEY]: 5, [SPARE_KEY]: 95 });
    const resolved = resolveSwitchTarget(config, codexSession("web:r2"), { engine: "claude" }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, accountPick: { picked: OWN_KEY } });
    expect(resolved.ok && resolved).not.toHaveProperty("remoteAccountPin");
  });

  it("removes an earlier pin when the pick is the employee's own login", () => {
    writeUsage({ [OWN_KEY]: 5, [SPARE_KEY]: 95 });
    const held = codexSession("web:r3", { transportMeta: { remoteAccountPin: PIN } });
    expect(resolveSwitchTarget(config, held, { engine: "claude" }, { caller: "operator" })).toMatchObject({ ok: true, accountPick: { picked: OWN_KEY }, remoteAccountPin: null });
  });

  it("removes the pin when the switch names the employee's own login, and leaves a session with none alone", () => {
    const held = codexSession("web:r4", { transportMeta: { remoteAccountPin: PIN } });
    expect(resolveSwitchTarget(config, held, { engine: "claude", profile: "" }, { caller: "operator" })).toMatchObject({ ok: true, remoteAccountPin: null });
    const none = resolveSwitchTarget(config, codexSession("web:r4b"), { engine: "claude", profile: "" }, { caller: "operator" });
    expect(none.ok && none).not.toHaveProperty("remoteAccountPin");
  });

  it("does not balance a switch that stays on Claude: the pin is kept", () => {
    const onClaude = registry.getSession(registry.createSession({ engine: "claude", source: "web", sourceRef: "web:r5", model: "opus", employee: "remote-dev", transportMeta: { remoteAccountPin: PIN } }).id)!;
    const model = resolveSwitchTarget(config, onClaude, { model: "sonnet" }, { caller: "operator" });
    expect(model.ok && model).not.toHaveProperty("accountPick");
    expect(model.ok && model).not.toHaveProperty("remoteAccountPin");
  });

  it("moves a session pinned to another account to its own login as a move of account, and asks a session itself to do the same as a switch", () => {
    const onSpare = registry.getSession(registry.createSession({ engine: "claude", source: "web", sourceRef: "web:r6", model: "opus", employee: "remote-dev", transportMeta: { remoteAccountPin: PIN } }).id)!;
    const resolved = resolveSwitchTarget(config, onSpare, { profile: "" }, { caller: "session" });
    expect(resolved).toMatchObject({ ok: true, sameTarget: false, remoteAccountPin: null });
    // A session already on its employee's login is on that target.
    const onOwn = registry.getSession(registry.createSession({ engine: "claude", source: "web", sourceRef: "web:r6b", model: "opus", employee: "remote-dev" }).id)!;
    expect(resolveSwitchTarget(config, onOwn, { profile: "" }, { caller: "session" })).toMatchObject({ ok: false, code: "same-target" });
  });
});

describe("the operator's engine-only switch (patchSessionTarget), remote", () => {
  const patch = (session: Session, body: Record<string, unknown>) => patchSessionTarget({ session, config, emit: emit as never, body, busy: false });

  it("writes the pick and the pin together, leaves the profile column alone, and runs the session on the pinned directory", () => {
    const first = codexSession("web:p1");
    expect(patch(first, { engine: "claude" })).toMatchObject({ kind: "switched" });
    const row = registry.getSession(first.id)!;
    expect(row.engine).toBe("claude");
    expect(row.claudeConfigDir).toBeNull();
    expect(pickOf(row)).toMatchObject({ picked: SPARE_KEY, trigger: "switch" });
    expect(readRemoteAccountPin(row.transportMeta)).toEqual(PIN);
    expect(threadSlot(row, "claude")).toBe(SPARE_KEY);
    // The conversation is kept under the pinned account's slot, not its employee's.
    expect(Object.keys(row.engineSessions ?? {})).toContain(SPARE_KEY);
    expect(Object.keys(row.engineSessions ?? {})).not.toContain(OWN_KEY);
    expect(sessionRemoteTarget(orgRegistry.orgRegistry(config).get("remote-dev"), remoteScopeFor(config.remote, row), row)).toMatchObject({ remoteClaudeConfigDir: SPARE_DIR });
  });

  it("removes the pin when the next switch picks the employee's own login, and the session runs on the employee's directory again", () => {
    const session = codexSession("web:p2");
    patch(session, { engine: "claude" });
    expect(readRemoteAccountPin(registry.getSession(session.id)!.transportMeta)).toEqual(PIN);
    registry.switchSessionTarget(session.id, { engine: "codex", model: "gpt-5.5" });
    expect(readRemoteAccountPin(registry.getSession(session.id)!.transportMeta)).toEqual(PIN); // leaving Claude leaves the record
    writeUsage({ [OWN_KEY]: 5, [SPARE_KEY]: 95 });
    patch(registry.getSession(session.id)!, { engine: "claude" });
    const row = registry.getSession(session.id)!;
    expect(readRemoteAccountPin(row.transportMeta)).toBeUndefined();
    expect(pickOf(row)).toMatchObject({ picked: OWN_KEY });
    expect(threadSlot(row, "claude")).toBe(OWN_KEY);
    expect(sessionRemoteTarget(orgRegistry.orgRegistry(config).get("remote-dev"), remoteScopeFor(config.remote, row), row)).toMatchObject({ remoteClaudeConfigDir: HOME_DIR });
  });

  it("leaves the profile column as the row has it, a stale directory included, whichever account it picks", () => {
    for (const [ref, used] of [["web:s1", { [OWN_KEY]: 90, [SPARE_KEY]: 10 }], ["web:s2", { [OWN_KEY]: 5, [SPARE_KEY]: 95 }]] as const) {
      writeUsage(used);
      const stale = codexSession(ref, { claudeConfigDir: "/srv/operator/.claude-local" });
      expect(patch(stale, { engine: "claude" })).toMatchObject({ kind: "switched" });
      expect(registry.getSession(stale.id)!.claudeConfigDir).toBe("/srv/operator/.claude-local");
    }
  });

  it("moves a pinned session's slot to its employee's when the operator names the own login", () => {
    const first = codexSession("web:p4");
    patch(first, { engine: "claude" });
    expect(patch(registry.getSession(first.id)!, { profile: "" })).toMatchObject({ kind: "switched" });
    const row = registry.getSession(first.id)!;
    expect(readRemoteAccountPin(row.transportMeta)).toBeUndefined();
    expect(threadSlot(row, "claude")).toBe(OWN_KEY);
  });

  it("does not charge a refused switch", () => {
    const session = codexSession("web:p3");
    expect(patchSessionTarget({ session, config, emit: emit as never, body: { engine: "claude" }, busy: true })).toMatchObject({ kind: "refused" });
    expect(readRemoteAccountPin(registry.getSession(session.id)!.transportMeta)).toBeUndefined();
  });
});

describe("a remote session's own switch (compact_session), remote", () => {
  function applied(session: Session, request: Record<string, unknown>) {
    const resolved = resolveSwitchTarget(config, session, request, { caller: "session" });
    if (!resolved.ok) throw new Error(resolved.error);
    const pending = buildPendingSwitch(config, session, resolved, { claimedAt: Date.now(), handoff: { handoff: "continue" } as never, opencodeMode: undefined });
    registry.updateSession(session.id, { status: "running", attemptToken: "attempt-1" });
    return applyPendingSwitch({ config, emit: emit as never }, registry.getSession(session.id)!, pending, "attempt-1");
  }

  it("picks and pins when the switch is applied, and picks again then: the account that looked best when it asked may not be by then", () => {
    const session = codexSession("web:c1");
    const asked = resolveSwitchTarget(config, session, { engine: "claude" }, { caller: "session" });
    expect(asked).toMatchObject({ ok: true, remoteAccountPin: PIN });
    // Readings move while the compaction runs.
    writeUsage({ [OWN_KEY]: 5, [SPARE_KEY]: 95 });
    expect(applied(session, { engine: "claude" })).toMatchObject({ applied: true });
    const row = registry.getSession(session.id)!;
    expect(pickOf(row)).toMatchObject({ picked: OWN_KEY });
    expect(readRemoteAccountPin(row.transportMeta)).toBeUndefined();
    expect(row.claudeConfigDir).toBeNull();
  });

  it("keeps the pin through a model-only switch: the session stays on the account it was balanced onto, in its slot and its directory", () => {
    const first = codexSession("web:c3");
    patchSessionTarget({ session: first, config, emit: emit as never, body: { engine: "claude" }, busy: false });
    const session = registry.getSession(first.id)!;
    expect(readRemoteAccountPin(session.transportMeta)).toEqual(PIN);
    expect(applied(session, { model: "sonnet" })).toMatchObject({ applied: true });
    const row = registry.getSession(session.id)!;
    expect(row.model).toBe("sonnet");
    expect(readRemoteAccountPin(row.transportMeta)).toEqual(PIN);
    expect(threadSlot(row, "claude")).toBe(SPARE_KEY);
    expect(sessionRemoteTarget(orgRegistry.orgRegistry(config).get("remote-dev"), remoteScopeFor(config.remote, row), row)).toMatchObject({ remoteClaudeConfigDir: SPARE_DIR });
  });

  it("still removes the pin when the switch names the employee's own login", () => {
    const first = codexSession("web:c4");
    patchSessionTarget({ session: first, config, emit: emit as never, body: { engine: "claude" }, busy: false });
    const session = registry.getSession(first.id)!;
    expect(applied(session, { profile: "" })).toMatchObject({ applied: true });
    const row = registry.getSession(session.id)!;
    expect(readRemoteAccountPin(row.transportMeta)).toBeUndefined();
    expect(threadSlot(row, "claude")).toBe(OWN_KEY);
  });

  it("pins the account it picks", () => {
    const session = codexSession("web:c2");
    expect(applied(session, { engine: "claude" })).toMatchObject({ applied: true });
    const row = registry.getSession(session.id)!;
    expect(readRemoteAccountPin(row.transportMeta)).toEqual(PIN);
    expect(row.claudeConfigDir).toBeNull();
  });
});

describe("a new session of a remote employee through the API's selection", () => {
  it("is pinned, and when the pinned account is spent starts on the employee's own login with the pinned account as the one it returns to", () => {
    const open = validateNewSessionSelection(config, {}, { employee: "remote-dev" });
    expect(open).toMatchObject({ ok: true, engine: "claude", accountPick: { picked: SPARE_KEY }, remoteAccountPin: PIN });
    expect(open).not.toHaveProperty("claudeConfigDir");
    expect(open).not.toHaveProperty("reroute");

    recordEngineUnavailable(SPARE_KEY, "usage limit", Math.floor(Date.now() / 1000) + 7200, new Date(), { host: "build-host" });
    // The pick weighs the spent account at nothing, so a new session starts on its employee's own login: no pin, nothing to leave.
    expect(validateNewSessionSelection(config, {}, { employee: "remote-dev" })).toMatchObject({ ok: true, accountPick: { picked: OWN_KEY } });
    recordEngineUnavailable(OWN_KEY, "usage limit", Math.floor(Date.now() / 1000) + 10800, new Date(), { host: "build-host" });
    // Both spent: it is pinned where it reopens first, and the reroute moves it to the next link with the pin as the account it returns to.
    const spent = validateNewSessionSelection(config, {}, { employee: "remote-dev" });
    expect(spent).toMatchObject({ ok: true, accountPick: { picked: SPARE_KEY, reason: "all-exhausted" }, remoteAccountPin: PIN, engine: "opencode" });
    expect(spent.reroute).toMatchObject({ from: "claude" });
  });

  it("reroutes the same way when both accounts are spent and its employee's own login reopens first", () => {
    recordEngineUnavailable(OWN_KEY, "usage limit", Math.floor(Date.now() / 1000) + 7200, new Date(), { host: "build-host" });
    recordEngineUnavailable(SPARE_KEY, "usage limit", Math.floor(Date.now() / 1000) + 10800, new Date(), { host: "build-host" });
    const spent = validateNewSessionSelection(config, {}, { employee: "remote-dev" });
    expect(spent).toMatchObject({ ok: true, accountPick: { picked: OWN_KEY, reason: "all-exhausted" }, engine: "opencode" });
    expect(spent.reroute).toMatchObject({ from: "claude" });
  });
});
