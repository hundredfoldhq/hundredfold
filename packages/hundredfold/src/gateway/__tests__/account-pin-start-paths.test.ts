import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import type { HundredfoldConfig, Session } from "../../shared/types.js";
import { baseConfig, call, delegate, home, loadApi, registry, resetFallbackFixture, setConfig, spawn, unloadApi } from "./session-fallback-api-harness.js";

/**
 * Every way a session starts picks its account (docs/design/fallback-account-groups.md, "Every way a session starts"):
 * two accounts with 60 and 40 headroom share ten starts six to four on each path, a session that names a profile
 * is not balanced, and a start that is refused, only validated, or all-exhausted leaves the rotation where it was.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const DIR_A = "/srv/operator/.claude-a";
const KEY_A = `claude:${claudeProfileFromDir(DIR_A).key}`;
const LIMITS_DIR = path.join(home, "tmp", "engine-limits");
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");
const GROUP = { group: [{ engine: "claude" }, { engine: "claude", profile: "A" }] };

let wakeEmployeeOnTodo: typeof import("../todo-employee-session.js").wakeEmployeeOnTodo;
let workItems: typeof import("../../work-items/store.js");
let resetAccountCredits: typeof import("../../shared/fallback-account-pick.js").resetAccountCredits;
let setTodoDispatchConfig: typeof import("../../work-items/dispatch-config.js").setTodoDispatchConfig;

beforeAll(async () => {
  await loadApi();
  ({ wakeEmployeeOnTodo } = await import("../todo-employee-session.js"));
  workItems = await import("../../work-items/store.js");
  ({ resetAccountCredits } = await import("../../shared/fallback-account-pick.js"));
  ({ setTodoDispatchConfig } = await import("../../work-items/dispatch-config.js"));
}, 60_000);
afterAll(unloadApi);

function groupConfig(): HundredfoldConfig {
  return {
    ...baseConfig,
    engines: { ...baseConfig.engines, claude: { bin: "claude", model: "opus", accounts: { A: { configDir: DIR_A } }, fallback: [GROUP, "codex"] } },
  } as unknown as HundredfoldConfig;
}

/** One fresh reading per account: `used` percent in its 5h window. */
function writeUsage(used: Record<string, number>): void {
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600;
  for (const [account, percent] of Object.entries(used)) {
    const file = account === "claude" ? "claude-usage-history.json" : `claude-usage-history.${encodeURIComponent(account)}.json`;
    fs.writeFileSync(path.join(LIMITS_DIR, file), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: percent, resetsAt: later }] }]));
  }
}

beforeEach(() => {
  resetFallbackFixture();
  resetAccountCredits();
  setConfig(groupConfig());
  writeUsage({ claude: 40, [KEY_A]: 60 });
});

/** The account a session runs on: its pinned profile's key, else its employee's own login. */
const accountOf = (session: Session): string => (session.claudeConfigDir ? KEY_A : "claude");
const pickOf = (session: Session) => (session.transportMeta as { accountPick?: { picked: string; reason: string; candidates: Array<{ account: string }> } } | null)?.accountPick;

/** Ten starts through one path, tallied by the account each session was pinned to. */
async function tally(start: (n: number) => Promise<Session>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (let n = 0; n < 10; n++) {
    const session = await start(n);
    expect(pickOf(session)).toMatchObject({ reason: "weighted" });
    expect(pickOf(session)!.picked).toBe(accountOf(session));
    counts[accountOf(session)] = (counts[accountOf(session)] ?? 0) + 1;
  }
  return counts;
}

const SIX_FOUR = { claude: 6, [KEY_A]: 4 };

