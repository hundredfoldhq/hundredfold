import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { HundredfoldConfig, Session } from "../../shared/types.js";
import { baseConfig, call, delegate, home, loadApi, registry, resetFallbackFixture, setConfig, spawn, unloadApi } from "./session-fallback-api-harness.js";

/**
 * Every way a session starts picks an opencode session's account too: two accounts with 60 and 40 headroom share ten starts
 * six to four on each path, the pinned account is the model's provider, and a session that names a model on another
 * account's provider is not balanced.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const OWN = "opencode/opencode-go";
const FRIEND = "opencode/opencode-go-b";
const MODEL = "opencode-go/glm-5";
const FRIEND_MODEL = "opencode-go-b/glm-5";
const LIMITS_DIR = path.join(home, "tmp", "engine-limits");
const GROUP = { group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }] };

fs.writeFileSync(
  path.join(home, "org", "an-ocworker.yaml"),
  ["name: an-ocworker", "displayName: An Opencode Worker", "department: platform", "rank: employee", "engine: opencode", `model: ${MODEL}`, "persona: Account group fixture", ""].join("\n"),
);

let wakeEmployeeOnTodo: typeof import("../todo-employee-session.js").wakeEmployeeOnTodo;
let workItems: typeof import("../../work-items/store.js");
let resetAccountCredits: typeof import("../../shared/fallback-account-pick.js").resetAccountCredits;

beforeAll(async () => {
  await loadApi();
  ({ wakeEmployeeOnTodo } = await import("../todo-employee-session.js"));
  workItems = await import("../../work-items/store.js");
  ({ resetAccountCredits } = await import("../../shared/fallback-account-pick.js"));
}, 60_000);
afterAll(unloadApi);

function groupConfig(): HundredfoldConfig {
  return {
    ...baseConfig,
    engines: {
      ...baseConfig.engines,
      default: "opencode",
      opencode: {
        bin: "opencode", model: MODEL, fallback: [GROUP, "codex"],
        accounts: { "go-a": { provider: "opencode-go" }, "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY" } },
      },
    },
    models: { ...(baseConfig as unknown as { models: object }).models, opencode: { default: MODEL, models: [MODEL, FRIEND_MODEL].map((id) => ({ id })) } },
  } as unknown as HundredfoldConfig;
}

/** One fresh reading per account: `used` percent in its 5h window. */
function writeUsage(used: Record<string, number>): void {
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600;
  for (const [account, percent] of Object.entries(used)) {
    fs.writeFileSync(path.join(LIMITS_DIR, `opencode-usage-history.${encodeURIComponent(account)}.json`), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: percent, resetsAt: later }] }]));
  }
}

beforeEach(() => {
  resetFallbackFixture();
  resetAccountCredits();
  setConfig(groupConfig());
  writeUsage({ [OWN]: 40, [FRIEND]: 60 });
});

const pickOf = (session: Session) => (session.transportMeta as { accountPick?: { picked: string; reason: string } } | null)?.accountPick;
/** The account a session runs on: its model's provider. */
const accountOf = (session: Session): string => (session.model?.startsWith("opencode-go-b/") ? FRIEND : OWN);

/** Ten starts through one path, tallied by the account each session was pinned to. */
async function tally(start: (n: number) => Promise<Session>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (let n = 0; n < 10; n++) {
    const session = await start(n);
    expect(session.engine).toBe("opencode");
    expect(pickOf(session)).toMatchObject({ reason: "weighted" });
    expect(pickOf(session)!.picked).toBe(accountOf(session));
    if (pickOf(session)!.picked === FRIEND) expect(session.model).toBe(FRIEND_MODEL); // the same key on the picked provider
    counts[accountOf(session)] = (counts[accountOf(session)] ?? 0) + 1;
  }
  return counts;
}

const SIX_FOUR = { [OWN]: 6, [FRIEND]: 4 };

describe("ten opencode starts at 60/40 headroom through each path", () => {
  it("a Todo wake of an employee", async () => {
    expect(await tally(async (n) => {
      const item = workItems.createWorkItem({ title: `Todo ${n}`, source: "human" });
      const woken = wakeEmployeeOnTodo(context(), {
        workItemId: item.id, employee: { name: "an-ocworker", engine: "opencode", model: MODEL, persona: "fixture" } as never,
        role: "execute", actor: "test", title: `Todo ${n}`, sourceAttempt: `wake-${n}`, deliveryKind: "todo_wake", message: "brief", displayMessage: "brief",
      });
      expect(woken.ok).toBe(true);
      return registry.getSession((woken as { session: Session }).session.id)!;
    })).toEqual(SIX_FOUR);
  });

  it("a new chat with no engine named", async () => {
    expect(await tally(async () => {
      const created = await spawn({ employee: "an-ocworker" });
      expect(created.status).toBe(201);
      return registry.getSession(created.body.id)!;
    })).toEqual(SIX_FOUR);
  });

  it("a new chat naming the opencode engine, and one naming the employee's own model", async () => {
    expect(await tally(async (n) => {
      const created = await spawn(n % 2 === 0 ? { employee: "an-ocworker", engine: "opencode" } : { employee: "an-ocworker", model: MODEL });
      expect(created.status).toBe(201);
      return registry.getSession(created.body.id)!;
    })).toEqual(SIX_FOUR);
  });

  it("a new chat of the instance default (no employee)", async () => {
    expect(await tally(async () => {
      const created = await spawn({});
      expect(created.status).toBe(201);
      return registry.getSession(created.body.id)!;
    })).toEqual(SIX_FOUR);
  });

  it("a delegation", async () => {
    expect(await tally(async (n) => {
      const delegated = await delegate({ employee: "an-ocworker", task: `Delegated brief ${n} with acceptance.` });
      expect(delegated.status).toBe(201);
      return registry.getSession(delegated.body.sessionId)!;
    })).toEqual(SIX_FOUR);
  });

  it("a spawn by another session", async () => {
    const parent = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:parent", model: "opus" });
    const { toolHeaders } = await import("./session-fallback-api-harness.js");
    expect(await tally(async () => {
      const created = await spawn({ employee: "an-ocworker" }, toolHeaders(parent.id));
      expect(created.status).toBe(201);
      return registry.getSession(created.body.id)!;
    })).toEqual(SIX_FOUR);
  });

  it("a Todo dispatch to an employee", async () => {
    expect(await tally(async (n) => {
      const item = workItems.createWorkItem({ title: `Dispatch ${n}`, source: "human", assignee: "an-ocworker" });
      const started = await call("POST", `/api/work-items/${item.id}/dispatch`, {});
      expect(started.status).toBeLessThan(300);
      return registry.getSession(started.body.sessionId)!;
    })).toEqual(SIX_FOUR);
  });
});

