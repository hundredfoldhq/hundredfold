/**
 * SC-007: a provider key never reaches a client. A sentinel key is set in the
 * environment and named by the configuration, and every provider is as hostile
 * as it can be: its errors and its unavailability reason carry the key. A full
 * attachment is driven over a real socket and nothing the client receives, or
 * any close reason, may hold the sentinel.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

  it("the gateway's config API does not carry the key: the configuration names a variable, never its value", async () => {
    const tmpConfig = { voice: VOICE } as unknown as HundredfoldConfig;
    const redact = redactorFor(() => tmpConfig);
    expect(redact(`key=${SENTINEL} and again ${SENTINEL}`)).toBe("key=[redacted] and again [redacted]");
    expect(redact("nothing to hide")).toBe("nothing to hide");
    const { sanitizeConfigForApi } = await import("../../gateway/config-payload.js");
    const payload = JSON.stringify(sanitizeConfigForApi({ gateway: {}, engines: {}, voice: VOICE } as never));
    expect(payload).not.toContain(SENTINEL);
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
