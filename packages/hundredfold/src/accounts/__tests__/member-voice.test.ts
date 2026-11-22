import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./accounts-harness.js";
import { inviteAndAccept, type Joined } from "./flows-helpers.js";

/** Voice mode's availability for a board member, through the real member router. */

let h: Harness;
let pat: Joined;
beforeEach(async () => {
  h = await startHarness();
  pat = await inviteAndAccept(h, "pat@example.test");
}, 60_000);
afterEach(() => { h.close(); });

const operator = { authorization: "Bearer gateway-token-for-account-tests-0123456789" };
const setVoice = (voice: unknown) => { (h.config as Record<string, unknown>).voice = voice; };

describe("GET /api/member/voice/config", () => {
  it("answers a member with {enabled:false} while voice is off, as the operator's route does", async () => {
    const member = await h.request("GET", "/api/member/voice/config", { cookie: pat.cookie });
    const operatorReply = await h.request("GET", "/api/voice/config", operator);
    expect(member.status).toBe(200);
    expect(member.body).toEqual({ enabled: false });
    expect(operatorReply.body).toEqual(member.body);
  });

  it("answers a member exactly what it answers the operator once voice is on, and shows nothing secret", async () => {
    setVoice({ enabled: true, prompt: "UNIQUE-VOICE-PROMPT", stt: { provider: "openai", apiKey: "${NO_SUCH_VOICE_KEY}" }, tts: { provider: "openai", apiKey: "${NO_SUCH_VOICE_KEY}" } });
    const member = await h.request("GET", "/api/member/voice/config", { cookie: pat.cookie });
    const operatorReply = await h.request("GET", "/api/voice/config", operator);
    expect(member.status).toBe(200);
    expect(member.body).toMatchObject({ enabled: true, available: false, reason: "OpenAI key not set: NO_SUCH_VOICE_KEY" });
    expect(member.body).toEqual(operatorReply.body);
    expect(JSON.stringify(member.body)).not.toContain("UNIQUE-VOICE-PROMPT");
  });

  it("is still refused at the operator's paths: the member allowlist is unchanged", async () => {
    expect((await h.request("GET", "/api/voice/config", { cookie: pat.cookie })).status).toBe(403);
    expect((await h.request("POST", "/api/voice/install", { cookie: pat.cookie, body: {} })).status).toBe(403);
  });
});
