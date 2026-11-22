import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig, Session } from "../../shared/types.js";

/**
 * A deliberate switch onto Claude that names no profile runs the balancer (trigger `switch`) and pins the account it picks;
 * a switch that names a profile pins that one and clears the pick; nothing else (a model change, a switch off Claude, a revert)
 * picks again. The session's own switch picks when it is applied, not when it is asked for.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-account-pin-switch-"));
process.env.HUNDREDFOLD_HOME = home;
const LIMITS_DIR = path.join(home, "tmp", "engine-limits");
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const OUTSIDE = process.env.HUNDREDFOLD_VITEST_SYSTEM_TEMP_ROOT ?? "/tmp";
const FRIEND = path.join(OUTSIDE, "account-pin-switch-friend");
const SPARE = path.join(OUTSIDE, "account-pin-switch-spare");

const { resetDepartmentFixtures, writeEmployeeFile } = await import("../../gateway/__tests__/department-fixtures.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
const { resetAccountCredits } = await import("../../shared/fallback-account-pick.js");
const { resolveSwitchTarget } = await import("../switch-target.js");
const { patchSessionTarget } = await import("../../gateway/session-target-patch.js");
const { applyPendingSwitch } = await import("../pending-switch-apply.js");
const { buildPendingSwitch } = await import("../switch-request.js");

let registry: typeof import("../registry.js");
const friendKey = `claude:${claudeProfileFromDir(FRIEND).key}`;
const spareKey = `claude:${claudeProfileFromDir(SPARE).key}`;

const GROUP = { group: [{ engine: "claude" }, { engine: "claude", profile: "friend" }, { engine: "claude", profile: "spare" }] };
const config = {
  gateway: { port: 7797, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", accounts: { friend: { configDir: FRIEND }, spare: { configDir: SPARE } }, fallback: [GROUP, "codex"] },
    codex: { bin: "codex", model: "gpt-5.5" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] },
    codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] },
  },
  remote: { root: "/srv/root", mount: "/mnt/hundredfold" },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
} as unknown as HundredfoldConfig;

/** `used` percent in each account's 5h window. */
function writeUsage(used: Record<string, number>): void {
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600;
  for (const [account, percent] of Object.entries(used)) {
    const file = account === "claude" ? "claude-usage-history.json" : `claude-usage-history.${encodeURIComponent(account)}.json`;
    fs.writeFileSync(path.join(LIMITS_DIR, file), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: percent, resetsAt: later }] }]));
  }
}

beforeAll(async () => {
  registry = await import("../registry.js");
  const { refreshOrg } = await import("../../gateway/org-registry.js");
  (await import("../../shared/db.js")).initDb();
  resetDepartmentFixtures();
  writeEmployeeFile("platform", "plain-dev", { department: "platform" });
  refreshOrg(config);
});
afterAll(() => fs.rmSync(HEALTH_PATH, { force: true }));
beforeEach(async () => {
  (await import("../../shared/db.js")).initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  fs.rmSync(HEALTH_PATH, { force: true });
  resetAccountCredits();
  writeUsage({ claude: 90, [friendKey]: 20, [spareKey]: 60 });
});

/** A session parked on codex, as one is before a switch onto Claude. */
function codexSession(ref: string, extra: Record<string, unknown> = {}): Session {
  const created = registry.createSession({ engine: "codex", source: "web", sourceRef: ref, model: "gpt-5.5", ...extra });
  return registry.getSession(created.id)!;
}

const pickOf = (session: Session) => (session.transportMeta as { accountPick?: { picked: string; trigger: string } } | null)?.accountPick;
const emit = () => undefined;

