import path from "node:path";
import { describe, expect, it } from "vitest";
import { VOICE_SPEED_DEFAULT, VOICE_SPEED_MAX, VOICE_SPEED_MIN, VOICE_SPEED_PRESETS } from "@hundredfold/gateway-events";
import { validateConfigShape } from "../config.js";
import { DEFAULT_HOLDING_LINE, DEFAULT_LOCAL_STT_MODEL, DEFAULT_PHANTOM_PHRASES, DEFAULT_VOICE_PROMPT, LOCAL_STT_MODELS, localSttModel, resolveVoiceConfig, voiceConfigProblems, voiceOffReason } from "../voice-config.js";

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
      stt: { provider: "local", model: "parakeet-unified-en-0.6b" }, tts: { provider: "local", voice: "bf_emma", speed: 0.5 },
      vad: { threshold: 0, minSpeechMs: 50, silenceMs: 5000, unfinishedHoldMs: 5000, prerollMs: 1000 },
      filter: { minConfidence: 1, noSpeechThreshold: 0, phantomMaxMs: 5000, phantomPhrases: [] },
      bargeIn: { enabled: false, minSpeechMs: 2000, onsetThreshold: 1 },
      autoBackground: { enabled: true, afterSeconds: 600 },
      cues: { enabled: false, volume: 1 },
      prompt: "x".repeat(8000), stylePrompt: "z".repeat(2000), holdingLine: "y".repeat(300),
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
    ["voice.vad.unfinishedHoldMs", { vad: { unfinishedHoldMs: -1 } }, "voice.vad.unfinishedHoldMs"],
    ["voice.vad.unfinishedHoldMs", { vad: { unfinishedHoldMs: 5001 } }, "voice.vad.unfinishedHoldMs"],
    ["voice.vad.prerollMs", { vad: { prerollMs: 1001 } }, "voice.vad.prerollMs"],
    ["voice.filter.minConfidence", { filter: { minConfidence: 1.1 } }, "voice.filter.minConfidence"],
    ["voice.filter.noSpeechThreshold", { filter: { noSpeechThreshold: -0.1 } }, "voice.filter.noSpeechThreshold"],
    ["voice.filter.phantomMaxMs", { filter: { phantomMaxMs: 5001 } }, "voice.filter.phantomMaxMs"],
    ["voice.filter.phantomMaxMs", { filter: { phantomMaxMs: 250.5 } }, "voice.filter.phantomMaxMs"],
    ["voice.filter.phantomPhrases", { filter: { phantomPhrases: "amen" } }, "voice.filter.phantomPhrases must be a list"],
    ["voice.filter.phantomPhrases[1]", { filter: { phantomPhrases: ["amen", " "] } }, "voice.filter.phantomPhrases[1]"],
    ["voice.filter.phantomPhrases[0]", { filter: { phantomPhrases: [3] } }, "voice.filter.phantomPhrases[0]"],
    ["voice.filter", { filter: 5 }, "voice.filter must be a mapping"],
    ["voice.bargeIn.enabled", { bargeIn: { enabled: 1 } }, "voice.bargeIn.enabled"],
    ["voice.bargeIn.minSpeechMs", { bargeIn: { minSpeechMs: 2001 } }, "voice.bargeIn.minSpeechMs"],
    ["voice.bargeIn.onsetThreshold", { bargeIn: { onsetThreshold: -0.1 } }, "voice.bargeIn.onsetThreshold"],
    ["voice.autoBackground.enabled", { autoBackground: { enabled: "on" } }, "voice.autoBackground.enabled"],
    ["voice.autoBackground.afterSeconds", { autoBackground: { afterSeconds: 0.5 } }, "voice.autoBackground.afterSeconds"],
    ["voice.autoBackground.afterSeconds", { autoBackground: { afterSeconds: 601 } }, "voice.autoBackground.afterSeconds"],
    ["voice.cues.enabled", { cues: { enabled: "on" } }, "voice.cues.enabled"],
    ["voice.cues.volume", { cues: { volume: -0.1 } }, "voice.cues.volume"],
    ["voice.cues.volume", { cues: { volume: 1.5 } }, "voice.cues.volume"],
    ["voice.cues.volume", { cues: { volume: "loud" } }, "voice.cues.volume"],
    ["voice.cues", { cues: true }, "voice.cues must be a mapping"],
    ["voice.prompt", { prompt: "x".repeat(8001) }, "voice.prompt"],
    ["voice.prompt", { prompt: 4 }, "voice.prompt"],
    ["voice.stylePrompt", { stylePrompt: "z".repeat(2001) }, "voice.stylePrompt"],
    ["voice.stylePrompt", { stylePrompt: 4 }, "voice.stylePrompt"],
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

