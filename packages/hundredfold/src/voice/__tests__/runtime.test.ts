import { describe, expect, it } from "vitest";
import { createVoiceEmitTee } from "../emit-tee.js";
import { createVoiceRuntime } from "../runtime.js";
import { DEFAULT_HOLDING_LINE, DEFAULT_VOICE_PROMPT, resolveVoiceConfig } from "../resolved-config.js";
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

describe("the resolved configuration (a stand-in for the config work)", () => {
  it("fills every default, and carries neither a key nor an address", () => {
    const resolved = resolveVoiceConfig(config({
      enabled: true, stt: { provider: "openai", apiKey: "${SECRET_NAME}", baseUrl: "https://example.test" }, tts: { voice: "af_x" },
    }));
    expect(resolved).toMatchObject({
      mode: "hands-free", language: "en", prompt: DEFAULT_VOICE_PROMPT, holdingLine: DEFAULT_HOLDING_LINE,
      stt: { provider: "openai", model: null }, tts: { provider: "local", voice: "af_x", speed: 1 },
      vad: { threshold: 0.5, minSpeechMs: 250, silenceMs: 700, prerollMs: 300 },
      bargeIn: { enabled: true, minSpeechMs: 250, onsetThreshold: 0.02 },
      autoBackground: { enabled: true, afterSeconds: 5 },
      limits: { maxUtteranceSeconds: 60, maxConcurrentAttachments: 4 }, local: { device: "auto" },
    });
    const text = JSON.stringify(resolved);
    expect(text).not.toContain("SECRET_NAME");
    expect(text).not.toContain("example.test");
  });

  it("takes what is set over the default, section by section, and ignores what is unset", () => {
    const resolved = resolveVoiceConfig(config({
      enabled: true, mode: "push-to-talk", bargeIn: { enabled: false }, autoBackground: { afterSeconds: 12 },
      limits: { maxConcurrentAttachments: 2, maxUtteranceSeconds: undefined }, holdingLine: "One moment.",
    }));
    expect(resolved).toMatchObject({
      mode: "push-to-talk", holdingLine: "One moment.", bargeIn: { enabled: false, minSpeechMs: 250 },
      autoBackground: { enabled: true, afterSeconds: 12 }, limits: { maxConcurrentAttachments: 2, maxUtteranceSeconds: 60 },
    });
  });

  it("is null for anything but enabled: true", () => {
    expect(resolveVoiceConfig(config(undefined))).toBeNull();
    expect(resolveVoiceConfig(config({ enabled: false }))).toBeNull();
  });
});

describe("the provider stand-in", () => {
  it("every built-in provider says it is unavailable until the providers are merged, so an enabled voice answers honestly", async () => {
    const { createVoiceProviders, setVoiceProvidersForTest } = await import("../provider-factory.js");
    const resolved = resolveVoiceConfig(config({ enabled: true }))!;
    const set = createVoiceProviders(resolved);
    expect(set.stt.status().available).toBe(false);
    expect(set.tts.status().available).toBe(false);
    expect(() => set.createVad()).toThrow(/not installed/);
    await expect((async () => { for await (const _chunk of set.tts.synthesize("x", { language: "en", signal: new AbortController().signal })) { /* none */ } })()).rejects.toThrow(/not installed/);
    expect(() => set.stt.open({ language: "en", sampleRate: 16_000, signal: new AbortController().signal })).toThrow(/not installed/);
    // The seam replaces them, and null puts them back.
    const fake = { stt: set.stt, tts: set.tts, createVad: set.createVad };
    setVoiceProvidersForTest(() => ({ ...fake, tts: { ...set.tts, id: "swapped" } }));
    expect(createVoiceProviders(resolved).tts.id).toBe("swapped");
    setVoiceProvidersForTest(null);
    expect(createVoiceProviders(resolved).tts.id).toBe("unavailable");
  });
});
