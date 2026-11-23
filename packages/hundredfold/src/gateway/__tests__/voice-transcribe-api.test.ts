import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleVoiceApi } from "../voice-api.js";

const SPEECH = { provider: "openai-compatible", baseUrl: "http://speech.example" };
const READY = { voice: { enabled: true, stt: SPEECH, tts: SPEECH } };

afterEach(() => { vi.unstubAllGlobals(); });

function request(body: Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage;
  stream.headers = headers;
  return stream;
}

function response() {
  const emitter = new EventEmitter();
  let status = 0;
  const chunks: Buffer[] = [];
  const state = { ended: false };
  const res = Object.assign(emitter, {
    get writableEnded() { return state.ended; },
    writeHead(next: number) { status = next; return res; },
    setHeader() { return res; },
    end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.from(chunk)); state.ended = true; },
  }) as unknown as ServerResponse;
  return { res, get status() { return status; }, get body() { return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; } };
}

async function post(config: unknown, body: Buffer, query = "", headers: Record<string, string> = {}) {
  const out = response();
  const pathname = "/api/voice/transcribe";
  await handleVoiceApi(request(body, headers), out.res, { method: "POST", pathname, url: new URL(`http://x${pathname}${query}`) }, { getConfig: () => config as never });
  return out;
}

describe("POST /api/voice/transcribe", () => {
  it("answers 409 with the reason while voice mode is off", async () => {
    const out = await post({}, Buffer.alloc(3200));
    expect(out.status).toBe(409);
    expect(String(out.body.error)).toMatch(/turn voice mode on/);
  });

  it("answers 409 when the speech provider is not ready", async () => {
    const config = { voice: { enabled: true, stt: { ...SPEECH, apiKey: "${DICTATION_ROUTE_KEY_NOT_SET}" }, tts: SPEECH } };
    const out = await post(config, Buffer.alloc(3200));
    expect(out.status).toBe(409);
    expect(String(out.body.error)).toMatch(/not ready/);
  });

  it("refuses an empty body and audio that is not whole 16-bit samples", async () => {
    expect((await post(READY, Buffer.alloc(0))).status).toBe(400);
    expect((await post(READY, Buffer.alloc(3201))).status).toBe(400);
  });

  it("refuses a recording longer than 20 minutes, before reading it when the length is declared", async () => {
    const out = await post(READY, Buffer.alloc(10), "", { "content-length": String(41 * 1024 * 1024) });
    expect(out.status).toBe(413);
  });

  it("refuses a recording that outgrows the limit with no length declared, without reading the rest of it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const megabyte = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const stream = Readable.from((function* () { for (;;) { sent += 1; yield megabyte; } })()) as unknown as IncomingMessage;
    stream.headers = {};
    const out = response();
    const pathname = "/api/voice/transcribe";
    await handleVoiceApi(stream, out.res, { method: "POST", pathname, url: new URL(`http://x${pathname}`) }, { getConfig: () => READY as never });
    expect(out.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    // The sender is cut off at a bounded point rather than read for as long as it keeps sending.
    await vi.waitFor(() => { expect((stream as unknown as Readable).destroyed).toBe(true); });
    expect(sent).toBeLessThan(400);
  });

  it("transcribes the posted PCM through the voice provider, in the configured language by default", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: " hello there " }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await post({ voice: { ...READY.voice, language: "en" } }, Buffer.alloc(32_000));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ text: "hello there" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: FormData }];
    expect(url).toBe("http://speech.example/v1/audio/transcriptions");
    expect(init.body.get("language")).toBe("en");
  });

  it("takes the language from the query string", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "bonjour" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await post(READY, Buffer.alloc(32_000), "?language=fr");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: FormData }];
    expect(init.body.get("language")).toBe("fr");
  });

  it("answers 500 with a message when the provider fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const out = await post(READY, Buffer.alloc(32_000));
    expect(out.status).toBe(500);
    expect(String(out.body.error)).toMatch(/Transcription failed/);
  });
});