describe("resolveSwitchTarget", () => {
  it("balances an engine-only switch onto Claude and says which account it chose", () => {
    const resolved = resolveSwitchTarget(config, codexSession("web:s1"), { engine: "claude" }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, target: { engine: "claude", claudeConfigDir: FRIEND, profile: "friend", balanced: true }, accountPick: { trigger: "switch", picked: friendKey } });
  });

  it("pins the employee's own login by storing no profile when that is the pick", () => {
    writeUsage({ claude: 1, [friendKey]: 90, [spareKey]: 90 });
    const session = codexSession("web:s2", { claudeConfigDir: SPARE });
    const resolved = resolveSwitchTarget(config, session, { engine: "claude" }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, target: { claudeConfigDir: null, balanced: true }, accountPick: { picked: "claude" } });
  });

  it("pins a named profile and clears the pick, however the account stands", () => {
    const resolved = resolveSwitchTarget(config, codexSession("web:s3"), { engine: "claude", profile: "spare" }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, target: { claudeConfigDir: SPARE }, accountPick: null });
    expect(resolved.ok && resolved.target).not.toHaveProperty("balanced");
    const own = resolveSwitchTarget(config, codexSession("web:s3b", { claudeConfigDir: SPARE }), { engine: "claude", profile: "" }, { caller: "operator" });
    expect(own).toMatchObject({ ok: true, target: { claudeConfigDir: null }, accountPick: null });
  });

  it("does not balance a switch that stays on Claude, or one onto another engine", () => {
    const onClaude = registry.getSession(registry.createSession({ engine: "claude", source: "web", sourceRef: "web:s4", model: "opus", claudeConfigDir: FRIEND }).id)!;
    const model = resolveSwitchTarget(config, onClaude, { model: "sonnet" }, { caller: "operator" });
    expect(model).toMatchObject({ ok: true, target: { claudeConfigDir: FRIEND } });
    expect(model.ok && model).not.toHaveProperty("accountPick");
    const toCodex = resolveSwitchTarget(config, onClaude, { engine: "codex" }, { caller: "operator" });
    expect(toCodex.ok && toCodex).not.toHaveProperty("accountPick");
  });

  it("changes nothing in the rotation: resolving is not starting", () => {
    const session = codexSession("web:s5");
    const pickOfResolution = () => {
      const resolved = resolveSwitchTarget(config, session, { engine: "claude" }, { caller: "operator" });
      const { at: _at, ...pick } = (resolved as { accountPick: { at: string } }).accountPick;
      return pick;
    };
    const first = pickOfResolution();
    for (let i = 0; i < 3; i++) expect(pickOfResolution()).toEqual(first);
  });

  it("makes no pick for a session of an employee whose chain has no group", () => {
    const plain = { ...config, engines: { ...config.engines, claude: { ...(config.engines.claude as object), fallback: ["codex"] } } } as unknown as HundredfoldConfig;
    const resolved = resolveSwitchTarget(plain, codexSession("web:s6"), { engine: "claude" }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, target: { claudeConfigDir: null } });
    expect(resolved.ok && resolved).not.toHaveProperty("accountPick");
  });
});