describe("ten starts at 60/40 headroom through each path", () => {
  it("a Todo wake of an employee", async () => {
    expect(await tally(async (n) => {
      const item = workItems.createWorkItem({ title: `Todo ${n}`, source: "human" });
      const woken = wakeEmployeeOnTodo(context(), {
        workItemId: item.id, employee: { name: "a-worker", engine: "claude", model: "opus", persona: "fixture" } as never,
        role: "execute", actor: "test", title: `Todo ${n}`, sourceAttempt: `wake-${n}`, deliveryKind: "todo_wake", message: "brief", displayMessage: "brief",
      });
      expect(woken.ok).toBe(true);
      return registry.getSession((woken as { session: Session }).session.id)!;
    })).toEqual(SIX_FOUR);
  });

  it("a new chat with no engine named", async () => {
    expect(await tally(async () => {
      const created = await spawn({ employee: "a-worker" });
      expect(created.status).toBe(201);
      return registry.getSession(created.body.id)!;
    })).toEqual(SIX_FOUR);
  });

  it("a new chat naming the claude engine, and one naming nothing but a model", async () => {
    expect(await tally(async (n) => {
      const created = await spawn(n % 2 === 0 ? { employee: "a-worker", engine: "claude" } : { employee: "a-worker", model: "opus" });
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
      const delegated = await delegate({ task: `Delegated brief ${n} with acceptance.` });
      expect(delegated.status).toBe(201);
      return registry.getSession(delegated.body.sessionId)!;
    })).toEqual(SIX_FOUR);
  });

  it("a spawn by another session", async () => {
    const parent = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:parent", model: "opus" });
    const { toolHeaders } = await import("./session-fallback-api-harness.js");
    expect(await tally(async () => {
      const created = await spawn({ employee: "a-worker" }, toolHeaders(parent.id));
      expect(created.status).toBe(201);
      return registry.getSession(created.body.id)!;
    })).toEqual(SIX_FOUR);
  });
});

describe("the system employees' sessions", () => {
  it("a Todo Dispatcher session is pinned and charged like any other start", async () => {
    const counts: Record<string, number> = {};
    for (let n = 0; n < 10; n++) {
      const item = workItems.createWorkItem({ title: `Dispatch ${n}`, source: "human", assignee: "a-worker" });
      const started = await call("POST", `/api/work-items/${item.id}/dispatch`, {});
      expect(started.status).toBeLessThan(300);
      const session = registry.getSession(started.body.sessionId)!;
      expect(pickOf(session)).toMatchObject({ reason: "weighted" });
      counts[accountOf(session)] = (counts[accountOf(session)] ?? 0) + 1;
    }
    expect(counts).toEqual(SIX_FOUR);
  });

  it("a Todo Shaper capture is pinned and charged like any other start", async () => {
    const counts: Record<string, number> = {};
    for (let n = 0; n < 10; n++) {
      const started = await call("POST", "/api/todo-captures", { text: `capture ${n}` });
      expect(started.status).toBe(201);
      const session = registry.getSession(started.body.sessionId)!;
      expect(pickOf(session)).toMatchObject({ reason: "weighted" });
      counts[accountOf(session)] = (counts[accountOf(session)] ?? 0) + 1;
    }
    expect(counts).toEqual(SIX_FOUR);
  });
});

describe("a balanced session", () => {
  it("keeps its account through a reset, a restart and further messages while the readings turn", async () => {
    const created = await spawn({ employee: "a-worker" });
    const session = registry.getSession(created.body.id)!;
    const before = { dir: session.claudeConfigDir, pick: pickOf(session) };
    writeUsage({ claude: 99, [KEY_A]: 1 });
    expect((await call("POST", `/api/sessions/${session.id}/reset`, {})).status).toBe(200);
    registry.updateSession(session.id, { status: "running" });
    registry.recoverStaleSessions();
    for (let n = 0; n < 3; n++) await call("POST", `/api/sessions/${session.id}/message`, { message: `again ${n}` });
    const after = registry.getSession(session.id)!;
    expect({ dir: after.claudeConfigDir, pick: pickOf(after) }).toEqual(before);
  });

  it("carries no usage number in the session body any caller reads: the get, the list and the spawn response", async () => {
    const created = await spawn({ employee: "a-worker" });
    const numbers = /"(weight|sharePercent|headroomPercent|usedPercent|readingAt|tightest)"/;
    expect(JSON.stringify(created.body.transportMeta?.accountPick)).not.toMatch(numbers);
    expect(created.body.transportMeta.accountPick).toMatchObject({ picked: expect.any(String), reason: "weighted" });
    const got = await call("GET", `/api/sessions/${created.body.id}`);
    expect(JSON.stringify(got.body.transportMeta.accountPick)).not.toMatch(numbers);
    // The fallback view is where a caller allowed to see the numbers reads them.
    expect(got.body.fallback.chain.pick.candidates[0]).toHaveProperty("headroomPercent");
    const list = await call("GET", "/api/sessions");
    const listed = (list.body.sessions ?? list.body).find((row: { id: string }) => row.id === created.body.id);
    expect(JSON.stringify(listed.transportMeta.accountPick)).not.toMatch(numbers);
    // The stored row keeps the full record the view is built from.
    expect(pickOf(registry.getSession(created.body.id)!)!.candidates[0]).toHaveProperty("weight");
  });

  it("is shown a department-scoped caller's own pick without any usage number, weight or share", async () => {
    const created = await spawn({ employee: "a-worker" });
    const session = registry.getSession(created.body.id)!;
    const { fallbackViewFor } = await import("../session-fallback-api.js");
    const fullContext = context();
    const full = fallbackViewFor(session, fullContext).chain.pick!;
    expect(full.candidates.every((candidate) => typeof candidate.weight === "number" && typeof candidate.sharePercent === "number")).toBe(true);
    const scoped = fallbackViewFor(session, fullContext, true).chain;
    expect(scoped.pick).toMatchObject({ picked: full.picked, reason: full.reason });
    for (const candidate of scoped.pick!.candidates) expect(Object.keys(candidate).sort()).toEqual(["account", "label", "state"]);
    expect(JSON.stringify(scoped)).not.toMatch(/"(weight|sharePercent|headroomPercent|usedPercent|readingAt|tightest)"/);
  });
});

