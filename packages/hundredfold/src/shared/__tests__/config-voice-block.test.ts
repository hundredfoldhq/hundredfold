import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An invalid `voice` block keeps voice off and nothing else: the config loads at boot and on every
 * reload, and its reason is logged once, without a key or a URL's user name.
 */

let tmpHome: string;
const prevHome = process.env.HUNDREDFOLD_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-voice-block-"));
  process.env.HUNDREDFOLD_HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HUNDREDFOLD_HOME;
  else process.env.HUNDREDFOLD_HOME = prevHome;
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const writeConfig = (voice: unknown) =>
  fs.writeFileSync(
    path.join(tmpHome, "config.yaml"),
    yaml.dump({ gateway: { port: 7778, host: "127.0.0.1" }, engines: { default: "claude", claude: { bin: "claude", model: "opus" } }, voice }),
  );

describe("loading a config with an invalid voice block", () => {
  it("boots with the rest of the config, voice resolved to off, and warns once without the secret", async () => {
    writeConfig({ enabled: true, stt: { provider: "openai-compatible", baseUrl: "https://alice:hunter2secret@speech.example", apiKey: "${STT_KEY}" } });
    const { logger } = await import("../logger.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { loadConfig } = await import("../config.js");
    const { resolveVoiceConfig } = await import("../voice-config.js");

    const loaded = loadConfig();
    loadConfig();

    expect(loaded.gateway?.port).toBe(7778);
    expect(resolveVoiceConfig(loaded)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("voice.stt.baseUrl");
    for (const secret of ["alice", "hunter2secret"]) expect(line).not.toContain(secret);
  });

  it("a reload with a block that turned invalid loads, instead of throwing and leaving the old block in force", async () => {
    writeConfig({ enabled: true });
    const { loadConfig } = await import("../config.js");
    const { resolveVoiceConfig } = await import("../voice-config.js");
    expect(resolveVoiceConfig(loadConfig())).not.toBeNull();

    writeConfig({ enabled: true, vad: { silenceMs: 50 } });
    const reloaded = loadConfig();
    expect(resolveVoiceConfig(reloaded)).toBeNull();
    expect(reloaded.voice?.vad?.silenceMs).toBe(50);
  });

  it("an unrelated problem in the same file still fails the load", async () => {
    writeConfig({ enabled: true, vad: { silenceMs: 50 } });
    const raw = yaml.load(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf8")) as Record<string, any>;
    raw.gateway.port = "not a port";
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump(raw));
    const { loadConfig } = await import("../config.js");
    expect(() => loadConfig()).toThrow(/gateway\.port/);
  });
});

describe("the voice provider key", () => {
  const VAR = "VOICE_BLOCK_TEST_KEY";
  const KEY = "sk-voice-block-test-0123456789";
  afterEach(() => { delete process.env[VAR]; });

  it("leaves every engine child's environment and still authenticates the gateway's own providers", async () => {
    process.env[VAR] = KEY;
    writeConfig({ enabled: true, stt: { provider: "openai", apiKey: `\${${VAR}}` }, tts: { provider: "openai", apiKey: `\${${VAR}}` } });
    const { loadConfig } = await import("../config.js");
    const { buildEngineChildEnv, voiceKeyEnvironment } = await import("../child-env.js");
    const { resolveVoiceConfig } = await import("../voice-config.js");
    const { createSttProvider, createTtsProvider } = await import("../../voice/providers/registry.js");

    const loaded = loadConfig();

    // The engine child, built from the gateway's own environment, has no key. Neither does the gateway's environment.
    expect(buildEngineChildEnv()).not.toHaveProperty(VAR);
    expect(process.env[VAR]).toBeUndefined();
    expect(Object.values(buildEngineChildEnv())).not.toContain(KEY);
    // The gateway still resolves it.
    expect(voiceKeyEnvironment()[VAR]).toBe(KEY);
    const resolved = resolveVoiceConfig(loaded)!;
    expect(createSttProvider(resolved).status()).toEqual({ available: true });
    expect(createTtsProvider(resolved).status()).toEqual({ available: true });
  });

  it("is left alone while voice is off, so a variable another tool uses is not withheld", async () => {
    process.env[VAR] = KEY;
    writeConfig({ enabled: false, stt: { provider: "openai", apiKey: `\${${VAR}}` } });
    const { loadConfig } = await import("../config.js");
    const { buildEngineChildEnv } = await import("../child-env.js");
    loadConfig();
    expect(buildEngineChildEnv()[VAR]).toBe(KEY);
  });

  it("is withheld from every engine child when the block asks for voice but is invalid (enabled: \"yes\")", async () => {
    process.env[VAR] = KEY;
    writeConfig({ enabled: "yes", stt: { provider: "openai", apiKey: `\${${VAR}}` }, tts: { provider: "openai", apiKey: `\${${VAR}}` } });
    const { loadConfig } = await import("../config.js");
    const { buildEngineChildEnv, voiceKeyEnvironment } = await import("../child-env.js");
    const { resolveVoiceConfig, voiceOffReason } = await import("../voice-config.js");
    const loaded = loadConfig();

    expect(resolveVoiceConfig(loaded)).toBeNull();
    expect(voiceOffReason(loaded.voice)).toContain("voice.enabled");
    expect(buildEngineChildEnv()).not.toHaveProperty(VAR);
    expect(Object.values(buildEngineChildEnv())).not.toContain(KEY);
    expect(process.env[VAR]).toBeUndefined();
    expect(voiceKeyEnvironment()[VAR]).toBe(KEY);
  });

  it("is left alone when the block does not ask for voice: enabled absent or false", async () => {
    for (const block of [{ stt: { provider: "openai", apiKey: `\${${VAR}}` } }, { enabled: false, stt: { provider: "openai", apiKey: `\${${VAR}}` } }]) {
      process.env[VAR] = KEY;
      writeConfig(block);
      vi.resetModules();
      const { loadConfig } = await import("../config.js");
      const { buildEngineChildEnv } = await import("../child-env.js");
      loadConfig();
      expect(buildEngineChildEnv()[VAR]).toBe(KEY);
    }
  });

  it("is still found by an explicit ${VAR} elsewhere in config.yaml, while every engine child lacks it", async () => {
    process.env[VAR] = KEY;
    writeConfig({ enabled: true, stt: { provider: "openai", apiKey: `\${${VAR}}` }, tts: { provider: "openai", apiKey: `\${${VAR}}` } });
    const { loadConfig } = await import("../config.js");
    const { buildEngineChildEnv } = await import("../child-env.js");
    const { resolveEnvVar } = await import("../env-ref.js");
    const { createRealtimeProvider } = await import("../../talk/realtime/index.js");
    const { resolveMcpServers } = await import("../../mcp/resolver.js");
    loadConfig();

    expect(process.env[VAR]).toBeUndefined();
    expect(buildEngineChildEnv()).not.toHaveProperty(VAR);
    expect(resolveEnvVar(`\${${VAR}}`)).toBe(KEY);
    expect(resolveEnvVar(`$${VAR}`)).toBe(KEY);
    // The realtime factory resolves it...
    expect(() => createRealtimeProvider({ provider: "openai", apiKey: `\${${VAR}}` })).not.toThrow();
    // ...and so does an MCP server's env (it is the operator's explicit choice), not the literal reference.
    const { mcpServers } = resolveMcpServers({ browser: { enabled: false }, custom: { demo: { command: "run", env: { TOKEN: `\${${VAR}}` } } } });
    expect((mcpServers.demo as { env: Record<string, string> }).env.TOKEN).toBe(KEY);
  });

  it("survives voice being turned off by a reload and back on, and still reaches the successor", async () => {
    process.env[VAR] = KEY;
    writeConfig({ enabled: true, stt: { provider: "openai", apiKey: `\${${VAR}}` } });
    const { loadConfig } = await import("../config.js");
    const { buildEngineChildEnv, withOpencodeAccountKeys } = await import("../child-env.js");
    const { resolveEnvVar } = await import("../env-ref.js");
    loadConfig();
    expect(process.env[VAR]).toBeUndefined();

    writeConfig({ enabled: false, stt: { provider: "openai", apiKey: `\${${VAR}}` } });
    loadConfig();
    expect(resolveEnvVar(`\${${VAR}}`)).toBe(KEY);
    expect(withOpencodeAccountKeys({ ...process.env })[VAR]).toBe(KEY);
    expect(buildEngineChildEnv()[VAR]).toBe(KEY);

    writeConfig({ enabled: true, stt: { provider: "openai", apiKey: `\${${VAR}}` } });
    loadConfig();
    expect(withOpencodeAccountKeys({ ...process.env })[VAR]).toBe(KEY);
  });
});
