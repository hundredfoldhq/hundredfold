import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { resolveEnvVar } from "../env-ref.js";
import type { HundredfoldConfig } from "../types.js";

const ENV_VAR = "HUNDREDFOLD_TEST_REALTIME_CONFIG_KEY";

const BASE_CONFIG = {
  gateway: { port: 7999, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
};

describe("resolveEnvVar", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("resolves ${VAR} from the environment", () => {
    process.env[ENV_VAR] = "sk-from-env";
    expect(resolveEnvVar(`\${${ENV_VAR}}`)).toBe("sk-from-env");
  });

  it("resolves a bare $VAR from the environment", () => {
    process.env[ENV_VAR] = "sk-from-env";
    expect(resolveEnvVar(`$${ENV_VAR}`)).toBe("sk-from-env");
  });

  it("returns undefined rather than the literal reference when the variable is unset", () => {
    expect(resolveEnvVar(`\${${ENV_VAR}}`)).toBeUndefined();
  });

  it("passes a plain value through untouched", () => {
    expect(resolveEnvVar("sk-literal")).toBe("sk-literal");
  });

  it("treats an absent value as absent", () => {
    expect(resolveEnvVar(undefined)).toBeUndefined();
    expect(resolveEnvVar("")).toBeUndefined();
  });
});

describe("a retired realtime config block", () => {
  // CONFIG_PATH is resolved at module load from process.env.HUNDREDFOLD_HOME, so we
  // point it at a temp dir and re-import the module.
  let tmpHome: string;
  const prevHome = process.env.HUNDREDFOLD_HOME;

  /** The full block an older release wrote, every field it knew. */
  const OLD_BLOCK = {
    provider: "openai",
    apiKey: `\${${ENV_VAR}}`,
    model: "gpt-realtime",
    voice: "marin",
    turnDetection: { type: "semantic_vad", eagerness: "auto" },
    noiseReduction: "near_field",
  };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-realtime-config-"));
    process.env.HUNDREDFOLD_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HUNDREDFOLD_HOME;
    else process.env.HUNDREDFOLD_HOME = prevHome;
    delete process.env[ENV_VAR];
    vi.resetModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function loadWritten(config: unknown): Promise<HundredfoldConfig> {
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump(config), "utf-8");
    const { loadConfig } = await import("../config.js");
    return loadConfig();
  }

  it("loads a config.yaml that still carries the whole block, and keeps it as written", async () => {
    const loaded = await loadWritten({ ...BASE_CONFIG, realtime: OLD_BLOCK });

    expect(loaded.realtime).toEqual(OLD_BLOCK);
    expect(loaded.engines.claude.model).toBe("opus");
  });

  it("loads the block even when its values are ones the retired validator refused", async () => {
    const loaded = await loadWritten({ ...BASE_CONFIG, realtime: { turnDetection: "sideways", noiseReduction: "studio", provider: 7 } });

    expect(loaded.engines.claude.model).toBe("opus");
  });

  it("saves it back unchanged", async () => {
    const loaded = await loadWritten({ ...BASE_CONFIG, realtime: OLD_BLOCK, talk: { enabled: false, engine: "claude", kokoro: { voice: "af_heart" } } });
    const { saveConfigAtomic } = await import("../config.js");

    saveConfigAtomic(loaded);

    const onDisk = yaml.load(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8")) as Record<string, unknown>;
    expect(onDisk.realtime).toEqual(OLD_BLOCK);
    expect(onDisk.talk).toEqual({ enabled: false, engine: "claude", kokoro: { voice: "af_heart" } });
  });

  it("loads a config.yaml that omits it", async () => {
    const loaded = await loadWritten(BASE_CONFIG);

    expect(loaded.realtime).toBeUndefined();
  });
});