describe("a session that names a profile", () => {
  it("is pinned there with no pick, and leaves the rotation alone", async () => {
    const created = await spawn({ employee: "a-worker", engine: "claude:A" });
    expect(created.status).toBe(201);
    const session = registry.getSession(created.body.id)!;
    expect(session.claudeConfigDir).toBe(DIR_A);
    expect(pickOf(session)).toBeUndefined();
    const next = await spawn({ employee: "a-worker" });
    expect(pickOf(registry.getSession(next.body.id)!)!.picked).toBe("claude"); // the first start of a fresh rotation
  });

  it("is not balanced when delegated either", async () => {
    const delegated = await delegate({ engine: "claude:A" });
    expect(delegated.status).toBe(201);
    const session = registry.getSession(delegated.body.sessionId)!;
    expect(session.claudeConfigDir).toBe(DIR_A);
    expect(pickOf(session)).toBeUndefined();
  });
});

describe("starts that are not charged", () => {
  const firstPick = async (): Promise<string> => pickOf(registry.getSession((await spawn({ employee: "a-worker" })).body.id)!)!.picked;

  it("a refused start", async () => {
    const refused = await spawn({ employee: "a-worker", model: "no-such-model" });
    expect(refused.status).toBe(400);
    expect((await call("POST", "/api/sessions", { prompt: "" })).status).toBe(400);
    expect(await firstPick()).toBe("claude");
  });

  it("a validation that starts nothing", async () => {
    const item = workItems.createWorkItem({ title: "Override", source: "human" });
    expect(setTodoDispatchConfig(item.id, { engine: "claude", model: "opus" }, groupConfig())).toMatchObject({ ok: true });
    expect(await firstPick()).toBe("claude");
  });

  it("a session that was not created: a delegation into a live session", async () => {
    const item = workItems.createWorkItem({ title: "Reuse", source: "human" });
    const first = await delegate({ workItemId: item.id });
    expect(first.status).toBe(201);
    const picked = pickOf(registry.getSession(first.body.sessionId)!)!.picked;
    // The employee already has a live session on the Todo: the brief lands there and no start is charged.
    const again = await delegate({ workItemId: item.id, task: "A second brief with acceptance." });
    expect(again.body.sessionId).toBe(first.body.sessionId);
    const other = picked === "claude" ? KEY_A : "claude";
    expect(await firstPick()).toBe(other);
  });

  it("an all-exhausted pick", async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({
      claude: { state: "exhausted", until, recheckAt: until }, [KEY_A]: { state: "exhausted", until: new Date(Date.now() + 7200_000).toISOString(), recheckAt: until },
    }));
    const created = await spawn({ employee: "a-worker", engine: "claude" });
    expect(pickOf(registry.getSession(created.body.id)!)).toMatchObject({ reason: "all-exhausted", picked: "claude" });
    fs.rmSync(HEALTH_PATH, { force: true });
    expect(await firstPick()).toBe("claude");
    expect(await firstPick()).toBe(KEY_A);
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
