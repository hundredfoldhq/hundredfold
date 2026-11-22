import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfigShape } from "../config.js";
import { DEFAULT_HOLDING_LINE, DEFAULT_VOICE_PROMPT, resolveVoiceConfig, voiceConfigProblems, voiceOffReason } from "../voice-config.js";

const HOME = path.resolve("/tmp/voice-config-test-home");
const problems = (voice: unknown) => voiceConfigProblems(voice, HOME);

describe("voiceConfigProblems", () => {
  it("accepts an absent or empty block and a disabled one", () => {
    expect(problems(undefined)).toEqual([]);
    expect(problems(null)).toEqual([]);
    expect(problems({})).toEqual([]);
    expect(problems({ enabled: false })).toEqual([]);
  });

  it("accepts every key at its default and at both ends of its range", () => {
    expect(problems({
      enabled: true, mode: "push-to-talk", language: "en-GB",
      stt: { provider: "local", model: "m" }, tts: { provider: "local", voice: "bf_emma", speed: 0.5 },
      vad: { threshold: 0, minSpeechMs: 50, silenceMs: 5000, prerollMs: 1000 },
      bargeIn: { enabled: false, minSpeechMs: 2000, onsetThreshold: 1 },
      autoBackground: { enabled: true, afterSeconds: 600 },
      prompt: "x".repeat(8000), holdingLine: "y".repeat(300),
      limits: { maxUtteranceSeconds: 120, maxConcurrentAttachments: 64 }, local: { device: "gpu" },
    })).toEqual([]);
  });

  it.each([
    ["voice.enabled", { enabled: "yes" }, "voice.enabled"],
    ["voice.mode", { mode: "always" }, "voice.mode"],
    ["voice.language", { language: "English" }, "voice.language"],
    ["voice.stt.provider", { stt: { provider: "whisper" } }, "voice.stt.provider"],
    ["voice.stt.model", { stt: { model: "" } }, "voice.stt.model"],
    ["voice.stt", { stt: "local" }, "voice.stt must be a mapping"],
    ["voice.tts.provider", { tts: { provider: 3 } }, "voice.tts.provider"],
    ["voice.tts.voice", { tts: { voice: "" } }, "voice.tts.voice"],
    ["voice.tts.speed", { tts: { speed: 0.4 } }, "voice.tts.speed"],
    ["voice.tts.speed", { tts: { speed: 2.1 } }, "voice.tts.speed"],
    ["voice.tts.speed", { tts: { speed: "fast" } }, "voice.tts.speed"],
    ["voice.vad.threshold", { vad: { threshold: 1.5 } }, "voice.vad.threshold"],
    ["voice.vad.minSpeechMs", { vad: { minSpeechMs: 49 } }, "voice.vad.minSpeechMs"],
    ["voice.vad.minSpeechMs", { vad: { minSpeechMs: 250.5 } }, "voice.vad.minSpeechMs"],
    ["voice.vad.silenceMs", { vad: { silenceMs: 199 } }, "voice.vad.silenceMs"],
    ["voice.vad.prerollMs", { vad: { prerollMs: 1001 } }, "voice.vad.prerollMs"],
    ["voice.bargeIn.enabled", { bargeIn: { enabled: 1 } }, "voice.bargeIn.enabled"],
    ["voice.bargeIn.minSpeechMs", { bargeIn: { minSpeechMs: 2001 } }, "voice.bargeIn.minSpeechMs"],
    ["voice.bargeIn.onsetThreshold", { bargeIn: { onsetThreshold: -0.1 } }, "voice.bargeIn.onsetThreshold"],
    ["voice.autoBackground.enabled", { autoBackground: { enabled: "on" } }, "voice.autoBackground.enabled"],
    ["voice.autoBackground.afterSeconds", { autoBackground: { afterSeconds: 0.5 } }, "voice.autoBackground.afterSeconds"],
    ["voice.autoBackground.afterSeconds", { autoBackground: { afterSeconds: 601 } }, "voice.autoBackground.afterSeconds"],
    ["voice.prompt", { prompt: "x".repeat(8001) }, "voice.prompt"],
    ["voice.prompt", { prompt: 4 }, "voice.prompt"],
    ["voice.holdingLine", { holdingLine: "y".repeat(301) }, "voice.holdingLine"],
    ["voice.limits.maxUtteranceSeconds", { limits: { maxUtteranceSeconds: 4 } }, "voice.limits.maxUtteranceSeconds"],
    ["voice.limits.maxUtteranceSeconds", { limits: { maxUtteranceSeconds: 121 } }, "voice.limits.maxUtteranceSeconds"],
    ["voice.limits.maxUtteranceSeconds", { limits: { maxUtteranceSeconds: 600 } }, "voice.limits.maxUtteranceSeconds"],
    ["voice.limits.maxConcurrentAttachments", { limits: { maxConcurrentAttachments: 0 } }, "voice.limits.maxConcurrentAttachments"],
    ["voice.local.device", { local: { device: "tpu" } }, "voice.local.device"],
    ["voice.limits", { limits: [] }, "voice.limits must be a mapping"],
  ])("names %s when it is wrong", (_key, voice, expected) => {
    const found = problems({ enabled: true, ...voice });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(expected);
  });

  it("refuses a block that is not a mapping", () => {
    expect(problems("yes")).toEqual(["voice must be a mapping (got string)"]);
    expect(problems(["a"])).toEqual(["voice must be a mapping (got an array)"]);
  });

  it("requires a baseUrl for openai-compatible and accepts only http(s)", () => {
    expect(problems({ stt: { provider: "openai-compatible" } })).toEqual(["voice.stt.baseUrl is required for the openai-compatible provider"]);
    expect(problems({ tts: { provider: "openai-compatible", baseUrl: "ftp://host" } })[0]).toContain("voice.tts.baseUrl must be an http or https URL");
    expect(problems({ tts: { provider: "openai-compatible", baseUrl: "not a url" } })[0]).toContain("voice.tts.baseUrl");
    expect(problems({ stt: { provider: "openai-compatible", baseUrl: "http://localhost:8000" } })).toEqual([]);
  });

  it("refuses a baseUrl that carries a user name or password, which would end up in errors", () => {
    const [problem] = problems({ tts: { provider: "openai-compatible", baseUrl: "http://user:hunter2secret@host:8880" } });
    expect(problem).toContain("voice.tts.baseUrl must not carry a user name or password");
    expect(problem).toContain("apiKey");
    expect(problem).not.toContain("hunter2secret");
    expect(problems({ stt: { provider: "openai-compatible", baseUrl: "http://user@host" } })[0]).toContain("voice.stt.baseUrl must not carry");
  });

  it("refuses a baseUrl on the local provider, where it would be silently ignored", () => {
    expect(problems({ stt: { baseUrl: "http://localhost:8000" } })[0]).toContain("voice.stt.baseUrl is not used by the local provider");
  });

  it("refuses a literal apiKey with the move-to-environment message and accepts a reference", () => {
    const [problem] = problems({ stt: { provider: "openai", apiKey: "sk-live-secret" } });
    expect(problem).toContain("voice.stt.apiKey must be a ${VAR} reference");
    expect(problem).toContain("never the key itself");
    expect(problem).not.toContain("sk-live-secret");
    expect(problems({ tts: { provider: "openai", apiKey: "$OPENAI_API_KEY" } })[0]).toContain("voice.tts.apiKey");
    expect(problems({ stt: { provider: "openai", apiKey: "${OPENAI_API_KEY}" }, tts: { provider: "openai", apiKey: "${OPENAI_API_KEY}" } })).toEqual([]);
  });

  it("lets the local provider speak English only", () => {
    expect(problems({ language: "fr" })[0]).toContain("voice.language");
    expect(problems({ language: "en-US" })).toEqual([]);
    expect(problems({ language: "fr", stt: { provider: "openai" }, tts: { provider: "openai" } })).toEqual([]);
    // One local side is enough to refuse.
    expect(problems({ language: "de", stt: { provider: "openai" } })[0]).toContain("voice.language");
    // "end" starts with "en" but is not English.
    expect(problems({ language: "end" })[0]).toContain("voice.language");
  });

  it("confines promptFile to the instance home", () => {
    expect(problems({ promptFile: "voice/prompt.md" })).toEqual([]);
    for (const escaping of ["../outside.md", "voice/../../outside.md", "/etc/passwd", "", "."]) {
      expect(problems({ promptFile: escaping })[0]).toContain("voice.promptFile");
    }
    expect(problems({ promptFile: 4 })[0]).toContain("voice.promptFile");
  });

  it("reports every problem, not just the first", () => {
    const found = problems({ enabled: "x", mode: "y", vad: { threshold: 9 } });
    expect(found.length).toBe(3);
  });
});

