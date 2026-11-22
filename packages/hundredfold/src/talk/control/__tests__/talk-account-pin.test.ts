import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig } from "../../../shared/types.js";

/**
 * The two Talk starts that run an agent on Claude, a delegation and a hand-off, pick their account like every other start:
 * the row carries the pinned profile and the pick, and the rotation moves by exactly one, only when the session was really
 * created (a replay of the same delegation is not a start).
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-talk-account-pin-"));
process.env.HUNDREDFOLD_HOME = home;
const LIMITS_DIR = path.join(home, "tmp", "engine-limits");
const OUTSIDE = process.env.HUNDREDFOLD_VITEST_SYSTEM_TEMP_ROOT ?? "/tmp";
const FRIEND = path.join(OUTSIDE, "talk-account-pin-friend");

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
let friendKey: string;

const config = {
  gateway: {},
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", accounts: { friend: { configDir: FRIEND } }, fallback: [{ group: [{ engine: "claude" }, { engine: "claude", profile: "friend" }] }] },
  },
  models: { claude: { default: "opus", models: [{ id: "opus" }] } },
} as unknown as HundredfoldConfig;

beforeAll(async () => {
  ({ claimTalkDelegation: claimDelegation } = await import("../delegation-adapter.js"));
  ({ handOff } = await import("../../../gateway/talk-turn-api.js"));
  sessions = await import("../../../sessions/registry.js");
  workItems = await import("../../../work-items/store.js");
  pin = await import("../../../sessions/account-pin.js");
  ({ resetAccountCredits } = await import("../../../shared/fallback-account-pick.js"));
  const { claudeProfileFromDir } = await import("../../../shared/claude-profile.js");
  friendKey = `claude:${claudeProfileFromDir(FRIEND).key}`;
  (await import("../../../shared/db.js")).initDb();
}, 60_000);

beforeEach(() => {
  resetAccountCredits();
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600;
  for (const [account, used] of [["claude", 40], [friendKey, 60]] as const) {
    const file = account === "claude" ? "claude-usage-history.json" : `claude-usage-history.${encodeURIComponent(account)}.json`;
    fs.writeFileSync(path.join(LIMITS_DIR, file), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: used, resetsAt: later }] }]));
  }
});

/** The account the next start would pick: a preview, which charges nothing. */
const nextPick = () => pin.pinAccountAtCreation({ config, engine: "claude", model: "opus" }).accountPick!.picked;
const pickOf = (session: { transportMeta: unknown }) => (session.transportMeta as { accountPick?: { picked: string } } | null)?.accountPick;

let n = 0;
function delegation(key = `talk:pin:${n++}`) {
  const parent = sessions.createSession({ engine: "claude", source: "talk", sourceRef: `talk:pin-parent-${n}` });
  const item = workItems.createWorkItem({ title: `Delegate ${n}` });
  const call = { talkSessionId: `talk-pin-${n}`, providerCallId: `call-pin-${n}`, idempotencyKey: key, caller: { kind: "operator", principal: "operator" } } as const;
  const input = {
    context: { getConfig: () => config } as unknown as Parameters<typeof claimDelegation>[0]["context"],
    sourceSessionId: parent.id, todoId: item.id, prompt: "Do the bounded thing.",
    employee: { name: "a-worker", department: "platform", engine: "claude", model: "opus" }, call,
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
    expect(nextPick()).toBe("claude");
    const { session } = delegation()();
    expect(pickOf(session)).toMatchObject({ picked: "claude" });
    expect(session.claudeConfigDir).toBeNull();
    // 60 and 40 headroom: the first start was the default login's, so the second is the friend's.
    expect(nextPick()).toBe(friendKey);
    const second = delegation()().session;
    expect(pickOf(second)).toMatchObject({ picked: friendKey });
    expect(second.claudeConfigDir).toBe(FRIEND);
    expect(nextPick()).toBe("claude");
  });

  it("charges nothing when the same delegation is claimed again", () => {
    const claim = delegation("talk:pin:replay");
    const first = claim();
    expect(nextPick()).toBe(friendKey);
    const again = claim();
    expect(again.session.id).toBe(first.session.id);
    expect(nextPick()).toBe(friendKey);
  });
});

describe("a Talk hand-off", () => {
  it("is pinned to the account the balancer picked and charges that start once", async () => {
    expect(nextPick()).toBe("claude");
    const first = await handOffOnce();
    expect(pickOf(first)).toMatchObject({ picked: "claude" });
    expect(nextPick()).toBe(friendKey);
    const second = await handOffOnce();
    expect(pickOf(second)).toMatchObject({ picked: friendKey });
    expect(second.claudeConfigDir).toBe(FRIEND);
    expect(nextPick()).toBe("claude");
  });
});
