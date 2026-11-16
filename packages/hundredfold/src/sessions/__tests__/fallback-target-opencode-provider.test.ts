import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A chosen fallback target on an opencode provider or account is read as a chain link is: by its provider's health key. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-fallback-target-oc-"));
process.env.HUNDREDFOLD_HOME = tmp;

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: () => true,
}));
vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  HUNDREDFOLD_HOME: tmp,
}));

const { chooseSubstituteOrReason } = await import("../rate-limit-substitute.js");
const { invalidateModelRegistry } = await import("../../shared/models.js");
const { recordEngineUnavailable } = await import("../../shared/engine-health.js");
const { recordOpencodeFailure } = await import("../../shared/engine-health-opencode.js");
const { makeSession } = await import("./helpers/session-fixture.js");
import type { HundredfoldConfig, Session } from "../../shared/types.js";

const STATE_PATH = path.join(tmp, "tmp", "engine-health.json");
const config = {
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus" },
    opencode: { bin: "opencode", model: "opencode-go-b/flash" },
  },
} as unknown as HundredfoldConfig;
const engines = new Set(["claude", "opencode"]);
const choose = (session: Session) => chooseSubstituteOrReason({ config, engines, session, employee: undefined, account: "claude", remote: undefined, remoteTarget: {} });
const spend = (key: string) => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  recordEngineUnavailable(key, "quota window spent", (Date.now() + 90 * 60_000) / 1000);
};

beforeEach(() => {
  fs.rmSync(STATE_PATH, { force: true });
  invalidateModelRegistry();
});

describe("a chosen opencode fallback target", () => {
  const fromClaude = (model: string) => makeSession({ engine: "claude", model: "opus", fallbackTarget: { engine: "opencode", model } });

  it("is refused when its own provider (an account) is spent, from another engine", () => {
    spend("opencode/opencode-go-b");
    const out = choose(fromClaude("opencode-go-b/flash"));
    expect(out.choice).toBeUndefined();
    expect(out.reason).toBe("the chosen fallback opencode (opencode-go-b/flash) has hit its own usage limit");
  });

  it("is taken when only another provider or account is spent", () => {
    spend("opencode/opencode-go-b");
    expect(choose(fromClaude("opencode-go/flash")).choice).toMatchObject({ engine: "opencode", model: "opencode-go/flash" });
    expect(choose(fromClaude("opencode-go-c/flash")).choice).toMatchObject({ engine: "opencode", model: "opencode-go-c/flash" });
  });

  it("is refused when the engine as a whole is spent", () => {
    spend("opencode");
    expect(choose(fromClaude("opencode-go/flash")).reason).toMatch(/has hit its own usage limit/);
  });

  it("is refused from another opencode provider when its provider is spent, and taken within one provider", () => {
    spend("opencode/opencode-go-b");
    const onStock = (model: string) => makeSession({ engine: "opencode", model: "opencode-go/flash", fallbackTarget: { engine: "opencode", model } });
    expect(choose(onStock("opencode-go-b/pro")).reason).toMatch(/has hit its own usage limit/);
    expect(choose(onStock("opencode-go-c/flash")).choice).toMatchObject({ model: "opencode-go-c/flash" });
    // Within the provider that just limited the session, the limit may have been the old model's alone.
    spend("opencode/opencode-go");
    expect(choose(onStock("opencode-go/pro")).choice).toMatchObject({ model: "opencode-go/pro" });
  });
});

describe("a session that runs the engine's configured model", () => {
  const unpinned = (model: string) => makeSession({ engine: "opencode", model: null, fallbackTarget: { engine: "opencode", model } });

  it("takes a target on the provider it runs on, and refuses one on another spent provider", () => {
    spend("opencode/opencode-go-b");
    expect(choose(unpinned("opencode-go-b/pro")).choice).toMatchObject({ model: "opencode-go-b/pro" });
    spend("opencode/opencode-go-c");
    expect(choose(unpinned("opencode-go-c/flash")).reason).toMatch(/has hit its own usage limit/);
  });
});

describe("a chosen opencode fallback target on a provider whose key was rejected", () => {
  const EXPIRED = "provider.auth: This API key has expired. Create a new API key in OpenCode Console. (HTTP 401)";
  const onGoB = (model: string) => makeSession({ engine: "opencode", model: "opencode-go-b/flash", fallbackTarget: { engine: "opencode", model } });
  // A dead key's credential is read from opencode's own database; never the machine's real one.
  beforeEach(() => {
    const data = path.join(tmp, "xdg-data");
    fs.mkdirSync(data, { recursive: true });
    vi.stubEnv("XDG_DATA_HOME", data);
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    return () => vi.unstubAllEnvs();
  });
  const signOut = (key: string) => recordOpencodeFailure({ healthKey: key, model: "opencode-go-b/flash", error: EXPIRED, config });

  it("is refused within the provider the session is on: the dead key is every model's", () => {
    signOut("opencode/opencode-go-b");
    const out = choose(onGoB("opencode-go-b/pro"));
    expect(out.choice).toBeUndefined();
    expect(out.reason).toBe("the chosen fallback opencode (opencode-go-b/pro) is signed out");
  });

  it("is still taken within the provider when only the old model is held", () => {
    recordOpencodeFailure({ healthKey: "opencode/opencode-go-b", model: "opencode-go-b/flash", error: "provider.auth: Upstream request failed: Model access is disabled (HTTP 403)", config });
    expect(choose(onGoB("opencode-go-b/pro")).choice).toMatchObject({ model: "opencode-go-b/pro" });
  });
});