describe("the operator's engine-only switch (patchSessionTarget)", () => {
  const patch = (session: Session, body: Record<string, unknown>) => patchSessionTarget({ session, config, emit: emit as never, body, busy: false });

  it("writes the pick and the account together, and the next switch sees that start charged", () => {
    const first = codexSession("web:p1");
    const result = patch(first, { engine: "claude" });
    expect(result).toMatchObject({ kind: "switched" });
    const row = registry.getSession(first.id)!;
    expect(row.engine).toBe("claude");
    expect(row.claudeConfigDir).toBe(FRIEND);
    expect(pickOf(row)).toMatchObject({ picked: friendKey, trigger: "switch" });

    // 20 and 60 headroom (and 10 for the default login): the next start goes to the other account.
    const second = codexSession("web:p2");
    patch(second, { engine: "claude" });
    expect(pickOf(registry.getSession(second.id)!)).toMatchObject({ picked: spareKey, trigger: "switch" });
  });

  it("replaces the pick with the profile it names, and drops the old pick", () => {
    const session = codexSession("web:p3");
    patch(session, { engine: "claude" });
    expect(pickOf(registry.getSession(session.id)!)).toBeDefined();
    registry.switchSessionTarget(session.id, { engine: "codex", model: "gpt-5.5" });
    expect(pickOf(registry.getSession(session.id)!)).toBeDefined(); // leaving Claude leaves the record
    patch(registry.getSession(session.id)!, { engine: "claude", profile: "spare" });
    const row = registry.getSession(session.id)!;
    expect(row.claudeConfigDir).toBe(SPARE);
    expect(pickOf(row)).toBeUndefined();
  });

  it("does not charge a refused switch", () => {
    const session = codexSession("web:p4");
    expect(patchSessionTarget({ session, config, emit: emit as never, body: { engine: "claude" }, busy: true })).toMatchObject({ kind: "refused" });
    expect(pickOf(registry.getSession(session.id)!)).toBeUndefined();
    patch(codexSession("web:p5"), { engine: "claude" });
    // The refused one was not charged: this was the rotation's first start.
    expect(pickOf(registry.getSession(registry.getSessionBySourceRef("web:p5")!.id)!)!.picked).toBe(friendKey);
  });
});

describe("a session's own switch (compact_session)", () => {
  /** Resolves as the session asking, schedules it as the route does, and applies it in the resume turn. */
  function applied(session: Session, request: Record<string, unknown>) {
    const resolved = resolveSwitchTarget(config, session, request, { caller: "session" });
    if (!resolved.ok) throw new Error(resolved.error);
    const pending = buildPendingSwitch(config, session, resolved, { claimedAt: Date.now(), handoff: { handoff: "continue" } as never, opencodeMode: undefined });
    registry.updateSession(session.id, { status: "running", attemptToken: "attempt-1" });
    const outcome = applyPendingSwitch({ config, emit: emit as never }, registry.getSession(session.id)!, pending, "attempt-1");
    return { resolved, outcome };
  }

  it("asks without charging, and picks when the switch is applied", () => {
    const session = codexSession("web:c1");
    const { resolved, outcome } = applied(session, { engine: "claude" });
    expect(resolved).toMatchObject({ ok: true, target: { balanced: true } });
    expect(outcome).toMatchObject({ applied: true });
    const row = registry.getSession(session.id)!;
    expect(row.engine).toBe("claude");
    expect(pickOf(row)).toMatchObject({ picked: friendKey, trigger: "switch" });
    expect(row.claudeConfigDir).toBe(FRIEND);
  });

  it("picks again at apply time: the account that looked best when it asked may not be by then", () => {
    const session = codexSession("web:c2");
    const resolved = resolveSwitchTarget(config, session, { engine: "claude" }, { caller: "session" });
    expect(resolved).toMatchObject({ ok: true, accountPick: { picked: friendKey } });
    // Readings move while the compaction runs.
    writeUsage({ claude: 90, [friendKey]: 95, [spareKey]: 5 });
    const { outcome } = applied(session, { engine: "claude" });
    expect(outcome).toMatchObject({ applied: true });
    expect(pickOf(registry.getSession(session.id)!)).toMatchObject({ picked: spareKey });
    expect(registry.getSession(session.id)!.claudeConfigDir).toBe(SPARE);
  });

  it("pins a profile it names and clears an earlier pick", () => {
    const session = codexSession("web:c3");
    applied(session, { engine: "claude" });
    registry.switchSessionTarget(session.id, { engine: "codex", model: "gpt-5.5" });
    const { outcome } = applied(registry.getSession(session.id)!, { engine: "claude", profile: "spare" });
    expect(outcome).toMatchObject({ applied: true });
    const row = registry.getSession(session.id)!;
    expect(row.claudeConfigDir).toBe(SPARE);
    expect(pickOf(row)).toBeUndefined();
  });
});
