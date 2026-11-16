import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A refused own target (a dead key, a model with no route, a spent balance) fails the turn rather
 * than waiting. When the walk found a fallback link signed out on the way, the failure says so:
 * the session's error and the reply name that link, so the operator knows its key needs replacing
 * and is not left with the own target's first error alone.
 */

const handleRateLimit = vi.fn(async (_opts: RateLimitHandlerOpts) => ({ kind: "billing" }) as RateLimitOutcome);
vi.mock("../rate-limit-handler.js", () => ({ handleRateLimit: (opts: RateLimitHandlerOpts) => handleRateLimit(opts) }));

const settleTurn = vi.fn(async (_input: Record<string, unknown>) => undefined);
vi.mock("../turn/completion.js", () => ({ settleTurn: (input: Record<string, unknown>) => settleTurn(input) }));

const operator: string[] = [];
vi.mock("../callbacks.js", () => ({
  notifyOperatorChannel: (message: string) => { operator.push(message); },
  notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(),
}));

import { runRateLimitTurn, type RateLimitTurnArgs } from "../turn/rate-limit-turn.js";
import type { RateLimitHandlerHooks, RateLimitHandlerOpts, RateLimitOutcome } from "../rate-limit-contract.js";
import { makeSession } from "./helpers/session-fixture.js";

const NO_ROUTE = "provider.no-route: Model unavailable: opencode-go-b/glm-5.3";
const LINK = "opencode · opencode-go-b/mimo-v2.6-pro";

function turnArgs(reply = vi.fn(async (_text: string) => {})): RateLimitTurnArgs {
  return {
    input: { session: makeSession({ engine: "opencode", status: "running" }), employee: undefined, attachments: [], attemptToken: "attempt-1", prompt: "carry on", config: {}, engines: new Map() },
    plan: { engineName: "opencode", engineConfig: {}, engine: {}, model: "opencode-go-b/glm-5.3" },
    surface: { notice: vi.fn(async () => {}), reply, waiting: vi.fn(async () => {}), delta: vi.fn(), started: vi.fn(async () => {}) },
    systemPrompt: "",
    platformContextFingerprint: "fp",
    rateLimit: { refused: "model-access" },
    originalResult: { result: "", sessionId: "", error: NO_ROUTE },
    terminalFields: () => ({}),
  } as unknown as RateLimitTurnArgs;
}

async function hooksFor(args: RateLimitTurnArgs): Promise<RateLimitHandlerHooks> {
  await runRateLimitTurn(args);
  return handleRateLimit.mock.calls.at(-1)![0].hooks;
}

beforeEach(() => {
  vi.clearAllMocks();
  operator.length = 0;
});

const LINK_2 = "opencode · opencode-go-b/kimi-k3";

describe("a refused turn whose walk found a fallback link signed out", () => {
  it("fails with the own target's error and the signed-out link named, in the session's error, the reply and the operator alert", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const hooks = await hooksFor(turnArgs(reply));

    await hooks.onBillingFailure!({ signedOut: [LINK] });

    const error = settleTurn.mock.calls[0]![0].error as string;
    expect(error).toBe(`opencode provider does not serve this model for the account: ${NO_ROUTE}; fallback ${LINK} is signed out: its key or login needs replacing`);
    expect(reply.mock.calls[0]![0]).toBe(
      `The provider does not serve this model for the account and no fallback could serve this turn: the fallback ${LINK} is signed out: its key or login needs replacing. Enable the model or pick another, or replace its key, then try again.`,
    );
    expect(operator[0]).toContain(`fallback ${LINK} is signed out`);
  });

  it("speaks of several links in the plural", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const hooks = await hooksFor(turnArgs(reply));

    await hooks.onBillingFailure!({ signedOut: [LINK, LINK_2] });

    expect(settleTurn.mock.calls[0]![0].error).toMatch(new RegExp(`; fallbacks ${LINK}, ${LINK_2} are signed out: their key or login needs replacing$`));
    expect(reply.mock.calls[0]![0]).toMatch(/, or replace their keys, then try again\.$/);
  });

  it("keeps its own wording when no link was signed out", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const hooks = await hooksFor(turnArgs(reply));

    await hooks.onBillingFailure!();

    expect(settleTurn.mock.calls[0]![0].error).toBe(`opencode provider does not serve this model for the account: ${NO_ROUTE}`);
    expect(reply.mock.calls[0]![0]).toBe("The provider does not serve this model for the account and no fallback could serve this turn. Enable the model or pick another, then try again.");
  });
});

describe("a wait whose chain has a signed-out link", () => {
  function waitingSurface() {
    const notice = vi.fn(async (_text: string, _meta?: unknown) => {});
    const args = turnArgs();
    (args.surface as unknown as { notice: typeof notice }).notice = notice;
    return { args, notice };
  }

  it("names the link in the operator alert and the notice, whether or not a run ran out", async () => {
    const { args, notice } = waitingSurface();
    const hooks = await hooksFor(args);

    await hooks.onWaitingStart!({ resumeAt: null, rateLimit: {}, signedOut: [LINK] });

    expect(operator[0]).toMatch(new RegExp(`paused\\. Fallback ${LINK} is signed out: its key or login needs replacing\\.$`));
    expect(notice.mock.calls[0]![0]).toBe(`⏳ opencode usage limit reached. Fallback ${LINK} is signed out: its key or login needs replacing. I'll continue automatically.`);
  });

  it("keeps its old wording without one", async () => {
    const { args, notice } = waitingSurface();
    const hooks = await hooksFor(args);

    await hooks.onWaitingStart!({ resumeAt: null, rateLimit: {} });
    await hooks.onWaitingStart!({ resumeAt: null, rateLimit: {}, reason: "the chosen fallback is limited too" });

    expect(operator[0]).toMatch(/paused\.$/);
    expect(notice.mock.calls.map((call) => call[0])).toEqual([
      "⏳ opencode usage limit reached — I'll continue automatically.",
      "⏳ opencode usage limit reached. Not switching: the chosen fallback is limited too. I'll continue automatically.",
    ]);
  });
});

describe("the wait after a chain that ran out on a signed-out link", () => {
  it("does not say every target is at its limit, and names the link that needs its key replaced", async () => {
    const { chainExhaustedNotice, chainExhaustedLastError } = await import("../fallback-hop.js");
    const exhausted = { tried: [LINK], own: "opencode · opencode-go-b/glm-5.3" };

    expect(chainExhaustedNotice(exhausted, null, [LINK])).toBe(
      `⏳ No target in this session's chain could take the turn (tried: ${LINK}). Fallback ${LINK} is signed out: its key or login needs replacing. Waiting for opencode · opencode-go-b/glm-5.3 to reset (time unknown).`,
    );
    expect(chainExhaustedNotice(exhausted, null)).toMatch(/^⏳ Every target in this session's chain is at its limit/);
    expect(chainExhaustedLastError(exhausted.own, null, [LINK, LINK_2]))
      .toBe(`opencode · opencode-go-b/glm-5.3 usage limit, reset time unknown; fallbacks ${LINK}, ${LINK_2} are signed out: their key or login needs replacing`);
  });
});
