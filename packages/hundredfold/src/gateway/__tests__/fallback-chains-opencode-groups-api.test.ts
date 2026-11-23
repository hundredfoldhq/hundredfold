import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { HundredfoldConfig } from "../../shared/types.js";
import { baseConfig, call, home, loadApi, resetFallbackFixture, setConfig, unloadApi } from "./session-fallback-api-harness.js";

/** opencode account groups over HTTP: GET /api/fallback-chains shows the start pick of an opencode subject, from the per-account usage histories on disk. */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const WORKER_FILE = path.join(home, "org", "a-worker.yaml");
const LIMITS_DIR = path.join(home, "tmp", "engine-limits");

beforeAll(loadApi);
afterAll(unloadApi);
beforeEach(() => {
  resetFallbackFixture();
  setConfig(opencodeConfig());
  fs.writeFileSync(WORKER_FILE, yaml.dump({ name: "a-worker", displayName: "A Worker", department: "platform", rank: "employee", engine: "claude", model: "opus", persona: "Fallback mode fixture" }));
  fs.rmSync(LIMITS_DIR, { recursive: true, force: true });
});

const subject = (body: any, kind: string, id: string) => body.subjects.find((s: any) => s.kind === kind && s.id === id);
const keys = (links: Array<{ key: string }>) => links.map((link) => link.key);

const OC_GROUP = { group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }] };
const OC_MODELS = ["opencode-go/glm-5", "opencode-go-b/glm-5"].map((id) => ({ id }));

function opencodeConfig(fallback: unknown[] = [OC_GROUP, { engine: "codex" }]): HundredfoldConfig {
  const base = baseConfig;
  return {
    ...base,
    engines: {
      ...base.engines,
      claude: { bin: "claude", model: "opus" },
      opencode: {
        bin: "opencode", model: "opencode-go/glm-5", fallback,
        accounts: { "go-a": { provider: "opencode-go" }, "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY" } },
      },
    },
    models: { ...base.models, opencode: { default: "opencode-go/glm-5", models: OC_MODELS } },
  } as unknown as HundredfoldConfig;
}

/** Writes one fresh reading per opencode account key (`opencode/<provider>`): each account's own history file. */
function writeOpencodeUsage(percent: Record<string, number>): void {
  fs.mkdirSync(LIMITS_DIR, { recursive: true });
  const later = Math.floor(Date.now() / 1000) + 3 * 3600;
  for (const [account, used] of Object.entries(percent)) {
    fs.writeFileSync(path.join(LIMITS_DIR, `opencode-usage-history.${encodeURIComponent(account)}.json`), JSON.stringify([{ at: Date.now(), windows: [{ name: "5h", usedPercent: used, resetsAt: later }] }]));
  }
}

describe("GET /api/fallback-chains with an opencode group", () => {
  it("shows the pick a new opencode session would make, over the whole home group, and the member as its model on the other provider", async () => {
    setConfig(opencodeConfig());
    writeOpencodeUsage({ "opencode/opencode-go": 40, "opencode/opencode-go-b": 60 });
    const opencode = subject((await call("GET", "/api/fallback-chains")).body, "engine", "opencode");
    expect(opencode.configured).toEqual([OC_GROUP, { engine: "codex" }]);
    expect(keys(opencode.effective)).toEqual(["opencode||opencode-go-b/glm-5", "codex||"]);
    expect(opencode.effective[0].group).toMatchObject({ index: 0, written: OC_GROUP, headroom: { account: "opencode/opencode-go-b", headroomPercent: 40 } });
    expect(opencode.startPick).toMatchObject({ trigger: "start", source: "engine", groupIndex: 0, picked: "opencode/opencode-go", reason: "weighted" });
    expect(opencode.startPick.candidates.map((c: any) => [c.account, c.sharePercent])).toEqual([["opencode/opencode-go", 60], ["opencode/opencode-go-b", 40]]);
  });

  it("is unknown for an account with no reading, and an employee of its own on opencode has a pick", async () => {
    setConfig(opencodeConfig());
    fs.writeFileSync(WORKER_FILE, yaml.dump({ name: "a-worker", displayName: "A Worker", department: "platform", rank: "employee", engine: "opencode", model: "opencode-go-b/glm-5", persona: "Fallback mode fixture" }));
    const noReadings = subject((await call("GET", "/api/fallback-chains?employee=a-worker")).body, "employee", "a-worker");
    expect(noReadings.startPick).toMatchObject({ source: "engine", reason: "no-readings" });
    expect(noReadings.startPick.candidates.every((c: any) => c.state === "unknown" && !("headroomPercent" in c))).toBe(true);
    writeOpencodeUsage({ "opencode/opencode-go": 95, "opencode/opencode-go-b": 5 });
    const read = subject((await call("GET", "/api/fallback-chains?employee=a-worker")).body, "employee", "a-worker");
    expect(read.startPick.picked).toBe("opencode/opencode-go-b");
  });

  it("has no pick for a chain with no group, and the Claude subject is unchanged", async () => {
    setConfig(opencodeConfig([{ engine: "codex" }]));
    const body = (await call("GET", "/api/fallback-chains")).body;
    expect(subject(body, "engine", "opencode")).not.toHaveProperty("startPick");
    expect(subject(body, "engine", "claude")).not.toHaveProperty("startPick");
  });
});
