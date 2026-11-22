import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGoUsage, forgetGoUsageCacheForTest, GO_USAGE_FAILURE_TTL_MS, GO_USAGE_TTL_MS, parseGoUsage, readGoUsage,
} from "../opencode-go-usage.js";

const KEY = "test-key-0123456789abcdef";
const BODY = {
  usage: {
    rolling: { status: "ok", percent: 30, resetsAt: "2026-11-22T17:00:00Z" },
    weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-27T00:00:00Z" },
    monthly: { status: "ok", percent: 50, resetsAt: "2026-12-01T00:00:00Z" },
  },
};

function reply(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

beforeEach(() => forgetGoUsageCacheForTest());
afterEach(() => vi.restoreAllMocks());

describe("parseGoUsage", () => {
  it("maps the three meters to 5h, 7d and 30d with the provider's percentages, resets and rate-limited flag", () => {
    expect(parseGoUsage(BODY)).toEqual([
      { name: "5h", usedPercent: 30, windowDurationMins: 300, resetsAt: Date.parse("2026-11-22T17:00:00Z") / 1000, resetsAtIso: "2026-11-22T17:00:00.000Z" },
      { name: "7d", usedPercent: 100, windowDurationMins: 10_080, resetsAt: Date.parse("2026-11-27T00:00:00Z") / 1000, resetsAtIso: "2026-11-27T00:00:00.000Z", limited: true },
      { name: "30d", usedPercent: 50, windowDurationMins: 43_200, resetsAt: Date.parse("2026-12-01T00:00:00Z") / 1000, resetsAtIso: "2026-12-01T00:00:00.000Z" },
    ]);
  });

  it("leaves out a meter that carries no usable percentage instead of inventing a zero", () => {
    const windows = parseGoUsage({ usage: { rolling: { status: "ok" }, weekly: { percent: "40" }, monthly: { percent: 140 } } });
    expect(windows).toBeUndefined();
    const some = parseGoUsage({ usage: { rolling: { status: "ok" }, monthly: { percent: 12 } } });
    expect(some?.map((w) => w.name)).toEqual(["30d"]);
  });

  it("keeps a window with an unreadable reset, without a reset", () => {
    const [window] = parseGoUsage({ usage: { rolling: { percent: 5, resetsAt: "soon" } } })!;
    expect(window).toMatchObject({ name: "5h", usedPercent: 5 });
    expect(window).not.toHaveProperty("resetsAt");
  });

  it("rejects bodies of the wrong shape", () => {
    for (const body of [undefined, null, "x", [], {}, { usage: null }, { usage: [] }, { usage: {} }]) expect(parseGoUsage(body)).toBeUndefined();
  });
});

describe("fetchGoUsage", () => {
  it("asks the usage endpoint with the key as a bearer token and returns the provider's windows", async () => {
    const fetchImpl = reply(200, BODY);
    const usage = await fetchGoUsage(KEY, { fetchImpl, now: new Date("2026-11-22T12:00:00Z") });
    expect(usage).toMatchObject({ status: "ok", source: "OpenCode Go usage API", fetchedAt: "2026-11-22T12:00:00.000Z" });
    expect(usage.windows).toHaveLength(3);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe("https://opencode.ai/inference/go/v1/usage");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect((init as RequestInit).redirect).toBe("error");
    // A request with no recognisable client is refused at the provider's edge and would read as an outage.
    expect((init as RequestInit).headers).toMatchObject({ "User-Agent": expect.stringMatching(/\S/) });
  });

  it.each([
    [401, { error: { type: "authentication_error", code: "api_key_expired", message: "expired" } }, "key-expired"],
    [401, { type: "error", error: { type: "AuthError", message: "bad key" } }, "unauthorized"],
    [403, { type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } }, "no-subscription"],
    [403, "region blocked", "forbidden"],
    [429, {}, "rate-limited"],
    [500, {}, "http-error"],
  ])("answers %i as unavailable (%s), never as a window", async (status, body, code) => {
    const usage = await fetchGoUsage(KEY, { fetchImpl: reply(status, body) });
    expect(usage.status).toBe("unavailable");
    expect(usage.unavailable?.code).toBe(code);
    expect(usage.windows).toBeUndefined();
  });

  it("answers an unparseable 200 as bad-response and a thrown request as network or timeout", async () => {
    expect((await fetchGoUsage(KEY, { fetchImpl: reply(200, { usage: {} }) })).unavailable?.code).toBe("bad-response");
    const html = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect((await fetchGoUsage(KEY, { fetchImpl: html })).unavailable?.code).toBe("bad-response");
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect((await fetchGoUsage(KEY, { fetchImpl: down })).unavailable?.code).toBe("network");
    const slow = vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
    expect((await fetchGoUsage(KEY, { fetchImpl: slow })).unavailable?.code).toBe("timeout");
  });

  it("never carries the key or the provider's body into what it returns", async () => {
    const leaky = reply(403, { error: { type: "Other", message: `key ${KEY} refused for 10.0.0.1` } });
    const failed = await fetchGoUsage(KEY, { fetchImpl: leaky });
    const thrown = await fetchGoUsage(KEY, { fetchImpl: vi.fn(async () => { throw new Error(`connect failed with ${KEY}`); }) as unknown as typeof fetch });
    for (const usage of [failed, thrown]) {
      const text = JSON.stringify(usage);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("10.0.0.1");
    }
  });
});

describe("readGoUsage", () => {
  it("reuses a reading inside its ttl, and asks again after it", async () => {
    const fetchImpl = reply(200, BODY);
    let now = 1_000_000;
    const options = { fetchImpl, nowMs: () => now };
    await readGoUsage(KEY, options);
    now += GO_USAGE_TTL_MS - 1;
    await readGoUsage(KEY, options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2;
    await readGoUsage(KEY, options);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps a failure for a shorter time and a fresh read skips the cache", async () => {
    const fetchImpl = reply(401, {});
    let now = 5_000_000;
    const options = { fetchImpl, nowMs: () => now };
    await readGoUsage(KEY, options);
    now += GO_USAGE_FAILURE_TTL_MS - 1;
    await readGoUsage(KEY, options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await readGoUsage(KEY, { ...options, fresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now += GO_USAGE_FAILURE_TTL_MS + 1;
    await readGoUsage(KEY, options);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("shares one request between concurrent reads of a key and keeps keys apart", async () => {
    const fetchImpl = reply(200, BODY);
    await Promise.all([readGoUsage(KEY, { fetchImpl }), readGoUsage(KEY, { fetchImpl })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await readGoUsage(`${KEY}-other`, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
