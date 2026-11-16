import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRunOpts, HundredfoldConfig, Session } from "../../../shared/types.js";
import type { TurnInput, TurnPlan } from "../types.js";

// The registry DB is resolved from HUNDREDFOLD_HOME when the module loads, which is before the imports below run.
vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  process.env.HUNDREDFOLD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-pause-turn-"));
});

vi.mock("../../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../claude-auth-watch.js", () => ({ refuseClaudeLaunch: vi.fn(() => undefined) }));
vi.mock("../../../gateway/budgets.js", () => ({ isBudgetExhausted: vi.fn(() => false) }));
vi.mock("../../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/models.js")>()),
  engineAvailable: vi.fn(() => true),
  effortLevelsForModel: vi.fn(() => []),
}));
vi.mock("../../registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../registry.js")>()),
  getMessages: vi.fn(() => []),
}));
vi.mock("../../engine-run-mcp.js", () => ({
  resolveEngineRunMcp: vi.fn(() => ({ mcpConfigPath: undefined, resolvedMcp: { mcpServers: { hundredfold: {} } } })),
}));
const rateLimit = vi.hoisted(() => ({ args: undefined as { prompt: string; retryPrompt?: () => string } | undefined }));
vi.mock("../../rate-limit-handler.js", () => ({
  handleRateLimit: vi.fn(async (args: { prompt: string; retryPrompt?: () => string }) => {
    rateLimit.args = args;
    return { kind: "cancelled" };
  }),
}));

import { preflightTurn } from "../preflight.js";
import { runEngineAttempt } from "../engine-run.js";
import { runRateLimitTurn } from "../rate-limit-turn.js";
import { BOARD_REMINDER_LABEL, DEFAULT_BOARD_REMINDER } from "../board-reminder.js";
import { spawnPrompt } from "../../../engines/claude-interactive.js";
import { buildOpencodePrompt } from "../../../engines/opencode-protocol.js";
import { transcriptEntryText } from "../../../gateway/external-turns.js";
import { stampSessionPause, type PauseKind } from "../../pause-notice.js";
import * as fx from "../../__tests__/pause-notice-fixture.js";

const REMINDER = `${BOARD_REMINDER_LABEL} ${DEFAULT_BOARD_REMINDER}`;
const NOTICE_LABEL = "[Gateway notice] While this session was paused (";
const KINDS: Array<[PauseKind, string]> = [["compaction", "compaction"], ["restart", "gateway restart"], ["usage-limit", "usage limit"]];

function configOf(): HundredfoldConfig {
  return { engines: { default: "claude", claude: {}, codex: {}, opencode: { mode: "server" } } } as unknown as HundredfoldConfig;
}

function turnFor(sessionId: string, prompt: string, engine = "claude"): TurnInput {
  const session = {
    id: sessionId, engine, source: "web", status: "running", attemptToken: "t",
    engineSessions: { [engine]: { id: `${engine}-native-1` } },
  } as unknown as Session;
  return {
    session, attemptToken: "t", prompt, attachments: [], config: configOf(),
    engines: new Map(["claude", "opencode", "codex"].map((e) => [e, {} as never])), gatewayBootId: "boot",
    connectorNames: [], channel: "web", user: "operator",
  } as TurnInput;
}

