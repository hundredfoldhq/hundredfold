import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "../../gateway/__tests__/department-fixtures.js";
import { refreshOrg } from "../../gateway/org-registry.js";
import type { Employee, EngineResult, EngineRunOpts, HundredfoldConfig } from "../../shared/types.js";
import { buildResumeMessage } from "../self-compaction.js";
import { preflightTurn, resolveTurnHierarchy } from "../turn/preflight.js";
import { runEngineAttempt } from "../turn/engine-run.js";
import type { TurnInput, TurnPlan } from "../turn/types.js";
import { makeSession } from "./helpers/session-fixture.js";

/**
 * A session that compacts must come back under the instructions it started
 * with. Both engines already keep them across a compaction, each its own way:
 * Claude Code holds the system prompt outside the conversation (it is given at
 * spawn) and reads the working directory's CLAUDE.md again; an opencode server
 * session re-seeds the system prompt itself (see the engine tests). Either way
 * the engine is handed the system prompt, so this pins the part that belongs to
 * the gateway: the compaction turn and the resume turn that follows it are given
 * exactly the system prompt a cold start of the same session gets, with the
 * persona and a scoped session's department scope in it, and the resume
 * message carries the handoff verbatim and no second copy of the instructions.
 */

// A scoped turn is refused unless a Claude that can skip the root instructions
// is installed; that gate is not what this suite is about.
vi.mock("../turn/scoped-turn.js", () => ({ refuseScopedTurn: vi.fn(() => undefined) }));
vi.mock("../claude-auth-watch.js", () => ({ refuseClaudeLaunch: vi.fn(() => undefined) }));
vi.mock("../availability-registry.js", () => ({ engineInstalledWhereRun: vi.fn(() => true) }));
vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const SCOPED_SLUG = "compaction-context-dept";
const PERSONA_FACT = "The harbour password is KESTREL-17.";
const HANDOFF = { goal: "ship the fix", done: "wrote the test", next: "run the suite", context: "branch fix/example" };

const config = {
  gateway: { port: 7777, host: "127.0.0.1" },
  engines: { default: "claude", claude: {}, opencode: { mode: "server" } },
  logging: { level: "info" },
} as unknown as HundredfoldConfig;

function employee(name: string, engine: string): Employee {
  return { name, engine, persona: PERSONA_FACT, rank: "employee" } as unknown as Employee;
}

async function turnInput(engine: string, subject: { name: string; scoped: boolean }, prompt: string, resumed: boolean): Promise<TurnInput> {
  const session = makeSession({
    id: "sess-compaction-context",
    engine,
    engineSessionId: null,
    employee: subject.name,
    ...(subject.scoped ? { scopeDepartment: SCOPED_SLUG } : {}),
    engineSessions: resumed ? { [engine]: { id: `${engine}-native-1` } } : {},
  } as never);
  const roster = await resolveTurnHierarchy(config);
  return {
    session, attemptToken: "t", prompt, attachments: [], config,
    employee: employee(subject.name, engine),
    engines: new Map([[engine, {} as never]]), gatewayBootId: "boot", connectorNames: [],
    channel: "web", user: "operator", roster,
  } as unknown as TurnInput;
}

/** What the engine is handed for one turn: the opts `engine.run` receives. */
async function engineSees(engine: string, subject: { name: string; scoped: boolean }, prompt: string, resumed: boolean): Promise<EngineRunOpts> {
  const input = await turnInput(engine, subject, prompt, resumed);
  const plan = preflightTurn(input) as TurnPlan;
  expect(plan.ok).toBe(true);
  const run = vi.fn(async (_opts: EngineRunOpts) => ({ result: "ok", sessionId: "native" }) as EngineResult);
  await runEngineAttempt({
    input,
    plan: { ...plan, engine: { run } as never },
    surface: {} as never,
    heartbeat: { beat() {} } as never,
    partialStream: { finish() {}, persist() {} } as never,
    turnStartedAt: Date.now(),
    model: undefined,
  });
  return run.mock.calls[0]![0];
}

beforeEach(() => {
  resetDepartmentFixtures();
  writeDepartmentFile(SCOPED_SLUG, `name: ${SCOPED_SLUG}\nscope: scoped\n`);
  writeEmployeeFile(SCOPED_SLUG, "scoped-dev", { persona: PERSONA_FACT });
  writeEmployeeFile("general", "plain-dev", { persona: PERSONA_FACT });
  refreshOrg();
});

const CASES = [
  { engine: "claude", name: "plain-dev", scoped: false, label: "a Claude session" },
  { engine: "opencode", name: "plain-dev", scoped: false, label: "an opencode server session" },
  { engine: "claude", name: "scoped-dev", scoped: true, label: "a department-scoped Claude session" },
] as const;

describe.each(CASES)("the turns after a compaction of $label", ({ engine, name, scoped }) => {
  const subject = { name, scoped };

  it("gives the engine the system prompt a cold start gets, persona and scope included", async () => {
    const cold = await engineSees(engine, subject, "first message", false);
    expect(cold.resumeSessionId).toBeUndefined();
    expect(cold.systemPrompt).toContain(PERSONA_FACT);
    if (scoped) expect(cold.systemPrompt).toContain(`This session is scoped to department **${SCOPED_SLUG}**`);
    else expect(cold.systemPrompt).not.toContain("This session is scoped to department");

    const compaction = await engineSees(engine, subject, "/compact", true);
    expect(compaction.resumeSessionId).toBe(`${engine}-native-1`);
    expect(compaction.prompt).toBe("/compact");
    expect(compaction.systemPrompt).toBe(cold.systemPrompt);

    const resume = await engineSees(engine, subject, buildResumeMessage(HANDOFF), true);
    expect(resume.resumeSessionId).toBe(`${engine}-native-1`);
    expect(resume.systemPrompt).toBe(cold.systemPrompt);
  });

  it("carries the handoff verbatim in the resume turn and no second copy of the instructions", async () => {
    const resume = await engineSees(engine, subject, buildResumeMessage(HANDOFF), true);
    for (const value of Object.values(HANDOFF)) expect(resume.prompt).toContain(value);
    // The instructions travel in the system prompt, once; a copy in the message would be paid for again every turn.
    expect(resume.prompt).not.toContain(PERSONA_FACT);
    expect(resume.prompt).not.toContain("## Department scope");
  });
});
