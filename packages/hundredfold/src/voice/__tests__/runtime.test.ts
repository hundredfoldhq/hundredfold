import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVoiceEmitTee } from "../emit-tee.js";
import { createVoiceRuntime, memoisedConfig, withPromptFile } from "../runtime.js";
import { DEFAULT_HOLDING_LINE, DEFAULT_VOICE_PROMPT, resolveVoiceConfig } from "../../shared/voice-config.js";
import type { HundredfoldConfig } from "../../shared/types.js";

const config = (voice: unknown) => ({ gateway: {}, engines: {}, voice }) as unknown as HundredfoldConfig;
const noContext = () => ({}) as never;

describe("voice is off unless the configuration turns it on (FR-021)", () => {
  it.each([[undefined], [{}], [{ enabled: false }], [{ enabled: "yes" }], [{ mode: "hands-free" }]])("no runtime for voice = %j", (voice) => {
    expect(createVoiceRuntime({ getConfig: () => config(voice), getContext: noContext, operatorAuthenticated: () => true })).toBeNull();
  });

  it("a runtime only when enabled is exactly true; its socket server and tee exist, and shutdown closes the socket server", () => {
    const runtime = createVoiceRuntime({ getConfig: () => config({ enabled: true }), getContext: noContext, operatorAuthenticated: () => true });
    expect(runtime).not.toBeNull();
    expect(typeof runtime?.wrapEmit).toBe("function");
    expect(runtime?.wss).toBeDefined();
    runtime?.shutdown();
  });

  it("with voice off the gateway's emit is the gateway's own: nothing wraps it, so nothing in voice can run", () => {
    // server.ts wraps only when createVoiceRuntime returns a runtime; with none, `emit` is the original function.
    const original = () => undefined;
    const runtime = createVoiceRuntime({ getConfig: () => config({ enabled: false }), getContext: noContext, operatorAuthenticated: () => true });
    const emit = runtime ? runtime.wrapEmit(original as never) : original;
    expect(emit).toBe(original);
  });
});

describe("the emit tee", () => {
  const log = { info: () => undefined, warn: (m: string) => warnings.push(m) };
  const warnings: string[] = [];

  it("runs the gateway's emit first, unchanged, then hands the event to the hub", () => {
    const order: string[] = [];
    const emit = createVoiceEmitTee(((event: string) => { order.push(`emit:${event}`); }) as never, { onEvent: (event) => { order.push(`hub:${event}`); } }, log);
    (emit as unknown as (e: string, p: unknown) => void)("session:delta", { sessionId: "s", type: "text", content: "x" });
    expect(order).toEqual(["emit:session:delta", "hub:session:delta"]);
  });

  it("a failure in voice is logged, never thrown into the gateway", () => {
    warnings.length = 0;
    const seen: string[] = [];
    const emit = createVoiceEmitTee(((event: string) => { seen.push(event); }) as never, { onEvent: () => { throw new Error("voice broke"); } }, log);
    expect(() => (emit as unknown as (e: string, p: unknown) => void)("session:started", { sessionId: "s" })).not.toThrow();
    expect(seen).toEqual(["session:started"]);
    expect(warnings[0]).toContain("voice broke");
  });
});

describe("the configuration the hub runs on", () => {
  it("is the real resolver's: defaults filled, and a key carried only as the reference it was given by, never its value", () => {
    process.env.SECRET_NAME_FOR_TEST = "sk-resolved-value-1234567";
    const resolved = memoisedConfig(() => config({ enabled: true, stt: { provider: "openai", apiKey: "${SECRET_NAME_FOR_TEST}" }, tts: { voice: "af_x" } }))();
    expect(resolved).toMatchObject({
      mode: "hands-free", language: "en", prompt: DEFAULT_VOICE_PROMPT, promptFile: null, holdingLine: DEFAULT_HOLDING_LINE,
      stt: { provider: "openai", model: "gpt-live-transcribe", apiKeyRef: "${SECRET_NAME_FOR_TEST}" },
      tts: { provider: "local", model: "kokoro-v1.0", voice: "af_x", speed: 1, apiKeyRef: null },
      limits: { maxUtteranceSeconds: 60, maxConcurrentAttachments: 4 }, local: { device: "auto" },
    });
    const text = JSON.stringify(resolved);
    expect(text).not.toContain("sk-resolved-value");
    expect(text).not.toContain('"apiKey"');
  });

  it("is null for anything but a valid voice block with enabled: true", () => {
    expect(resolveVoiceConfig(config(undefined))).toBeNull();
    expect(resolveVoiceConfig(config({ enabled: false }))).toBeNull();
    expect(createVoiceRuntime({ getConfig: () => config({ enabled: true, mode: "shouting" }), getContext: noContext, operatorAuthenticated: () => true })).toBeNull();
  });

  it("reads voice.promptFile from the instance home, and resolves again only when the voice block changes", () => {
    const home = process.env.HUNDREDFOLD_HOME!;
    fs.writeFileSync(path.join(home, "voice-prompt.md"), "  Speak like a ship's captain.\n");
    let current = config({ enabled: true, promptFile: "voice-prompt.md" });
    const read = memoisedConfig(() => current);
    expect(read()!.prompt).toBe("Speak like a ship's captain.");
    fs.writeFileSync(path.join(home, "voice-prompt.md"), "Changed.");
    expect(read()!.prompt).toBe("Speak like a ship's captain."); // same voice block: not read again
    current = config({ enabled: true, promptFile: "voice-prompt.md", language: "en" });
    expect(read()!.prompt).toBe("Changed.");
    current = config({ enabled: true, prompt: "Inline wins.", promptFile: "voice-prompt.md" });
    expect(read()!.prompt).toBe("Inline wins.");
  });

  it("keeps the built-in prompt when the prompt file is missing or empty, and caps a long one", () => {
    const base = resolveVoiceConfig(config({ enabled: true }))!;
    const withFile = { ...base, promptFile: "/nowhere/voice-prompt.md" };
    expect(withPromptFile(withFile).prompt).toBe(DEFAULT_VOICE_PROMPT);
    expect(withPromptFile(withFile, () => "  \n").prompt).toBe(DEFAULT_VOICE_PROMPT);
    expect(withPromptFile(withFile, () => "x".repeat(9000)).prompt).toHaveLength(8000);
    expect(withPromptFile(base, () => { throw new Error("must not read"); })).toBe(base);
  });
});

describe("the provider registry behind the hub", () => {
  it("builds the providers the config names, and the test seam replaces them until reset", async () => {
    const { createVoiceProviders, setVoiceProvidersForTest } = await import("../providers/registry.js");
    const resolved = resolveVoiceConfig(config({
      enabled: true, stt: { provider: "openai", apiKey: "${VOICE_KEY_UNSET_FOR_TEST}" }, tts: { provider: "openai", apiKey: "${VOICE_KEY_UNSET_FOR_TEST}" },
    }))!;
    const set = createVoiceProviders(resolved);
    expect([set.stt.id, set.tts.id]).toEqual(["openai", "openai"]);
    expect(set.stt.status()).toMatchObject({ available: false, reason: expect.stringContaining("VOICE_KEY_UNSET_FOR_TEST") });
    expect(set.createVad()).toBeDefined();
    setVoiceProvidersForTest(() => ({ ...set, tts: { ...set.tts, id: "swapped" } }));
    try {
      expect(createVoiceProviders(resolved).tts.id).toBe("swapped");
    } finally {
      setVoiceProvidersForTest(null);
    }
    expect(createVoiceProviders(resolved).tts.id).toBe("openai");
  });
});
