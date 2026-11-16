import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, Engine } from "../../shared/types.js";
import { answer, config, failed, handleRateLimit, hopsOf, key, limitedTurn, newSession, overrideOf, readEngineHealth, scripted, tmp, useWalkHarness } from "./fallback-walk-harness.js";
import { recordOpencodeFailure } from "../../shared/engine-health-opencode.js";
import { isLinkExhausted } from "../../shared/fallback-chain-health.js";

/** An opencode provider that cannot serve the turn is told apart by what it said (docs/engines-opencode.md): a spent allowance holds the provider out, a dead key holds it out as signed out, a model the account cannot use holds that model alone. */

useWalkHarness();

// A dead key's credential is read from opencode's own database; these turns must never read the machine's real one.
beforeEach(() => {
  const data = path.join(tmp, "xdg-data");
  fs.mkdirSync(data, { recursive: true });
  vi.stubEnv("XDG_DATA_HOME", data);
  return () => vi.unstubAllEnvs();
});

const GO = { engine: "opencode", model: "opencode-go/x" };
const GO_B = { engine: "opencode", model: "opencode-go-b/x" };
const ROUTER = { engine: "opencode", model: "openrouter/x" };
const FUNDS = "provider.quota: Insufficient account funds (HTTP 402)";
const BALANCE = "provider.quota: Insufficient balance. Top up at https://opencode.ai/console/wrk_1/billing?credits=1. (HTTP 402)";
const EXPIRED = "provider.auth: This API key has expired. Create a new API key in OpenCode Console. (HTTP 401)";
const NO_ACCESS = "provider.auth: Upstream request failed: Model access is disabled (HTTP 403)";
const NO_ROUTE = "provider.no-route: Model unavailable: opencode-go/x";
const MIN = 60_000;

const worker = (): Employee => ({ name: "worker-oc", engine: "opencode", model: GO.model, fallback: [GO_B, ROUTER] }) as Employee;

/** The turn of a session whose own provider answered `error`, as the runner hands it to the handler. */
function turnFailing(error: string, engines: Map<string, Engine>, rateLimit: Record<string, unknown>) {
  const id = newSession({ ref: "web:oc", engine: "opencode", model: GO.model, employeeName: "worker-oc" });
  const turn = limitedTurn(id, worker(), engines);
  const onBillingFailure = vi.fn();
  const opts = { ...turn.opts, rateLimit, originalResult: failed(error), hooks: { ...turn.opts.hooks, onBillingFailure } };
  return { id, opts: opts as typeof turn.opts, seen: turn.seen, onBillingFailure };
}

