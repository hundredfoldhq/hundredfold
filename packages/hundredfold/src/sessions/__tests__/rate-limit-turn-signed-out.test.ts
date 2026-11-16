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

describe("a refused turn whose walk found a fallback link signed out", () => {
  it("fails with the own target's error and the signed-out link named, in the session's error, the reply and the operator alert", async () => {
    const reply = vi.fn(async (_text: string) => {});
    const hooks = await hooksFor(turnArgs(reply));

    await hooks.onBillingFailure!({ signedOut: [LINK] });

    const error = settleTurn.mock.calls[0]![0].error as string;
    expect(error).toBe(`opencode provider does not serve this model for the account: ${NO_ROUTE}; fallback ${LINK} is signed out: its key or login was rejected and needs replacing`);
    expect(reply.mock.calls[0]![0]).toMatch(new RegExp(`The fallback ${LINK} is signed out: its key or login was rejected and needs replacing\\.$`));
    expect(operator[0]).toContain(`${LINK} is signed out`);
  });

  it("keeps its own wording when no link was signed out", async () => {
    const hooks = await hooksFor(turnArgs());

    await hooks.onBillingFailure!();

    expect(settleTurn.mock.calls[0]![0].error).toBe(`opencode provider does not serve this model for the account: ${NO_ROUTE}`);
  });
});

describe("the wait after a chain that ran out on a signed-out link", () => {
  it("does not say every target is at its limit, and names the link that needs its key replaced", async () => {
    const { chainExhaustedNotice, chainExhaustedLastError } = await import("../fallback-hop.js");
    const exhausted = { tried: [LINK], own: "opencode · opencode-go-b/glm-5.3", signedOut: [LINK] };

    expect(chainExhaustedNotice(exhausted, null)).toBe(
      `⏳ No target in this session's chain could take the turn (tried: ${LINK}). ${LINK.charAt(0).toUpperCase()}${LINK.slice(1)} is signed out: its key or login was rejected and needs replacing. Waiting for opencode · opencode-go-b/glm-5.3 to reset (time unknown).`,
    );
    expect(chainExhaustedNotice({ tried: [LINK], own: exhausted.own }, null)).toMatch(/^⏳ Every target in this session's chain is at its limit/);
    expect(chainExhaustedLastError(exhausted.own, null, [LINK, "opencode · opencode-go-b/kimi-k3"]))
      .toBe(`opencode · opencode-go-b/glm-5.3 usage limit, reset time unknown; ${LINK}, opencode · opencode-go-b/kimi-k3 are signed out: their key or login was rejected and needs replacing`);
  });
});