describe("an opencode session that names its own account", () => {
  it("is pinned there with no pick when the new chat names a model of another account's provider, and leaves the rotation alone", async () => {
    const created = await spawn({ employee: "an-ocworker", model: FRIEND_MODEL });
    expect(created.status).toBe(201);
    const session = registry.getSession(created.body.id)!;
    expect(session.model).toBe(FRIEND_MODEL);
    expect(pickOf(session)).toBeUndefined();
    const next = await spawn({ employee: "an-ocworker" });
    expect(pickOf(registry.getSession(next.body.id)!)!.picked).toBe(OWN); // the first start of a fresh rotation
  });

  it("is not balanced when delegated either", async () => {
    const delegated = await delegate({ employee: "an-ocworker", model: FRIEND_MODEL });
    expect(delegated.status).toBe(201);
    const session = registry.getSession(delegated.body.sessionId)!;
    expect(session.model).toBe(FRIEND_MODEL);
    expect(pickOf(session)).toBeUndefined();
  });
});

describe("a balanced opencode session", () => {
  it("keeps its model and pick through a reset, a restart and further messages while the readings turn", async () => {
    const first = await spawn({ employee: "an-ocworker" });
    expect(first.status).toBe(201);
    // Make sure the one under test is the second start, the one pinned off the employee's own account.
    const created = await spawn({ employee: "an-ocworker" });
    const session = registry.getSession(created.body.id)!;
    expect(session.model).toBe(FRIEND_MODEL);
    const before = { model: session.model, pick: pickOf(session) };
    writeUsage({ [OWN]: 99, [FRIEND]: 1 });
    expect((await call("POST", `/api/sessions/${session.id}/reset`, {})).status).toBe(200);
    registry.updateSession(session.id, { status: "running" });
    registry.recoverStaleSessions();
    for (let n = 0; n < 3; n++) await call("POST", `/api/sessions/${session.id}/message`, { message: `again ${n}` });
    const after = registry.getSession(session.id)!;
    expect({ model: after.model, pick: pickOf(after) }).toEqual(before);
  });

  it("is copied with its model and pick by a duplicate, which is no start and charges nothing", async () => {
    await spawn({ employee: "an-ocworker" });
    const created = await spawn({ employee: "an-ocworker" });
    const session = registry.getSession(created.body.id)!;
    registry.recordEngineSessionId(session.id, "opencode", "thread-to-fork");
    resetAccountCredits();
    const next = async () => pickOf(registry.getSession((await spawn({ employee: "an-ocworker" })).body.id)!)!.picked;
    const first = await next(); // the rotation's first start
    resetAccountCredits();
    const copy = registry.duplicateSession(session.id).session;
    expect(copy.model).toBe(session.model);
    expect(pickOf(copy)).toEqual(pickOf(session));
    expect(await next()).toBe(first);
  });
});

describe("opencode starts that are not charged", () => {
  const firstPick = async (): Promise<string> => pickOf(registry.getSession((await spawn({ employee: "an-ocworker" })).body.id)!)!.picked;

  it("a refused start", async () => {
    expect((await call("POST", "/api/sessions", { prompt: "" })).status).toBe(400);
    expect((await spawn({ employee: "an-ocworker", engine: "no-such-engine" })).status).toBeGreaterThanOrEqual(400);
    expect(await firstPick()).toBe(OWN);
  });

  it("a session that was not created: a delegation into a live session", async () => {
    const item = workItems.createWorkItem({ title: "Reuse", source: "human" });
    const first = await delegate({ employee: "an-ocworker", workItemId: item.id });
    expect(first.status).toBe(201);
    const picked = pickOf(registry.getSession(first.body.sessionId)!)!.picked;
    const again = await delegate({ employee: "an-ocworker", workItemId: item.id, task: "A second brief with acceptance." });
    expect(again.body.sessionId).toBe(first.body.sessionId);
    expect(await firstPick()).toBe(picked === OWN ? FRIEND : OWN);
  });
});

/** The context the Todo wake needs: the harness's, through a request-free call. */
function context() {
  return {
    getConfig: () => groupConfig(),
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: () => undefined,
    reloadOrg: () => {},
    sessionManager: {
      getEngine: () => ({ name: "stub", run: () => new Promise(() => {}), isAlive: () => false, kill: () => {}, killAll: () => {} }),
      getEngines: () => new Map(),
      getQueue: () => ({
        enqueue: async () => {}, clearCancelled: () => {}, clearQueue: () => {}, holdForCallbackDrain: () => {}, releaseCallbackDrain: () => {},
        hasInFlightItem: () => false, getPendingCount: () => 0, getRowlessWaitingCount: () => 0, getTransportState: (_key: string, status: string) => status,
      }),
    },
  } as unknown as import("../api.js").ApiContext;
}
