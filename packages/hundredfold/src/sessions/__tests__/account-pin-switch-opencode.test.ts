import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig, Session } from "../../shared/types.js";

/**
 * A deliberate switch onto opencode that names no model runs the balancer (trigger `switch`) and lands on the model its pick
 * names (an opencode session's account is its model); a switch that names a model pins that one and clears the pick. The
 * session's own switch picks when it is applied, not when it is asked for.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-account-pin-switch-opencode-"));
process.env.HUNDREDFOLD_HOME = home;
const LIMITS_DIR = path.join(home, "tmp", "engine-limits");
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { resetDepartmentFixtures, writeEmployeeFile } = await import("../../gateway/__tests__/department-fixtures.js");
const { resetAccountCredits } = await import("../../shared/fallback-account-pick.js");
const { resolveSwitchTarget } = await import("../switch-target.js");
const { patchSessionTarget } = await import("../../gateway/session-target-patch.js");
const { applyPendingSwitch } = await import("../pending-switch-apply.js");
const { buildPendingSwitch } = await import("../switch-request.js");

let registry: typeof import("../registry.js");
const OWN = "opencode/opencode-go";
const OTHER = "opencode/opencode-go-b";
const THIRD = "opencode/opencode-go-c";
const MODEL = "opencode-go/glm-5";
const OTHER_MODEL = "opencode-go-b/glm-5";
const THIRD_MODEL = "opencode-go-c/glm-5";

const GROUP = { group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }, { engine: "opencode", profile: "go-c" }] };
const config = {
  gateway: { port: 7797, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus" },
    codex: { bin: "codex", model: "gpt-5.5" },
    opencode: {
      bin: "opencode", model: MODEL, fallback: [GROUP, "codex"],
      accounts: {
        "go-a": { provider: "opencode-go" },
        "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY" },
        "go-c": { provider: "opencode-go-c", base: "opencode-go", keyEnv: "OPENCODE_GO_C_API_KEY" },
      },
    },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus", label: "Opus" }] },
    codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] },
    opencode: { default: MODEL, models: [MODEL, OTHER_MODEL, THIRD_MODEL].map((id) => ({ id })) },
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
    fs.writeFileSync(path.join(LIMITS_DIR, `opencode-usage-history.${encodeURIComponent(account)}.json`), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: percent, resetsAt: later }] }]));
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
  writeUsage({ [OWN]: 90, [OTHER]: 20, [THIRD]: 60 });
});

/** A session parked on codex, as one is before a switch onto opencode. */
function codexSession(ref: string, extra: Record<string, unknown> = {}): Session {
  const created = registry.createSession({ engine: "codex", source: "web", sourceRef: ref, model: "gpt-5.5", ...extra });
  return registry.getSession(created.id)!;
}

const pickOf = (session: Session) => (session.transportMeta as { accountPick?: { picked: string; trigger: string } } | null)?.accountPick;
const emit = () => undefined;

describe("resolveSwitchTarget onto opencode", () => {
  it("keeps the Claude profile the row names, so a later switch back lands on the same login", () => {
    const profileDir = path.join(home, "claude-spare");
    const session = codexSession("web:s-profile", { claudeConfigDir: profileDir });
    const resolved = resolveSwitchTarget(config, session, { engine: "opencode" }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, target: { engine: "opencode", model: OTHER_MODEL, balanced: true, claudeConfigDir: profileDir }, accountPick: { picked: OTHER } });
  });

  it("balances an engine-only switch and lands on the model its pick names", () => {
    const resolved = resolveSwitchTarget(config, codexSession("web:s1"), { engine: "opencode" }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, target: { engine: "opencode", model: OTHER_MODEL, balanced: true }, accountPick: { trigger: "switch", picked: OTHER } });
  });

  it("lands on the own model, spelled on the own account, when that is the pick", () => {
    writeUsage({ [OWN]: 1, [OTHER]: 90, [THIRD]: 90 });
    const resolved = resolveSwitchTarget(config, codexSession("web:s2"), { engine: "opencode" }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, target: { model: MODEL, balanced: true }, accountPick: { picked: OWN } });
  });

  it("pins a model it names and clears the pick, however the account stands", () => {
    const resolved = resolveSwitchTarget(config, codexSession("web:s3"), { engine: "opencode", model: THIRD_MODEL }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, target: { model: THIRD_MODEL }, accountPick: null });
    expect(resolved.ok && resolved.target).not.toHaveProperty("balanced");
  });

  it("does not balance a switch that stays on opencode, or one onto another engine", () => {
    const onOpencode = registry.getSession(registry.createSession({ engine: "opencode", source: "web", sourceRef: "web:s4", model: THIRD_MODEL }).id)!;
    // A model it names is a chosen account: balanced nothing, and an earlier pick is cleared.
    const model = resolveSwitchTarget(config, onOpencode, { model: OTHER_MODEL }, { caller: "operator" });
    expect(model).toMatchObject({ ok: true, target: { model: OTHER_MODEL }, accountPick: null });
    expect(model.ok && model.target).not.toHaveProperty("balanced");
    const toCodex = resolveSwitchTarget(config, onOpencode, { engine: "codex" }, { caller: "operator" });
    expect(toCodex.ok && toCodex).not.toHaveProperty("accountPick");
  });

  it("changes nothing in the rotation: resolving is not starting", () => {
    const session = codexSession("web:s5");
    const pickOfResolution = () => {
      const resolved = resolveSwitchTarget(config, session, { engine: "opencode" }, { caller: "operator" });
      const { at: _at, ...pick } = (resolved as { accountPick: { at: string } }).accountPick;
      return pick;
    };
    const first = pickOfResolution();
    for (let i = 0; i < 3; i++) expect(pickOfResolution()).toEqual(first);
  });

  it("makes no pick when opencode's chain has no group", () => {
    const plain = { ...config, engines: { ...config.engines, opencode: { ...(config.engines.opencode as object), fallback: ["codex"] } } } as unknown as HundredfoldConfig;
    const resolved = resolveSwitchTarget(plain, codexSession("web:s6"), { engine: "opencode" }, { caller: "operator" });
    expect(resolved).toMatchObject({ ok: true, target: { engine: "opencode" } });
    expect(resolved.ok && resolved.target).not.toHaveProperty("balanced");
    expect(resolved.ok && resolved).not.toHaveProperty("accountPick");
  });
});

