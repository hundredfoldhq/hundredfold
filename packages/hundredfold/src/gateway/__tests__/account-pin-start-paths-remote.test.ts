import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { HundredfoldConfig, Session } from "../../shared/types.js";
import { remoteClaudeAccountKey } from "../../shared/engine-account.js";
import { baseConfig, call, delegate, home, loadApi, registry, resetFallbackFixture, setConfig, spawn, toolHeaders, unloadApi } from "./session-fallback-api-harness.js";

/**
 * A remote employee's new sessions are pinned to the account the balancer picks through every way the API starts one:
 * a pick of a declared account on its host is recorded as `transportMeta.remoteAccountPin` (the directory the host runs
 * the session with), beside the pick, and a pick of the employee's own login writes no pin.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const HOST = { remoteHost: "build-box", remoteUser: "builder" };
const OWN_DIR = "/home/builder/.claude-own";
const SPARE_DIR = "/home/builder/.claude-spare";
const OWN_KEY = remoteClaudeAccountKey(HOST, OWN_DIR);
const SPARE_KEY = remoteClaudeAccountKey(HOST, SPARE_DIR);
const LIMITS_DIR = path.join(home, "tmp", "engine-limits");
const GROUP = { group: [{ engine: "claude", profile: "own" }, { engine: "claude", profile: "spare" }] };

beforeAll(loadApi);
afterAll(unloadApi);
beforeEach(() => {
  resetFallbackFixture();
  setConfig(remoteConfig());
  writeEmployee();
});

function remoteConfig(): HundredfoldConfig {
  return {
    ...baseConfig,
    remote: { root: "/srv/agents", mount: "/mnt/hundredfold-home" },
    engines: {
      ...baseConfig.engines,
      claude: {
        bin: "claude", model: "opus", fallback: [GROUP],
        accounts: { own: { ...HOST, configDir: OWN_DIR }, spare: { ...HOST, configDir: SPARE_DIR } },
      },
    },
  } as unknown as HundredfoldConfig;
}

function writeEmployee(): void {
  fs.writeFileSync(path.join(home, "org", "a-worker.yaml"), yaml.dump({
    name: "a-worker", displayName: "A Worker", department: "platform", rank: "employee", engine: "claude", model: "opus",
    persona: "Remote account group fixture", ...HOST, remoteCwd: "/srv/agents/main", remoteClaudeConfigDir: OWN_DIR,
  }));
}

/** One fresh reading per account: `used` percent in its 5h window. */
function writeUsage(used: Record<string, number>): void {
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600;
  for (const [account, percent] of Object.entries(used)) {
    fs.writeFileSync(path.join(LIMITS_DIR, `claude-usage-history.${encodeURIComponent(account)}.json`), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: percent, resetsAt: later }] }]));
  }
}

const meta = (session: Session) => session.transportMeta as { accountPick?: { picked: string }; remoteAccountPin?: { account: string; configDir: string } } | null;
const SPARE_PIN = { account: SPARE_KEY, configDir: SPARE_DIR };

describe("a remote employee's session the balancer puts on the spare account", () => {
  beforeEach(() => writeUsage({ [OWN_KEY]: 100, [SPARE_KEY]: 0 }));

  it("is pinned to the spare account's directory by a new chat", async () => {
    const created = await spawn({ employee: "a-worker" });
    expect(created.status).toBe(201);
    const session = registry.getSession(created.body.id)!;
    expect(meta(session)?.accountPick?.picked).toBe(SPARE_KEY);
    expect(meta(session)?.remoteAccountPin).toEqual(SPARE_PIN);
    // A remote session ignores the gateway-side profile column: the pin is the only place the directory lives.
    expect(session.claudeConfigDir ?? null).toBeNull();
  });

  it("is pinned by a spawn from another session", async () => {
    const parent = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:parent", model: "opus" });
    const created = await spawn({ employee: "a-worker" }, toolHeaders(parent.id));
    expect(created.status).toBe(201);
    expect(meta(registry.getSession(created.body.id)!)?.remoteAccountPin).toEqual(SPARE_PIN);
  });

  it("is pinned by a delegation", async () => {
    const delegated = await delegate({ employee: "a-worker" });
    expect(delegated.status).toBe(201);
    expect(meta(registry.getSession(delegated.body.sessionId)!)?.remoteAccountPin).toEqual(SPARE_PIN);
  });
});

describe("a remote employee's session the balancer leaves on its own login", () => {
  it("records the pick and writes no pin", async () => {
    writeUsage({ [OWN_KEY]: 0, [SPARE_KEY]: 100 });
    const created = await call("POST", "/api/sessions", { prompt: "brief", employee: "a-worker" });
    expect(created.status).toBe(201);
    const session = registry.getSession(created.body.id)!;
    expect(meta(session)?.accountPick?.picked).toBe(OWN_KEY);
    expect(meta(session)?.remoteAccountPin).toBeUndefined();
  });
});