describe("a subscription's spent allowance (402)", () => {
  it.each([FUNDS, BALANCE])("hops the turn and holds the provider out for the re-probe interval: %s", async (error) => {
    const { engines, calls } = scripted((call) => answer(`served by ${call.model}`));
    const { id, opts } = turnFailing(error, engines, { billing: true });
    const before = Date.now();

    const outcome = await handleRateLimit(opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "served by opencode-go-b/x" } });
    expect(calls.map((call) => call.model)).toEqual(["opencode-go-b/x"]);
    const held = readEngineHealth()["opencode/opencode-go"]!;
    expect(held).toMatchObject({ state: "exhausted", failureClass: "quota" });
    expect(Date.parse(held.until!) - before).toBeGreaterThanOrEqual(59 * MIN);
    expect(Date.parse(held.until!) - before).toBeLessThanOrEqual(61 * MIN);
    expect(hopsOf(id).map((hop) => [hop.to, hop.reason])).toContainEqual([key(GO_B), "billing"]);
    // The session stands in for the provider until it is next tried, not for the six hours an unstated limit gets.
    expect(Date.parse(String(overrideOf(id)?.until)) - before).toBeLessThanOrEqual(61 * MIN);
  });

  it("is passed over by the next walk without sending it a request, and the next link serves", async () => {
    // opencode-go-b is a subscription too, and already spent: only the third link is asked.
    recordOpencodeFailure({ healthKey: "opencode/opencode-go-b", model: GO_B.model, error: FUNDS, config: { engines: { opencode: { subscriptionProviders: ["opencode-go", "opencode-go-b"] } } } as never });
    const { engines, calls } = scripted((call) => answer(`served by ${call.model}`));
    const { opts } = turnFailing(FUNDS, engines, { billing: true });

    const outcome = await handleRateLimit(opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "served by openrouter/x" } });
    expect(calls.map((call) => call.model)).toEqual(["openrouter/x"]);
    expect(isLinkExhausted(readEngineHealth(), { ...GO, account: "opencode" })).toBe(true);
    expect(isLinkExhausted(readEngineHealth(), { ...GO_B, account: "opencode" })).toBe(true);
    expect(isLinkExhausted(readEngineHealth(), { ...ROUTER, account: "opencode" })).toBe(false);
  });

  it("is not held for a provider that is not a subscription: its billing handling stays", async () => {
    const { engines } = scripted((call) => answer(`served by ${call.model}`));
    const id = newSession({ ref: "web:oc", engine: "opencode", model: ROUTER.model, employeeName: "worker-oc" });
    const turn = limitedTurn(id, { ...worker(), model: ROUTER.model, fallback: [GO_B] } as Employee, engines);
    await handleRateLimit({ ...turn.opts, rateLimit: { billing: true }, originalResult: failed(FUNDS) } as typeof turn.opts);

    expect(readEngineHealth()["opencode/openrouter"]).toMatchObject({ state: "degraded" });
    expect(readEngineHealth()["opencode/openrouter"]?.failureClass).toBeUndefined();
  });

  it("fails the turn, rather than waiting, when no link can serve it", async () => {
    const { engines } = scripted((call) => failed(call.model === GO_B.model || call.model === ROUTER.model ? FUNDS : "unused"));
    const { opts, onBillingFailure } = turnFailing(FUNDS, engines, { billing: true });

    expect(await handleRateLimit(opts)).toMatchObject({ kind: "billing" });
    expect(onBillingFailure).toHaveBeenCalledOnce();
  });
});

describe("an expired key (401)", () => {
  it("hops the turn and records the provider as signed out", async () => {
    const { engines, calls } = scripted((call) => answer(`served by ${call.model}`));
    const { id, opts } = turnFailing(EXPIRED, engines, { refused: "auth" });

    const outcome = await handleRateLimit(opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "served by opencode-go-b/x" } });
    expect(calls).toHaveLength(1);
    expect(readEngineHealth()["opencode/opencode-go"]).toMatchObject({ state: "exhausted", failureClass: "auth" });
    expect(readEngineHealth()["opencode/opencode-go/x"]).toBeUndefined();
    expect(hopsOf(id).map((hop) => [hop.to, hop.reason])).toContainEqual([key(GO_B), "auth"]);
  });

  it("never parks a session on a key nothing will renew: with no link left the turn fails", async () => {
    const { engines } = scripted(() => failed(EXPIRED));
    const { opts, onBillingFailure } = turnFailing(EXPIRED, engines, { refused: "auth" });

    expect(await handleRateLimit(opts)).toMatchObject({ kind: "billing" });
    expect(onBillingFailure).toHaveBeenCalledOnce();
  });

  it("is told apart by a hop that fails the same way: the link's own provider is held out too", async () => {
    const { engines } = scripted((call) => (call.model === GO_B.model ? failed(EXPIRED) : answer(`served by ${call.model}`)));
    const { id, opts } = turnFailing(EXPIRED, engines, { refused: "auth" });

    expect(await handleRateLimit(opts)).toMatchObject({ kind: "fallback", result: { result: "served by openrouter/x" } });
    expect(readEngineHealth()["opencode/opencode-go-b"]).toMatchObject({ state: "exhausted", failureClass: "auth" });
    expect(hopsOf(id).map((hop) => hop.reason)).toContain("auth");
  });
});