describe("voiceOffReason", () => {
  const reason = (voice: unknown) => voiceOffReason(voice, HOME);

  it("is null for an absent, empty, disabled or valid block", () => {
    expect(reason(undefined)).toBeNull();
    expect(reason({})).toBeNull();
    expect(reason({ enabled: false, vad: { threshold: 9 } })).toBeNull();
    expect(reason({ enabled: true })).toBeNull();
  });

  it("names every bad key when voice is asked for", () => {
    const text = reason({ enabled: true, vad: { silenceMs: 50 }, mode: "loud" });
    expect(text).toContain("voice.vad.silenceMs");
    expect(text).toContain("voice.mode");
  });

  it("never echoes a URL's user name, password or a literal key", () => {
    const text = reason({ enabled: true, stt: { provider: "openai-compatible", baseUrl: "https://bob:s3cretpass@host.example", apiKey: "sk-literal-key-123456" } }) ?? "";
    expect(text).toContain("voice.stt.baseUrl");
    for (const secret of ["bob", "s3cretpass", "sk-literal-key-123456"]) expect(text).not.toContain(secret);
  });
});

describe("validateConfigShape", () => {
  const base = { engines: { default: "claude", claude: {} } };

  it("passes a config with no voice block and one with a good block", () => {
    expect(validateConfigShape(base)).toEqual([]);
    expect(validateConfigShape({ ...base, voice: { enabled: true } })).toEqual([]);
  });

  it("does not fail the config over a voice block with a problem: voice goes off instead (FR-025)", () => {
    expect(validateConfigShape({ ...base, voice: { enabled: true, vad: { silenceMs: 1 } } })).toEqual([]);
    expect(validateConfigShape({ ...base, voice: "on" })).toEqual([]);
    expect(resolveVoiceConfig({ voice: { enabled: true, vad: { silenceMs: 1 } } }, HOME)).toBeNull();
  });

  it("still refuses a problem elsewhere in the same config", () => {
    expect(validateConfigShape({ ...base, gateway: { port: "x" }, voice: { enabled: true, vad: { silenceMs: 1 } } })).toEqual([
      expect.stringContaining("gateway.port"),
    ]);
  });
});

