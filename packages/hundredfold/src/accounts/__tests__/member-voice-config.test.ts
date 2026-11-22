import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./accounts-harness.js";
import { inviteAndAccept, type Joined } from "./flows-helpers.js";

/** Voice configuration and install are operator-only: a member gets the member router's default-deny (the member voice socket is in member-voice.test.ts). */

let h: Harness;
let pat: Joined;
beforeEach(async () => {
  h = await startHarness();
  pat = await inviteAndAccept(h, "pat@example.test");
}, 60_000);
afterEach(() => { h.close(); });

const DENIED = { error: "Not available to board members" };
const operator = { authorization: "Bearer gateway-token-for-account-tests-0123456789" };

describe("voice routes and a board member", () => {
  it.each([["GET", "/api/voice/config"], ["POST", "/api/voice/install"]])("%s %s answers a member 403, whether voice is off or on", async (method, url) => {
    for (const voice of [undefined, { enabled: true }]) {
      (h.config as Record<string, unknown>).voice = voice;
      const reply = await h.request(method, url, { cookie: pat.cookie, body: method === "GET" ? undefined : {} });
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual(DENIED);
    }
  });

  it("has no member voice route: /api/member/voice/config is an unknown member path", async () => {
    expect((await h.request("GET", "/api/member/voice/config", { cookie: pat.cookie })).status).toBe(404);
  });

  it("still serves the operator the same route", async () => {
    (h.config as Record<string, unknown>).voice = undefined;
    expect(await h.request("GET", "/api/voice/config", operator)).toMatchObject({ status: 200, body: { enabled: false } });
  });
});
