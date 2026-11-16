import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A turn parked on a usage limit is a pause: the wait stamps it, and the retry
 * after the wait is the same turn resuming, so it takes the notice then.
 */
vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  process.env.HUNDREDFOLD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-rl-pause-"));
});

vi.mock("../../shared/models.js", () => ({
  engineAvailable: vi.fn(() => true),
  effortLevelsForModel: vi.fn(() => ["low", "medium", "high"]),
  getModelRegistry: vi.fn(() => ({})),
  ENGINE_NAMES: ["claude", "codex", "opencode"],
  REMOTE_ENGINE_NAMES: ["claude"],
  engineSupportsRemote: () => false,
  isKnownEngine: (name: string) => ["claude", "codex", "opencode"].includes(name),
}));
vi.mock("../engine-run-mcp.js", () => ({ resolveEngineRunMcp: vi.fn(() => ({})) }));

const waiting = vi.hoisted(() => ({ enters: true }));
vi.mock("../registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../registry.js")>()),
  getSession: vi.fn(() => ({ status: "waiting", engine: "claude", engineSessionId: "claude-thread-1", model: "opus" })),
  updateSessionForAttempt: vi.fn((_id: string, _token: string, updates: { status?: string }) => (
    updates.status === "waiting" && !waiting.enters ? undefined : { status: updates.status ?? "running" }
  )),
  getEngineSessionRef: vi.fn(() => ({})),
  nextEngineSessionFields: vi.fn(() => ({})),
}));
vi.mock("../../shared/usageAwareness.js", () => ({ recordClaudeRateLimit: vi.fn() }));
vi.mock("../../shared/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => Date.now() + 60_000),
  detectRateLimit: vi.fn(() => ({ limited: false })),
  rateLimitEngineLabel: (engine: string) => engine[0]!.toUpperCase() + engine.slice(1),
}));

import { makeSession } from "./helpers/session-fixture.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { takePauseNotice, withPauseNotice } from "../pause-notice.js";
import * as fx from "./pause-notice-fixture.js";
import type { EngineResult, EngineRunOpts } from "../../shared/types.js";

function optsFor(sessionId: string, run: ReturnType<typeof vi.fn>, extra: Partial<RateLimitHandlerOpts> = {}): RateLimitHandlerOpts {
  return {
    session: makeSession({ id: sessionId, engine: "claude", engineSessionId: "claude-thread-1" }),
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "claude", model: "opus" },
    config: { engines: { claude: { bin: "claude", model: "opus" } } } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map(),
    engine: { run } as unknown as RateLimitHandlerOpts["engine"],
    rateLimit: { resetsAt: 1_900_000_000 },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: {},
    ...extra,
  };
}

beforeEach(() => {
  waiting.enters = true;
});

describe("the usage-limit wait", () => {
  it("stamps a usage-limit pause as it starts waiting, and the retry carries what moved meanwhile", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    let stampedWhenWaitBegan: unknown;
    const run = vi.fn(async (_o: EngineRunOpts) => ({ result: "ok", sessionId: "claude-thread-1" }) as EngineResult);

    const outcome = await handleRateLimit(optsFor(session, run, {
      retryPrompt: () => withPauseNotice("hello", takePauseNotice(session)),
      hooks: {
        onWaitingStart: async () => {
          stampedWhenWaitBegan = fx.stampOf(session);
          await fx.tick();
          fx.move(todo, "blocked", "reconciler");
        },
      },
    }));

    expect(outcome.kind).toBe("resumed");
    expect(stampedWhenWaitBegan).toMatchObject({ kind: "usage-limit" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].prompt).toBe(
      `hello\n\n[Gateway notice] While this session was paused (usage limit), ${todo} moved executing → blocked (by reconciler). `
      + "If that is wrong, correct it with update_work_item; otherwise carry on.",
    );
    expect(fx.stampOf(session)).toBeUndefined();
  });

  it("sends the plain prompt on the retry when the caller gives no retry prompt", async () => {
    const session = fx.newSession();
    const run = vi.fn(async (_o: EngineRunOpts) => ({ result: "ok", sessionId: "claude-thread-1" }) as EngineResult);
    await handleRateLimit(optsFor(session, run));
    expect(run.mock.calls[0]![0].prompt).toBe("hello");
  });

  it("stamps nothing when the session cannot enter the wait (stopped meanwhile)", async () => {
    const session = fx.newSession();
    waiting.enters = false;
    const run = vi.fn();
    const outcome = await handleRateLimit(optsFor(session, run));
    expect(outcome.kind).toBe("cancelled");
    expect(fx.stampOf(session)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});
