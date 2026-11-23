import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig } from "../../../shared/types.js";

/**
 * The two Talk starts that run an agent, a delegation and a hand-off, pick an opencode session's account like every other
 * start: the row carries the model pinned to the picked account's provider and the pick, and the rotation moves by exactly
 * one, only when the session was really created (a replay of the same delegation is not a start).
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-talk-account-pin-opencode-"));
process.env.HUNDREDFOLD_HOME = home;
const LIMITS_DIR = path.join(home, "tmp", "engine-limits");

vi.mock("../../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/models.js")>()),
  engineAvailable: () => true,
}));

let claimDelegation: typeof import("../delegation-adapter.js").claimTalkDelegation;
let handOff: typeof import("../../../gateway/talk-turn-api.js").handOff;
let sessions: typeof import("../../../sessions/registry.js");
let workItems: typeof import("../../../work-items/store.js");
let pin: typeof import("../../../sessions/account-pin.js");
let resetAccountCredits: typeof import("../../../shared/fallback-account-pick.js").resetAccountCredits;

const OWN = "opencode/opencode-go";
const FRIEND = "opencode/opencode-go-b";
const MODEL = "opencode-go/glm-5";
const FRIEND_MODEL = "opencode-go-b/glm-5";

const config = {
  gateway: {},
  engines: {
    default: "opencode",
    claude: { bin: "claude", model: "opus" },
    opencode: {
      bin: "opencode", model: MODEL,
      accounts: { "go-a": { provider: "opencode-go" }, "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY" } },
      fallback: [{ group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }] }],
    },
  },
  models: { claude: { default: "opus", models: [{ id: "opus" }] }, opencode: { default: MODEL, models: [MODEL, FRIEND_MODEL].map((id) => ({ id })) } },
} as unknown as HundredfoldConfig;

beforeAll(async () => {
  ({ claimTalkDelegation: claimDelegation } = await import("../delegation-adapter.js"));
  ({ handOff } = await import("../../../gateway/talk-turn-api.js"));
  sessions = await import("../../../sessions/registry.js");
  workItems = await import("../../../work-items/store.js");
  pin = await import("../../../sessions/account-pin.js");
  ({ resetAccountCredits } = await import("../../../shared/fallback-account-pick.js"));
  (await import("../../../shared/db.js")).initDb();
}, 60_000);

beforeEach(() => {
  resetAccountCredits();
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600;
  for (const [account, used] of [[OWN, 40], [FRIEND, 60]] as const) {
    fs.writeFileSync(path.join(LIMITS_DIR, `opencode-usage-history.${encodeURIComponent(account)}.json`), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: used, resetsAt: later }] }]));
  }
});

/** The account the next start would pick: a preview, which charges nothing. */
const nextPick = () => pin.pinAccountAtCreation({ config, engine: "opencode", model: MODEL }).accountPick!.picked;
const pickOf = (session: { transportMeta: unknown }) => (session.transportMeta as { accountPick?: { picked: string } } | null)?.accountPick;

let n = 0;
function delegation(key = `talk:pin:${n++}`) {
  const parent = sessions.createSession({ engine: "claude", source: "talk", sourceRef: `talk:pin-parent-${n}` });
  const item = workItems.createWorkItem({ title: `Delegate ${n}` });
  const call = { talkSessionId: `talk-pin-${n}`, providerCallId: `call-pin-${n}`, idempotencyKey: key, caller: { kind: "operator", principal: "operator" } } as const;
  const input = {
    context: { getConfig: () => config } as unknown as Parameters<typeof claimDelegation>[0]["context"],
    sourceSessionId: parent.id, todoId: item.id, prompt: "Do the bounded thing.",
    employee: { name: "an-ocworker", department: "platform", engine: "opencode", model: MODEL }, call,
  };
  return () => claimDelegation(input);
}

async function handOffOnce() {
  const parent = sessions.createSession({ engine: "claude", source: "talk", sourceRef: `talk:handoff-parent-${n++}` });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ prompt: "Look into this." }))]), { method: "POST", headers: { "content-type": "application/json" } }) as unknown as IncomingMessage;
  let raw = "";
  const res = { writeHead() { return this; }, setHeader() { return this; }, end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); } } as unknown as ServerResponse;
  await handOff(req, res, { sessionId: parent.id } as never, config);
  return sessions.getSession(JSON.parse(raw).sessionId)!;
}

describe("a Talk delegation", () => {
  it("is pinned to the account the balancer picked and charges that start once", () => {
    expect(nextPick()).toBe(OWN);
    const { session } = delegation()();
    expect(pickOf(session)).toMatchObject({ picked: OWN });
    expect(session.model).toBe(MODEL); // its own account: the model stays as it was
    // 60 and 40 headroom: the first start was the default login's, so the second is the friend's.
    expect(nextPick()).toBe(FRIEND);
    const second = delegation()().session;
    expect(pickOf(second)).toMatchObject({ picked: FRIEND });
    expect(second.model).toBe(FRIEND_MODEL); // the same model key, on the picked account's provider
    expect(nextPick()).toBe(OWN);
  });

  it("charges nothing when the same delegation is claimed again", () => {
    const claim = delegation("talk:pin:replay");
    const first = claim();
    expect(nextPick()).toBe(FRIEND);
    const again = claim();
    expect(again.session.id).toBe(first.session.id);
    expect(nextPick()).toBe(FRIEND);
  });
});

describe("a Talk hand-off", () => {
  it("is pinned to the account the balancer picked and charges that start once", async () => {
    expect(nextPick()).toBe(OWN);
    const first = await handOffOnce();
    expect(pickOf(first)).toMatchObject({ picked: OWN });
    expect(first.engine).toBe("opencode");
    expect(first.model ?? MODEL).toBe(MODEL); // its own account: no model is pinned, the engine's own applies
    expect(nextPick()).toBe(FRIEND);
    const second = await handOffOnce();
    expect(pickOf(second)).toMatchObject({ picked: FRIEND });
    expect(second.model).toBe(FRIEND_MODEL); // the same model key, on the picked account's provider
    expect(nextPick()).toBe(OWN);
  });
});