describe("resolveVoiceConfig", () => {
  const resolve = (voice: unknown) => resolveVoiceConfig({ voice }, HOME);

  it("is null when absent, disabled, or not exactly true", () => {
    expect(resolveVoiceConfig({}, HOME)).toBeNull();
    expect(resolve(undefined)).toBeNull();
    expect(resolve({})).toBeNull();
    expect(resolve({ enabled: false })).toBeNull();
    expect(resolve({ enabled: "true" })).toBeNull();
  });

  it("is null while the block has a problem, even when enabled", () => {
    expect(resolve({ enabled: true, vad: { threshold: 2 } })).toBeNull();
  });

  it("fills every default", () => {
    expect(resolve({ enabled: true })).toEqual({
      mode: "hands-free", language: "en",
      stt: { provider: "local", model: "parakeet-tdt-0.6b-v2", baseUrl: null, apiKeyRef: null },
      tts: { provider: "local", model: "kokoro-v1.0", baseUrl: null, apiKeyRef: null, voice: "af_heart", speed: 1 },
      vad: { threshold: 0.5, minSpeechMs: 250, silenceMs: 700, prerollMs: 300 },
      bargeIn: { enabled: true, minSpeechMs: 250, onsetThreshold: 0.02 },
      autoBackground: { enabled: true, afterSeconds: 5 },
      prompt: DEFAULT_VOICE_PROMPT, promptFile: null, holdingLine: DEFAULT_HOLDING_LINE,
      limits: { maxUtteranceSeconds: 60, maxConcurrentAttachments: 4 }, local: { device: "auto" },
    });
  });

  it("keeps what the operator set and fills the rest around it", () => {
    const resolved = resolve({
      enabled: true, mode: "push-to-talk", tts: { voice: "bf_emma", speed: 1.25 }, vad: { silenceMs: 900 },
      bargeIn: { enabled: false }, limits: { maxConcurrentAttachments: 2 }, local: { device: "cpu" }, holdingLine: "One moment.",
    })!;
    expect(resolved.mode).toBe("push-to-talk");
    expect(resolved.tts).toMatchObject({ voice: "bf_emma", speed: 1.25 });
    expect(resolved.vad).toEqual({ threshold: 0.5, minSpeechMs: 250, silenceMs: 900, prerollMs: 300 });
    expect(resolved.bargeIn).toEqual({ enabled: false, minSpeechMs: 250, onsetThreshold: 0.02 });
    expect(resolved.limits).toEqual({ maxUtteranceSeconds: 60, maxConcurrentAttachments: 2 });
    expect(resolved.local.device).toBe("cpu");
    expect(resolved.holdingLine).toBe("One moment.");
  });

  it("takes each provider's own defaults and keeps the key as a reference only", () => {
    const resolved = resolve({
      enabled: true,
      stt: { provider: "openai", apiKey: "${OPENAI_API_KEY}" },
      tts: { provider: "openai-compatible", baseUrl: "http://localhost:8880/", apiKey: "${LOCAL_TTS_KEY}" },
      language: "fr",
    })!;
    expect(resolved.stt).toEqual({ provider: "openai", model: "gpt-live-transcribe", baseUrl: null, apiKeyRef: "${OPENAI_API_KEY}" });
    expect(resolved.tts).toEqual({ provider: "openai-compatible", model: "tts-1", baseUrl: "http://localhost:8880", apiKeyRef: "${LOCAL_TTS_KEY}", voice: "alloy", speed: 1 });
    expect(JSON.stringify(resolved)).not.toMatch(/sk-/);
  });

  it("lets an inline prompt win over promptFile, and resolves promptFile inside the home", () => {
    expect(resolve({ enabled: true, prompt: "Be brief.", promptFile: "p.md" })).toMatchObject({ prompt: "Be brief.", promptFile: null });
    expect(resolve({ enabled: true, promptFile: "voice/p.md" })).toMatchObject({ prompt: DEFAULT_VOICE_PROMPT, promptFile: path.join(HOME, "voice", "p.md") });
  });
});