/** The opts the engine is called with for this turn, as the board-reminder tests capture them. */
async function engineOpts(turn: TurnInput): Promise<EngineRunOpts> {
  const planned = preflightTurn(turn) as TurnPlan;
  expect(planned.ok).toBe(true);
  let seen: EngineRunOpts | undefined;
  const plan: TurnPlan = {
    ...planned,
    engine: { name: turn.session.engine, run: async (opts: EngineRunOpts) => { seen = opts; return { result: "", sessionId: "x" }; } } as never,
    prepareContext: () => ({ fingerprint: "f", refresh: undefined, systemPrompt: "SYSTEM" }),
  };
  await runEngineAttempt({
    input: turn, plan, model: undefined, turnStartedAt: Date.now(),
    surface: {} as never, heartbeat: { beat: vi.fn(), stop: vi.fn() } as never, partialStream: { persist: vi.fn(), finish: vi.fn() } as never,
  });
  return seen!;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A session working a Todo that something else moved to `blocked` after the pause began. */
async function pausedAndMoved(kind: PauseKind, actor = "reconciler"): Promise<{ session: string; todo: string }> {
  const session = fx.newSession();
  const todo = await fx.workedTodo(session);
  stampSessionPause(session, kind);
  await fx.tick();
  fx.move(todo, "blocked", actor);
  return { session, todo };
}

const lineFor = (label: string, todo: string, actor = "reconciler"): string =>
  `${NOTICE_LABEL}${label}), ${todo} moved executing → blocked (by ${actor}). If that is wrong, correct it with update_work_item; otherwise carry on.`;

beforeAll(() => {
  // Make sure the throwaway DB exists before the first stamp.
  fx.newSession();
});

beforeEach(() => {
  rateLimit.args = undefined;
});

describe.each(KINDS)("the engine prompt after a %s pause", (kind, label) => {
  it("carries exactly one notice line, ahead of the board reminder, and the stamp is gone", async () => {
    const { session, todo } = await pausedAndMoved(kind);
    const opts = await engineOpts(turnFor(session, "carry on"));

    expect(opts.prompt).toBe(`carry on\n\n${lineFor(label, todo)}\n\n${REMINDER}`);
    expect(count(opts.prompt, NOTICE_LABEL)).toBe(1);
    expect(fx.stampOf(session)).toBeUndefined();

    const next = await engineOpts(turnFor(session, "and again"));
    expect(next.prompt).toBe(`and again\n\n${REMINDER}`);
  });

  it("reports an operator's move as the operator's", async () => {
    const { session, todo } = await pausedAndMoved(kind, "operator");
    const opts = await engineOpts(turnFor(session, "carry on"));
    expect(opts.prompt).toContain(lineFor(label, todo, "operator"));
  });

  it("carries nothing when the session moved the Todo itself", async () => {
    const { session, todo } = await pausedAndMoved(kind, "reconciler");
    fx.move(todo, "executing", `session:${session}`);
    const opts = await engineOpts(turnFor(session, "carry on"));
    expect(opts.prompt).toBe(`carry on\n\n${REMINDER}`);
    expect(fx.stampOf(session)).toBeUndefined();
  });

  it("carries nothing when the move flapped back", async () => {
    const { session, todo } = await pausedAndMoved(kind);
    fx.move(todo, "executing", "reconciler");
    const opts = await engineOpts(turnFor(session, "carry on"));
    expect(opts.prompt).toBe(`carry on\n\n${REMINDER}`);
  });
});

describe("the engine prompt shape", () => {
  it("claude and opencode both end with the notice then the reminder, once", async () => {
    const first = await pausedAndMoved("compaction");
    const claude = spawnPrompt(await engineOpts(turnFor(first.session, "please look")));
    expect(claude.endsWith(`please look\n\n${lineFor("compaction", first.todo)}\n\n${REMINDER}`)).toBe(true);
    expect(count(claude, NOTICE_LABEL)).toBe(1);

    const second = await pausedAndMoved("compaction");
    const opencode = buildOpencodePrompt(await engineOpts(turnFor(second.session, "please look", "opencode")));
    expect(opencode.endsWith(`please look\n\n${lineFor("compaction", second.todo)}\n\n${REMINDER}`)).toBe(true);
    expect(count(opencode, NOTICE_LABEL)).toBe(1);
  });

  it.each(["/compact", "/compact keep the Todo ids", "/clear", "/code-review high"])(
    "a slash command %j neither carries the notice nor consumes it, so the resume turn after it gets it",
    async (command) => {
      const { session, todo } = await pausedAndMoved("compaction");

      const slash = await engineOpts(turnFor(session, command));
      expect(slash.prompt).toBe(command);
      expect(fx.stampOf(session)).toBeDefined();

      const resume = await engineOpts(turnFor(session, "resume from the handoff"));
      expect(resume.prompt).toBe(`resume from the handoff\n\n${lineFor("compaction", todo)}\n\n${REMINDER}`);
      expect(fx.stampOf(session)).toBeUndefined();
    },
  );

  it("is not written to the planned prompt or the turn's own message", async () => {
    const { session } = await pausedAndMoved("restart");
    const turn = turnFor(session, "carry on");
    const plan = preflightTurn(turn) as TurnPlan;
    expect(plan.pauseNotice).toContain(NOTICE_LABEL);
    expect(plan.promptToRun).toBe("carry on");
    expect(turn.prompt).toBe("carry on");
  });

  it("is stripped from a transcript user entry along with the reminder, so a sync stores what the sender wrote", async () => {
    const { session } = await pausedAndMoved("restart");
    const opts = await engineOpts(turnFor(session, "carry on"));
    expect(opts.prompt).toContain(NOTICE_LABEL);
    const entry = { type: "user", message: { content: [{ type: "text", text: opts.prompt }] } };
    expect(transcriptEntryText(entry)).toEqual({ role: "user", content: "carry on" });
    expect(transcriptEntryText({ type: "user", message: { content: opts.prompt } })).toEqual({ role: "user", content: "carry on" });
  });
});

describe("the usage-limit retry", () => {
  it("takes the notice the wait stamped when the retry fires, and sends the same text on every retry", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    const turn = turnFor(session, "hello");
    const plan = preflightTurn(turn) as TurnPlan;
    await runRateLimitTurn({
      input: turn, plan, surface: {} as never, systemPrompt: "SYSTEM", platformContextRefresh: undefined,
      rateLimit: {} as never, originalResult: {} as never,
    } as never);
    const { prompt, retryPrompt } = rateLimit.args!;
    expect(prompt).toBe(`hello\n\n${REMINDER}`);

    stampSessionPause(session, "usage-limit");
    await fx.tick();
    fx.move(todo, "blocked", "reconciler");

    const retry = retryPrompt!();
    expect(retry).toBe(`hello\n\n${lineFor("usage limit", todo)}\n\n${REMINDER}`);
    expect(fx.stampOf(session)).toBeUndefined();
    expect(retryPrompt!()).toBe(retry);
  });

  it("keeps the notice the turn already carried, and adds what moved during the wait, as one line", async () => {
    const { session, todo } = await pausedAndMoved("restart");
    const turn = turnFor(session, "hello");
    const plan = preflightTurn(turn) as TurnPlan;
    expect(plan.pauseNotice).toBeDefined();
    const other = await fx.workedTodo(session);
    await runRateLimitTurn({
      input: turn, plan, surface: {} as never, systemPrompt: "SYSTEM", platformContextRefresh: undefined,
      rateLimit: {} as never, originalResult: {} as never,
    } as never);
    const { prompt, retryPrompt } = rateLimit.args!;
    expect(prompt).toBe(`hello\n\n${lineFor("gateway restart", todo)}\n\n${REMINDER}`);

    stampSessionPause(session, "usage-limit");
    await fx.tick();
    fx.move(other, "blocked", "operator");

    const retry = retryPrompt!();
    expect(count(retry, NOTICE_LABEL)).toBe(1);
    expect(retry).toContain(`${todo} moved executing → blocked (by reconciler)`);
    expect(retry).toContain(`${other} moved executing → blocked (by operator)`);
    expect(retry).toContain("(gateway restart)");
    expect(retryPrompt!()).toBe(retry);
  });

  it("repeats the notice the turn carried when the wait has nothing of its own", async () => {
    const { session, todo } = await pausedAndMoved("restart");
    const turn = turnFor(session, "hello");
    const plan = preflightTurn(turn) as TurnPlan;
    await runRateLimitTurn({
      input: turn, plan, surface: {} as never, systemPrompt: "SYSTEM", platformContextRefresh: undefined,
      rateLimit: {} as never, originalResult: {} as never,
    } as never);
    const { retryPrompt } = rateLimit.args!;
    expect(retryPrompt!()).toBe(`hello\n\n${lineFor("gateway restart", todo)}\n\n${REMINDER}`);
  });

  it("a hand-back re-run of the turn from preflight still covers the pause the first pass consumed", async () => {
    const { session, todo } = await pausedAndMoved("restart");
    const first = preflightTurn(turnFor(session, "hello")) as TurnPlan;
    expect(first.pauseStamp).toBeDefined();
    expect(fx.stampOf(session)).toBeUndefined();
    const rerun = preflightTurn({ ...turnFor(session, "hello"), carriedPauseStamp: first.pauseStamp }) as TurnPlan;
    expect(rerun.pauseNotice).toBe(lineFor("gateway restart", todo));
  });

  it("does not consume the notice for a slash command", async () => {
    const session = fx.newSession();
    const turn = turnFor(session, "/compact");
    const plan = { ...(preflightTurn(turn) as TurnPlan) };
    stampSessionPause(session, "usage-limit");
    await runRateLimitTurn({
      input: turn, plan, surface: {} as never, systemPrompt: "SYSTEM", platformContextRefresh: undefined,
      rateLimit: {} as never, originalResult: {} as never,
    } as never);
    expect(rateLimit.args!.retryPrompt!()).toBe("/compact");
    expect(fx.stampOf(session)).toBeDefined();
  });
});