describe("an expired key on a chain with several models of one provider", () => {
  const GO_Y = { engine: "opencode", model: "opencode-go/y" };
  const GO_Z = { engine: "opencode", model: "opencode-go/z" };
  const onOneProvider = (fallback: object[]) => ({ name: "worker-oc", engine: "opencode", model: GO.model, fallback }) as Employee;
  function turnOn(error: string, employee: Employee, engines: Map<string, Engine>, rateLimit: Record<string, unknown>) {
    const id = newSession({ ref: "web:oc", engine: "opencode", model: GO.model, employeeName: "worker-oc" });
    const turn = limitedTurn(id, employee, engines);
    const opts = { ...turn.opts, rateLimit, originalResult: failed(error), hooks: { ...turn.opts.hooks, onBillingFailure: vi.fn() } };
    return { id, opts: opts as typeof turn.opts };
  }

  it("sends no request to the provider's other models and fails the turn", async () => {
    const { engines, calls } = scripted(() => failed(EXPIRED));
    const { id, opts } = turnOn(EXPIRED, onOneProvider([GO_Y, GO_Z]), engines, { refused: "auth" });

    expect(await handleRateLimit(opts)).toMatchObject({ kind: "billing" });
    expect(calls).toEqual([]);
    // Nothing was tried, so no run began: as with a chain whose links are all ruled out for the session.
    expect(hopsOf(id)).toEqual([]);
  });

  it("goes straight to the next provider", async () => {
    const { engines, calls } = scripted((call) => answer(`served by ${call.model}`));
    const { id, opts } = turnOn(EXPIRED, onOneProvider([GO_Y, GO_Z, ROUTER]), engines, { refused: "auth" });

    expect(await handleRateLimit(opts)).toMatchObject({ kind: "fallback", result: { result: "served by openrouter/x" } });
    expect(calls.map((call) => call.model)).toEqual([ROUTER.model]);
    expect(hopsOf(id)[0]).toMatchObject({ to: key(ROUTER), skipped: [{ key: key(GO_Y), reason: "signed-out" }, { key: key(GO_Z), reason: "signed-out" }] });
  });

  it("stops at one failing request when a fallback link's provider turns out dead too", async () => {
    // The own provider is spent (402), the link's key is dead: its second model is never asked.
    const GO_B_Y = { engine: "opencode", model: "opencode-go-b/y" };
    const { engines, calls } = scripted((call) => (call.model?.startsWith("opencode-go-b/") ? failed(EXPIRED) : answer(`served by ${call.model}`)));
    const { opts } = turnOn(FUNDS, onOneProvider([GO_B, GO_B_Y, ROUTER]), engines, { billing: true });

    expect(await handleRateLimit(opts)).toMatchObject({ kind: "fallback", result: { result: "served by openrouter/x" } });
    expect(calls.map((call) => call.model)).toEqual([GO_B.model, ROUTER.model]);
  });

  it("names the dead provider's untried models in the hop that records the chain ran out", async () => {
    const GO_B_Y = { engine: "opencode", model: "opencode-go-b/y" };
    const { engines, calls } = scripted(() => failed(EXPIRED));
    const { id, opts } = turnOn(FUNDS, onOneProvider([GO_B, GO_B_Y]), engines, { billing: true });

    await handleRateLimit(opts);

    expect(calls.map((call) => call.model)).toEqual([GO_B.model]);
    // Newest first: the hop that ran out.
    expect(hopsOf(id)[0]).toMatchObject({ to: null, reason: "auth", skipped: [{ key: key(GO_B_Y), reason: "signed-out" }] });
  });

  it("still tries the provider's other models when the refusal was one model's (403)", async () => {
    const { engines, calls } = scripted((call) => answer(`served by ${call.model}`));
    const { opts } = turnOn(NO_ACCESS, onOneProvider([GO_Y, ROUTER]), engines, { refused: "model-access" });

    expect(await handleRateLimit(opts)).toMatchObject({ kind: "fallback", result: { result: "served by opencode-go/y" } });
    expect(calls.map((call) => call.model)).toEqual([GO_Y.model]);
  });
});