describe("the local speech-to-text model", () => {
  it("is one of the known models; the first is the default", () => {
    expect(LOCAL_STT_MODELS).toEqual(["parakeet-tdt-0.6b-v2", "parakeet-unified-en-0.6b", "parakeet-unified-en-0.6b-streaming"]);
    expect(DEFAULT_LOCAL_STT_MODEL).toBe("parakeet-tdt-0.6b-v2");
    for (const model of LOCAL_STT_MODELS) expect(problems({ stt: { provider: "local", model } })).toEqual([]);
    expect(problems({ stt: { model: "parakeet-unified-en-0.6b" } })).toEqual([]); // the provider defaults to local
  });

  it("refuses a name it does not know, naming the choices, rather than silently running the default", () => {
    const [problem, ...rest] = problems({ stt: { provider: "local", model: "parakeet-unified-en-0.6" } });
    expect(rest).toEqual([]);
    expect(problem).toContain("voice.stt.model must be one of parakeet-tdt-0.6b-v2, parakeet-unified-en-0.6b, parakeet-unified-en-0.6b-streaming");
    expect(problems({ stt: { model: "whisper-1" } })).toHaveLength(1);
  });

  it("is not checked for the hosted providers, whose model names are theirs", () => {
    expect(problems({ stt: { provider: "openai-compatible", baseUrl: "http://localhost:8000", model: "Systran/faster-whisper-large-v3" } })).toEqual([]);
    expect(problems({ stt: { provider: "openai", model: "gpt-live-transcribe" } })).toEqual([]);
  });

  it("is not checked on the text-to-speech side, where the local model is not selectable", () => {
    expect(problems({ tts: { provider: "local", model: "kokoro-v1.0" } })).toEqual([]);
  });

  it("reports an empty name once", () => {
    expect(problems({ stt: { model: "" } })).toHaveLength(1);
  });

  it("resolves to the default when none is set, and to the chosen one when set", () => {
    expect(resolveVoiceConfig({ voice: { enabled: true } }, HOME)?.stt.model).toBe("parakeet-tdt-0.6b-v2");
    expect(resolveVoiceConfig({ voice: { enabled: true, stt: { model: "parakeet-unified-en-0.6b" } } }, HOME)?.stt.model).toBe("parakeet-unified-en-0.6b");
  });

  it("is turned off with the rest of voice when the name is unknown", () => {
    expect(resolveVoiceConfig({ voice: { enabled: true, stt: { model: "nope" } } }, HOME)).toBeNull();
  });

  it("localSttModel picks the model the sidecar loads: the chosen one only when the local provider does the transcription", () => {
    expect(localSttModel({ provider: "local", model: "parakeet-unified-en-0.6b" })).toBe("parakeet-unified-en-0.6b");
    expect(localSttModel({ provider: "openai-compatible", model: "parakeet-unified-en-0.6b" })).toBe(DEFAULT_LOCAL_STT_MODEL);
    expect(localSttModel({ provider: "local", model: "parakeet-unified-en-0.6b-streaming" })).toBe("parakeet-unified-en-0.6b-streaming");
    expect(localSttModel({ provider: "local", model: "unknown" })).toBe(DEFAULT_LOCAL_STT_MODEL);
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
      vad: { threshold: 0.5, minSpeechMs: 250, silenceMs: 1000, unfinishedHoldMs: 800, prerollMs: 300 },
      filter: { minConfidence: 0.3, noSpeechThreshold: 0.8, phantomMaxMs: 500, phantomPhrases: [...DEFAULT_PHANTOM_PHRASES] },
      bargeIn: { enabled: true, minSpeechMs: 250, onsetThreshold: 0.02 },
      autoBackground: { enabled: true, afterSeconds: 5 },
      cues: { enabled: true, volume: 0.3 },
      prompt: DEFAULT_VOICE_PROMPT, promptFile: null, stylePrompt: "", holdingLine: DEFAULT_HOLDING_LINE,
      limits: { maxUtteranceSeconds: 60, maxConcurrentAttachments: 4 }, local: { device: "auto" },
    });
  });

  it("keeps what the operator set in the filter block, and `phantomPhrases: []` turns the list off rather than restoring it", () => {
    expect(resolve({ enabled: true, filter: { minConfidence: 0.5, phantomPhrases: [] } })?.filter).toEqual({ minConfidence: 0.5, noSpeechThreshold: 0.8, phantomMaxMs: 500, phantomPhrases: [] });
    expect(resolve({ enabled: true, filter: null })?.filter.phantomPhrases).toEqual([...DEFAULT_PHANTOM_PHRASES]);
  });

  it("loads a config with no cues block, a partial one, or a null one, at the defaults", () => {
    expect(resolve({ enabled: true })?.cues).toEqual({ enabled: true, volume: 0.3 });
    expect(resolve({ enabled: true, cues: {} })?.cues).toEqual({ enabled: true, volume: 0.3 });
    expect(resolve({ enabled: true, cues: null })?.cues).toEqual({ enabled: true, volume: 0.3 });
    expect(resolve({ enabled: true, cues: { volume: 0.7 } })?.cues).toEqual({ enabled: true, volume: 0.7 });
    expect(resolve({ enabled: true, cues: { enabled: false } })?.cues).toEqual({ enabled: false, volume: 0.3 });
  });

  it("keeps what the operator set and fills the rest around it", () => {
    const resolved = resolve({
      enabled: true, mode: "push-to-talk", tts: { voice: "bf_emma", speed: 1.25 }, vad: { silenceMs: 900 },
      bargeIn: { enabled: false }, limits: { maxConcurrentAttachments: 2 }, local: { device: "cpu" }, holdingLine: "One moment.",
    })!;
    expect(resolved.mode).toBe("push-to-talk");
    expect(resolved.tts).toMatchObject({ voice: "bf_emma", speed: 1.25 });
    expect(resolved.vad).toEqual({ threshold: 0.5, minSpeechMs: 250, silenceMs: 900, unfinishedHoldMs: 800, prerollMs: 300 });
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

  it("resolves the style prompt trimmed, and to empty when unset or blank", () => {
    expect(resolve({ enabled: true, stylePrompt: "  Short and funny.\n" })).toMatchObject({ stylePrompt: "Short and funny." });
    expect(resolve({ enabled: true, stylePrompt: "   " })).toMatchObject({ stylePrompt: "" });
    expect(resolve({ enabled: true })).toMatchObject({ stylePrompt: "" });
  });

  it("lets an inline prompt win over promptFile, and resolves promptFile inside the home", () => {
    expect(resolve({ enabled: true, prompt: "Be brief.", promptFile: "p.md" })).toMatchObject({ prompt: "Be brief.", promptFile: null });
    expect(resolve({ enabled: true, promptFile: "voice/p.md" })).toMatchObject({ prompt: DEFAULT_VOICE_PROMPT, promptFile: path.join(HOME, "voice", "p.md") });
  });

  describe("the speaking rate", () => {
    it("is 1 when unset, and a voice block with no tts block, or an empty one, still loads", () => {
      expect(resolve({ enabled: true })!.tts.speed).toBe(1);
      expect(resolve({ enabled: true, tts: {} })!.tts.speed).toBe(1);
      expect(voiceConfigProblems({ enabled: true, tts: { voice: "af_heart" } }, HOME)).toEqual([]);
    });

    it("accepts every preset the settings offer and both ends of the range", () => {
      for (const speed of [...VOICE_SPEED_PRESETS.map((preset) => preset.speed), VOICE_SPEED_MIN, VOICE_SPEED_MAX]) {
        expect(voiceConfigProblems({ enabled: true, tts: { speed } }, HOME)).toEqual([]);
        expect(resolve({ enabled: true, tts: { speed } })!.tts.speed).toBe(speed);
      }
      expect(VOICE_SPEED_PRESETS.map((preset) => preset.label)).toEqual(["Slower", "Normal", "Faster", "Fastest"]);
      expect(VOICE_SPEED_PRESETS.find((preset) => preset.label === "Normal")!.speed).toBe(VOICE_SPEED_DEFAULT);
    });

    it.each([0, 0.49, 2.01, 5, -1, Number.NaN, Infinity, "1.5", null, true])("rejects %s, naming the key, the range and what it got", (speed) => {
      const problems = voiceConfigProblems({ enabled: true, tts: { speed } }, HOME);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^voice\.tts\.speed must be a number from 0\.5 to 2 \(got /);
      expect(resolve({ enabled: true, tts: { speed } })).toBeNull();
    });
  });
});
