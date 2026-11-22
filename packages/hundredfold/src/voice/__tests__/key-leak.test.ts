/**
 * SC-007: a provider key never reaches a client. A sentinel key is set in the
 * environment and named by the configuration, and every provider is as hostile
 * as it can be: its errors and its unavailability reason carry the key. A full
 * attachment is driven over a real socket and nothing the client receives, or
 * any close reason, may hold the sentinel.
 */
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { collect, hello, open, startRoute, waitFor, type Route } from "./route-harness.js";
import { redactorFor } from "../runtime.js";
import type { HundredfoldConfig } from "../../shared/types.js";
import type WebSocket from "ws";

const SENTINEL = "sk-sentinel-7f3a9c2e1d4b";
let registry: typeof import("../../sessions/registry.js");
let route: Route | undefined;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  registry = await import("../../sessions/registry.js");
  process.env.VOICE_TEST_KEY = SENTINEL;
}, 120_000);

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await route?.close();
  route = undefined;
});

const VOICE = { enabled: true, stt: { provider: "openai", apiKey: "${VOICE_TEST_KEY}" }, tts: { provider: "openai", apiKey: "${VOICE_TEST_KEY}" } } as const;

describe("no provider key on the wire", () => {
  it("a full attachment with providers that leak the key in every message they can: nothing received holds it", async () => {
    route = await startRoute(VOICE as never);
    const r = route;
    const session = registry.createSession({ engine: "codex", source: "web", sourceRef: "web:voice-leak-1" });
    const outcome = await open(r.url(session.id));
    if (outcome.kind !== "open") throw new Error("not open");
    sockets.push(outcome.ws);
    const got = collect(outcome.ws);
    outcome.ws.send(hello());
    await waitFor(() => got.text.some((f) => f.type === "ready"));

    // Speech recognition fails with the key in its message.
    for (let i = 0; i < 4; i += 1) outcome.ws.send(Buffer.alloc(640, 1));
    await waitFor(() => r.vads.length > 0);
    r.vads[0].start(0);
    await waitFor(() => r.stt.streams.length > 0);
    r.stt.last().emit({ type: "error", message: `401 for key ${SENTINEL}` });
    await waitFor(() => got.text.some((f) => f.code === "stt_failed"));

    // Speech synthesis fails with the key in its message, while a reply is spoken.
    r.tts.failOn = "leaky";
    (r.tts as unknown as { synthesize: unknown }).synthesize = async function* () { throw new Error(`bad key ${SENTINEL}`); };
    r.runtime.hub.onEvent("session:started", { sessionId: session.id });
    r.runtime.hub.onEvent("session:delta", { sessionId: session.id, type: "text", content: "A leaky sentence. " });
    r.runtime.hub.onEvent("session:completed", { sessionId: session.id, result: "", error: null });
    await waitFor(() => got.text.some((f) => f.code === "tts_failed"));

    expect(got.raw.join("\n")).not.toContain(SENTINEL);
    expect(got.raw.some((t) => t.includes("sk-"))).toBe(false);

    outcome.ws.send(JSON.stringify({ type: "bye" }));
    const closed = await got.closed;
    expect(closed.reason).not.toContain(SENTINEL);
    expect(got.binary.every((b) => !b.includes(SENTINEL))).toBe(true);
  });

  it("a provider that says it is unavailable with the key in the reason: the client reads it redacted, and the close reason is clean", async () => {
    route = await startRoute(VOICE as never);
    const r = route;
    r.stt.available = false;
    r.stt.reason = `OpenAI rejected the key ${SENTINEL}; check OPENAI_API_KEY`;
    const session = registry.createSession({ engine: "codex", source: "web", sourceRef: "web:voice-leak-2" });
    const outcome = await open(r.url(session.id));
    if (outcome.kind !== "open") throw new Error("not open");
    sockets.push(outcome.ws);
    const got = collect(outcome.ws);
    outcome.ws.send(hello());
    const closed = await got.closed;
    const error = got.text.find((f) => f.code === "speech_unavailable");
    expect(error).toBeDefined();
    expect(String(error?.message)).toContain("[redacted]");
    expect(String(error?.message)).toContain("OPENAI_API_KEY");
    expect(JSON.stringify(got.text)).not.toContain(SENTINEL);
    expect(closed.reason).not.toContain(SENTINEL);
  });

  it("with the gateway's own providers (the registry), a missing key is reported by its variable's name, and shutdown closes the shared sidecar", async () => {
    const { SpeechInstaller } = await import("../sidecar/bootstrap.js");
    const cancel = vi.spyOn(SpeechInstaller.prototype, "cancel");
    try {
      delete process.env.VOICE_MISSING_KEY;
      route = await startRoute({ enabled: true, stt: { provider: "openai", apiKey: "${VOICE_MISSING_KEY}" }, tts: { provider: "openai", apiKey: "${VOICE_TEST_KEY}" } } as never, { realProviders: true });
      const session = registry.createSession({ engine: "codex", source: "web", sourceRef: "web:voice-leak-real" });
      const outcome = await open(route.url(session.id));
      if (outcome.kind !== "open") throw new Error("not open");
      sockets.push(outcome.ws);
      const got = collect(outcome.ws);
      outcome.ws.send(hello());
      await got.closed;
      const error = got.text.find((f) => f.code === "speech_unavailable");
      expect(String(error?.message)).toContain("VOICE_MISSING_KEY");
      expect(got.raw.join("\n")).not.toContain(SENTINEL);
      // The config API makes the shared local pair (sidecar + install) on first ask; the runtime's shutdown closes it.
      const { sharedLocalSpeech } = await import("../providers/registry.js");
      const { resolveVoiceConfig } = await import("../../shared/voice-config.js");
      sharedLocalSpeech(resolveVoiceConfig({ voice: { enabled: true } })!);
      route.runtime.shutdown();
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      cancel.mockRestore();
    }
  });

  it("the gateway's config API does not carry the key: the configuration names a variable, never its value", async () => {
    const tmpConfig = { voice: VOICE } as unknown as HundredfoldConfig;
    const redact = redactorFor(() => tmpConfig);
    expect(redact(`key=${SENTINEL} and again ${SENTINEL}`)).toBe("key=[redacted] and again [redacted]");
    expect(redact("nothing to hide")).toBe("nothing to hide");
    const { sanitizeConfigForApi } = await import("../../gateway/config-payload.js");
    const payload = JSON.stringify(sanitizeConfigForApi({ gateway: {}, engines: {}, voice: VOICE } as never));
    expect(payload).not.toContain(SENTINEL);
  });

  it("GET /api/voice/config through the real API: the reply names providers and their state, never the key", async () => {
    const api = await import("../../gateway/api.js");
    let voice: unknown;
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: {} }, sessions: {}, voice }),
      connectors: new Map(), startTime: Date.now(), gatewayAuthToken: "test-token", emit: () => undefined,
      sessionManager: { getEngines: () => new Map(), getEngine: () => undefined, getQueue: () => ({}) },
    } as unknown as import("../../gateway/api.js").ApiContext;
    const get = async (): Promise<{ status: number; text: string }> => {
      const chunks: Buffer[] = [];
      let status = 0;
      const res = {
        writeHead(code: number) { status = code; return res; }, setHeader() { /* none */ }, headersSent: false,
        write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true; },
        end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); },
      } as unknown as ServerResponse;
      const req = Object.assign(Readable.from([]), { method: "GET", url: "/api/voice/config", headers: { host: "gateway.test", authorization: "Bearer test-token" } });
      await api.handleApiRequest(req as never, res, ctx);
      return { status, text: Buffer.concat(chunks).toString("utf8") };
    };
    const compatible = { provider: "openai-compatible", baseUrl: "http://127.0.0.1:9", model: "m", apiKey: "${VOICE_TEST_KEY}" };
    for (const config of [VOICE, { enabled: true, stt: compatible, tts: { ...compatible, voice: "v" } }]) {
      voice = config;
      const reply = await get();
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.text)).toMatchObject({ enabled: true, stt: { provider: config.stt.provider }, tts: { provider: config.tts.provider } });
      expect(reply.text).not.toContain(SENTINEL);
      expect(reply.text).not.toContain("VOICE_TEST_KEY"); // not even the variable's name: the client needs neither
    }
  });

  it("a key written into the configuration by mistake is redacted too", () => {
    const cfg = { voice: { enabled: true, stt: { apiKey: "sk-written-in-by-mistake-1234" } } } as unknown as HundredfoldConfig;
    expect(redactorFor(() => cfg)("it said sk-written-in-by-mistake-1234 here")).toBe("it said [redacted] here");
  });

  it("redaction ignores a variable that is unset or too short to be a key", () => {
    delete process.env.VOICE_UNSET_KEY;
    process.env.VOICE_SHORT_KEY = "abc";
    const cfg = { voice: { enabled: true, stt: { apiKey: "${VOICE_UNSET_KEY}" }, tts: { apiKey: "${VOICE_SHORT_KEY}" } } } as unknown as HundredfoldConfig;
    expect(redactorFor(() => cfg)("an abc in the text")).toBe("an abc in the text");
  });
});