describe("a model the account cannot use (403)", () => {
  it("hops the turn and holds that model out, not the provider", async () => {
    const { engines, calls } = scripted((call) => answer(`served by ${call.model}`));
    const { id, opts } = turnFailing(NO_ACCESS, engines, { refused: "model-access" });

    const outcome = await handleRateLimit(opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "served by opencode-go-b/x" } });
    expect(calls).toHaveLength(1);
    const health = readEngineHealth();
    expect(health["opencode/opencode-go"]).toBeUndefined();
    expect(health["opencode/opencode-go/x"]).toMatchObject({ state: "exhausted", failureClass: "model-access" });
    expect(isLinkExhausted(health, { engine: "opencode", model: "opencode-go/x", account: "opencode" })).toBe(true);
    expect(isLinkExhausted(health, { engine: "opencode", model: "opencode-go/y", account: "opencode" })).toBe(false);
    expect(hopsOf(id).map((hop) => [hop.to, hop.reason])).toContainEqual([key(GO_B), "invalid-model"]);
  });
});

describe("a model the provider has no route to (provider.no-route)", () => {
  it("is read from the failed turn as a refusal, then hops the turn and holds that model out, not the provider", async () => {
    const { detectRateLimit } = await import("../../shared/rateLimit.js");
    const detected = detectRateLimit(failed(NO_ROUTE) as never);
    expect(detected).toMatchObject({ limited: true, refused: "model-access" });
    const { engines, calls } = scripted((call) => answer(`served by ${call.model}`));
    const { id, opts } = turnFailing(NO_ROUTE, engines, { refused: detected.refused });

    const outcome = await handleRateLimit(opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "served by opencode-go-b/x" } });
    expect(calls.map((call) => call.model)).toEqual(["opencode-go-b/x"]);
    const health = readEngineHealth();
    expect(health["opencode/opencode-go"]).toBeUndefined();
    expect(health["opencode/opencode-go/x"]).toMatchObject({ state: "exhausted", failureClass: "model-access" });
    expect(hopsOf(id).map((hop) => [hop.to, hop.reason])).toContainEqual([key(GO_B), "invalid-model"]);
  });

  it("walks on past a second link with no route and lands on the third", async () => {
    const { engines, calls } = scripted((call) => (call.model === "openrouter/x" ? answer("served by openrouter/x") : failed(NO_ROUTE.replace("opencode-go/x", String(call.model)))));
    const { id, opts } = turnFailing(NO_ROUTE, engines, { refused: "model-access" });

    const outcome = await handleRateLimit(opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "served by openrouter/x" } });
    expect(calls.map((call) => call.model)).toEqual(["opencode-go-b/x", "openrouter/x"]);
    expect(hopsOf(id).map((hop) => hop.to)).toContain(key(ROUTER));
    // The next walk, as a "carry on" starts one, does not send the dead models a request again.
    const health = readEngineHealth();
    expect(isLinkExhausted(health, { ...GO, account: "opencode" })).toBe(true);
    expect(isLinkExhausted(health, { ...GO_B, account: "opencode" })).toBe(true);
    expect(isLinkExhausted(health, { ...ROUTER, account: "opencode" })).toBe(false);
  });
});

describe("an account model this host's opencode cannot serve (OpenCode 1.x)", () => {
  it("hops the own turn to the next link and holds that model alone", async () => {
    const { unservedModelError } = await import("../../shared/opencode-accounts.js");
    const { detectRateLimit } = await import("../../shared/rateLimit.js");
    const error = unservedModelError(GO.model, "go");
    const detected = detectRateLimit(failed(error) as never);
    expect(detected).toMatchObject({ limited: true, refused: "model-access" });
    const { engines, calls } = scripted((call) => answer(`served by ${call.model}`));
    const { id, opts } = turnFailing(error, engines, { refused: detected.refused });

    const outcome = await handleRateLimit(opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "served by opencode-go-b/x" } });
    expect(calls.map((call) => call.model)).toEqual(["opencode-go-b/x"]);
    const health = readEngineHealth();
    expect(health["opencode/opencode-go"]).toBeUndefined();
    expect(health["opencode/opencode-go/x"]).toMatchObject({ state: "exhausted", failureClass: "model-access" });
    expect(hopsOf(id).map((hop) => [hop.to, hop.reason])).toContainEqual([key(GO_B), "invalid-model"]);
  });
});

// Keep the shared config in view: the default subscription list is what makes opencode-go one here.
expect(config.engines.opencode).toEqual({ bin: "opencode" });