describe("the operator's engine-only switch onto opencode (patchSessionTarget)", () => {
  const patch = (session: Session, body: Record<string, unknown>) => patchSessionTarget({ session, config, emit: emit as never, body, busy: false });

  it("writes the pick and the model together, and the next switch sees that start charged", () => {
    const first = codexSession("web:p1");
    expect(patch(first, { engine: "opencode" })).toMatchObject({ kind: "switched" });
    const row = registry.getSession(first.id)!;
    expect(row.engine).toBe("opencode");
    expect(row.model).toBe(OTHER_MODEL);
    expect(pickOf(row)).toMatchObject({ picked: OTHER, trigger: "switch" });

    // 20 and 60 headroom (and 10 for the built-in account): the next start goes to the other account.
    const second = codexSession("web:p2");
    patch(second, { engine: "opencode" });
    expect(registry.getSession(second.id)!.model).toBe(THIRD_MODEL);
    expect(pickOf(registry.getSession(second.id)!)).toMatchObject({ picked: THIRD, trigger: "switch" });
  });

  it("replaces the pick with the model it names, and drops the old pick", () => {
    const session = codexSession("web:p3");
    patch(session, { engine: "opencode" });
    expect(pickOf(registry.getSession(session.id)!)).toBeDefined();
    registry.switchSessionTarget(session.id, { engine: "codex", model: "gpt-5.5" });
    expect(pickOf(registry.getSession(session.id)!)).toBeDefined(); // leaving opencode leaves the record
    patch(registry.getSession(session.id)!, { engine: "opencode", model: THIRD_MODEL });
    const row = registry.getSession(session.id)!;
    expect(row.model).toBe(THIRD_MODEL);
    expect(pickOf(row)).toBeUndefined();
  });

  it("does not charge a refused switch", () => {
    const session = codexSession("web:p4");
    expect(patchSessionTarget({ session, config, emit: emit as never, body: { engine: "opencode" }, busy: true })).toMatchObject({ kind: "refused" });
    expect(pickOf(registry.getSession(session.id)!)).toBeUndefined();
    patch(codexSession("web:p5"), { engine: "opencode" });
    // The refused one was not charged: this was the rotation's first start.
    expect(pickOf(registry.getSession(registry.getSessionBySourceRef("web:p5")!.id)!)!.picked).toBe(OTHER);
  });
});

describe("a session's own switch onto opencode (compact_session)", () => {
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
    const { resolved, outcome } = applied(session, { engine: "opencode" });
    expect(resolved).toMatchObject({ ok: true, target: { balanced: true } });
    expect(outcome).toMatchObject({ applied: true });
    const row = registry.getSession(session.id)!;
    expect(row.engine).toBe("opencode");
    expect(row.model).toBe(OTHER_MODEL);
    expect(pickOf(row)).toMatchObject({ picked: OTHER, trigger: "switch" });
  });

  it("picks again at apply time: the account that looked best when it asked may not be by then", () => {
    const session = codexSession("web:c2");
    const resolved = resolveSwitchTarget(config, session, { engine: "opencode" }, { caller: "session" });
    expect(resolved).toMatchObject({ ok: true, accountPick: { picked: OTHER } });
    // Readings move while the compaction runs.
    writeUsage({ [OWN]: 90, [OTHER]: 95, [THIRD]: 5 });
    const { outcome } = applied(session, { engine: "opencode" });
    expect(outcome).toMatchObject({ applied: true });
    expect(pickOf(registry.getSession(session.id)!)).toMatchObject({ picked: THIRD });
    expect(registry.getSession(session.id)!.model).toBe(THIRD_MODEL);
  });

  it("pins a model it names and clears an earlier pick", () => {
    const session = codexSession("web:c3");
    applied(session, { engine: "opencode" });
    registry.switchSessionTarget(session.id, { engine: "codex", model: "gpt-5.5" });
    const { outcome } = applied(registry.getSession(session.id)!, { engine: "opencode", model: THIRD_MODEL });
    expect(outcome).toMatchObject({ applied: true });
    const row = registry.getSession(session.id)!;
    expect(row.model).toBe(THIRD_MODEL);
    expect(pickOf(row)).toBeUndefined();
  });
});
