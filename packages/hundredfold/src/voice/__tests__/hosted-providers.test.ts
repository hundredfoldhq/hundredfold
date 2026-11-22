import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { resolveVoiceConfig, type ResolvedVoiceConfig } from "../../shared/voice-config.js";
import type { SttEvent, SttProvider } from "../provider.js";
import { iso6391, parseWav, toWav } from "../providers/audio.js";
import { EnergyVad } from "../providers/energy-vad.js";
import { LocalSttProvider, LocalTtsProvider } from "../providers/local.js";
import { OpenAiSttProvider, OpenAiTtsProvider } from "../providers/openai.js";
import { OpenAiCompatibleSttProvider, OpenAiCompatibleTtsProvider } from "../providers/openai-compatible.js";
import { createSttProvider, createTtsProvider, createVad, closeSharedLocalSpeech } from "../providers/registry.js";
import type { SpeechInstaller } from "../sidecar/bootstrap.js";
import type { SpeechSidecarClient } from "../sidecar/client.js";

const KEY = "sk-test-sentinel-0123456789";
const ENV = { OPENAI_API_KEY: KEY, LOCAL_KEY: "local-secret-key" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(10);
}

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); closeSharedLocalSpeech(); });

const side = (extra: Record<string, unknown> = {}) => ({ provider: "openai" as const, model: "gpt-live-transcribe", baseUrl: null, apiKeyRef: "${OPENAI_API_KEY}", ...extra });
const tts = (extra: Record<string, unknown> = {}) => ({ ...side({ model: "gpt-4o-mini-tts" }), voice: "marin", speed: 1, ...extra });
const opts = (signal = new AbortController().signal) => ({ language: "en", sampleRate: 16_000, signal });
const pcm = (ms: number, amp = 0): Buffer => {
  const buffer = Buffer.alloc(ms * 32);
  if (amp) for (let index = 0; index < buffer.length / 2; index += 1) buffer.writeInt16LE(index % 2 ? amp : -amp, index * 2);
  return buffer;
};

function collect(stream: { on(handler: (event: SttEvent) => void): void }): SttEvent[] {
  const events: SttEvent[] = [];
  stream.on((event) => events.push(event));
  return events;
}

// ── a fake Realtime transcription server ─────────────────────────────────────

interface FakeRealtime { url: string; sockets: ServerSocket[]; received: Array<Record<string, any>>; headers: http.IncomingHttpHeaders[]; paths: string[] }

async function realtime(script: (event: Record<string, any>, socket: ServerSocket, state: { audioBytes: number }) => void): Promise<FakeRealtime> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const fake: FakeRealtime = { url: "", sockets: [], received: [], headers: [], paths: [] };
  wss.on("connection", (socket, request) => {
    fake.sockets.push(socket);
    fake.headers.push(request.headers);
    fake.paths.push(request.url ?? "");
    const state = { audioBytes: 0 };
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as Record<string, any>;
      fake.received.push(event);
      if (event.type === "input_audio_buffer.append") state.audioBytes += Buffer.from(event.audio, "base64").length;
      script(event, socket, state);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => { for (const socket of fake.sockets) socket.terminate(); wss.close(); server.close(); });
  fake.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

/** The server a well-behaved Realtime transcription session looks like. */
const standardScript = (words: string[]) => (event: Record<string, any>, socket: ServerSocket) => {
  const send = (payload: Record<string, unknown>) => socket.send(JSON.stringify(payload));
  if (event.type === "session.update") send({ type: "session.updated" });
  if (event.type === "input_audio_buffer.commit") {
    send({ type: "input_audio_buffer.committed", item_id: "item_1" });
    for (const word of words) send({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_1", delta: word });
    send({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: words.join("").trim() });
  }
};

describe("OpenAI STT", () => {
  const provider = (fake: FakeRealtime, extra: Record<string, unknown> = {}) =>
    new OpenAiSttProvider(side(extra), { env: ENV, endpoints: { ws: fake.url, http: "" } });

  it("opens a transcription session with the key in the header, never in the URL", async () => {
    const fake = await realtime(standardScript(["hello"]));
    const stream = provider(fake).open(opts());
    collect(stream);
    stream.write(pcm(40));
    await until(() => fake.received.length > 1);
    expect(fake.paths[0]).toBe("/v1/realtime?intent=transcription");
    expect(fake.headers[0]!.authorization).toBe(`Bearer ${KEY}`);
    expect(fake.paths[0]).not.toContain(KEY);
    expect(fake.received[0]).toEqual({
      type: "session.update",
      session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe", languages: ["en"] }, turn_detection: null } } },
    });
    stream.abort();
  });

  it("sends the audio resampled to 24 kHz, in order, and commits at end()", async () => {
    const fake = await realtime(standardScript(["hello"]));
    const stream = provider(fake).open(opts());
    const events = collect(stream);
    stream.write(pcm(100)); // 3200 bytes at 16 kHz, written before the session is ready
    stream.write(pcm(100));
    stream.end();
    await until(() => events.some((event) => event.type === "final"));
    const types = fake.received.map((event) => event.type);
    expect(types).toEqual(["session.update", "input_audio_buffer.append", "input_audio_buffer.append", "input_audio_buffer.commit"]);
    expect(Buffer.from(fake.received[1]!.audio, "base64").length).toBe(4800); // 3200 bytes of 16 kHz = 4800 of 24 kHz
  });

  it("emits cumulative partials from the incremental deltas, then one final", async () => {
    const fake = await realtime(standardScript(["what ", "is the ", "time"]));
    const stream = provider(fake).open(opts());
    const events = collect(stream);
    stream.write(pcm(60));
    stream.end();
    await until(() => events.some((event) => event.type === "final"));
    expect(events).toEqual([
      { type: "partial", text: "what " },
      { type: "partial", text: "what is the " },
      { type: "partial", text: "what is the time" },
      { type: "final", text: "what is the time" },
    ]);
    await sleep(50);
    expect(events).toHaveLength(4);
  });

  it("answers an utterance with no audio with an empty final, without touching the buffer", async () => {
    const fake = await realtime(standardScript([]));
    const stream = provider(fake).open(opts());
    const events = collect(stream);
    stream.end();
    await until(() => events.length > 0);
    expect(events).toEqual([{ type: "final", text: "" }]);
    await sleep(50);
    expect(fake.received.map((event) => event.type)).not.toContain("input_audio_buffer.commit");
  });

  it("aborting mid-stream closes the connection and emits nothing", async () => {
    const fake = await realtime(standardScript(["x"]));
    const controller = new AbortController();
    const stream = provider(fake).open(opts(controller.signal));
    const events = collect(stream);
    stream.write(pcm(60));
    await until(() => fake.received.length > 1);
    controller.abort();
    stream.end();
    await until(() => fake.sockets[0]!.readyState === 3);
    expect(fake.sockets[0]!.readyState).toBe(3);
    expect(events).toEqual([]);
    expect(fake.received.map((event) => event.type)).not.toContain("input_audio_buffer.commit");
  });

  it("reports a server error without echoing the key it was sent", async () => {
    const fake = await realtime((event, socket) => {
      if (event.type === "session.update") socket.send(JSON.stringify({ type: "session.updated" }));
      if (event.type === "input_audio_buffer.commit") socket.send(JSON.stringify({ type: "error", error: { message: `Incorrect API key provided: ${KEY}` } }));
    });
    const stream = provider(fake).open(opts());
    const events = collect(stream);
    stream.write(pcm(40));
    stream.end();
    await until(() => events.length > 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it("reports a failed transcription, and a connection that cannot be made", async () => {
    const fake = await realtime((event, socket) => {
      if (event.type === "session.update") socket.send(JSON.stringify({ type: "session.updated" }));
      if (event.type === "input_audio_buffer.commit") socket.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.failed", error: { message: "audio too short" } }));
    });
    const stream = provider(fake).open(opts());
    const events = collect(stream);
    stream.write(pcm(40));
    stream.end();
    await until(() => events.length > 0);
    expect(events[0]).toEqual({ type: "error", message: "OpenAI transcription failed: audio too short" });

    const refused = new OpenAiSttProvider(side(), { env: ENV, endpoints: { ws: "ws://127.0.0.1:9", http: "" } }).open(opts());
    const refusedEvents = collect(refused);
    await until(() => refusedEvents.length > 0);
    expect(refusedEvents[0]).toMatchObject({ type: "error" });
    expect(JSON.stringify(refusedEvents)).not.toContain(KEY);
  });

  it("is unavailable, naming the variable, when the key is not in the environment", async () => {
    const missing = new OpenAiSttProvider(side(), { env: {} });
    expect(missing.status()).toEqual({ available: false, reason: "OpenAI key not set: OPENAI_API_KEY" });
    const events = collect(missing.open(opts()));
    await sleep(20);
    expect(events).toEqual([{ type: "error", message: "OpenAI key not set: OPENAI_API_KEY" }]);
    expect(new OpenAiSttProvider(side(), { env: ENV }).status()).toEqual({ available: true });
  });
});

// ── fake HTTP speech and transcription servers ───────────────────────────────

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }

async function httpServer(handler: (request: Seen, res: http.ServerResponse, seen: Seen[]) => void): Promise<{ url: string; seen: Seen[]; aborted: () => number }> {
  const seen: Seen[] = [];
  let aborted = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("close", () => { if (!res.writableEnded) aborted += 1; });
    req.on("end", () => {
      const request = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(request);
      handler(request, res, seen);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, aborted: () => aborted };
}

async function drain(iterable: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of iterable) parts.push(part);
  return Buffer.concat(parts);
}

const synth = (provider: { synthesize(text: string, options: { language: string; signal: AbortSignal; voice?: string }): AsyncIterable<Buffer> }, signal = new AbortController().signal) =>
  provider.synthesize("Hello there.", { language: "en", signal });

describe("OpenAI TTS", () => {
  it("posts the speech request asking for raw PCM and streams it with whole samples", async () => {
    const audio = pcm(50, 1000);
    const server = await httpServer((_request, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(audio.subarray(0, 101)); // an odd split
      setTimeout(() => res.end(audio.subarray(101)), 20);
    });
    const provider = new OpenAiTtsProvider(tts(), { env: ENV, endpoints: { http: server.url, ws: "" } });
    expect(provider.sampleRate).toBe(24000);
    expect(provider.defaultVoice).toBe("marin");
    const chunks: Buffer[] = [];
    for await (const chunk of synth(provider)) { expect(chunk.length % 2).toBe(0); chunks.push(chunk); }
    expect(Buffer.concat(chunks).equals(audio)).toBe(true);
    const request = server.seen[0]!;
    expect(request.url).toBe("/v1/audio/speech");
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(request.body.toString())).toEqual({ model: "gpt-4o-mini-tts", input: "Hello there.", voice: "marin", speed: 1, response_format: "pcm" });
  });

  it("uses the voice and speed it is given over its defaults", async () => {
    const server = await httpServer((_request, res) => res.end(Buffer.alloc(4)));
    const provider = new OpenAiTtsProvider(tts(), { env: ENV, endpoints: { http: server.url, ws: "" } });
    await drain(provider.synthesize("x", { language: "en", voice: "cedar", speed: 1.5, signal: new AbortController().signal }));
    expect(JSON.parse(server.seen[0]!.body.toString())).toMatchObject({ voice: "cedar", speed: 1.5 });
  });

  it("stops reading when aborted mid-stream, and the server sees the connection drop", async () => {
    const server = await httpServer((_request, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write(Buffer.alloc(960)), 10);
      res.on("close", () => clearInterval(timer));
    });
    const controller = new AbortController();
    const provider = new OpenAiTtsProvider(tts(), { env: ENV, endpoints: { http: server.url, ws: "" } });
    let chunks = 0;
    try {
      for await (const _chunk of synth(provider, controller.signal)) {
        chunks += 1;
        if (chunks === 3) controller.abort();
      }
    } catch (error) {
      expect((error as Error).name).toBe("AbortError");
    }
    await until(() => server.aborted() > 0);
    expect(server.aborted()).toBe(1);
  });

  it("names a rejected key without echoing anything, and redacts the key from other errors", async () => {
    const unauthorised = await httpServer((_request, res) => { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: `bad key ${KEY}` } })); });
    const failing = await httpServer((_request, res) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: `upstream broke for ${KEY}` } })); });
    const make = (url: string) => new OpenAiTtsProvider(tts(), { env: ENV, endpoints: { http: url, ws: "" } });
    const first = await drain(synth(make(unauthorised.url))).catch((error: Error) => error);
    expect((first as Error).message).toBe("OpenAI speech rejected the credentials (HTTP 401)");
    const second = await drain(synth(make(failing.url))).catch((error: Error) => error);
    expect((second as Error).message).toBe("OpenAI speech failed (HTTP 500): upstream broke for ***");
  });

  it("fails fast, naming the variable, when the key is missing", async () => {
    const provider = new OpenAiTtsProvider(tts(), { env: {} });
    expect(provider.status().reason).toBe("OpenAI key not set: OPENAI_API_KEY");
    await expect(drain(synth(provider))).rejects.toThrow("OpenAI key not set: OPENAI_API_KEY");
  });
});

describe("OpenAI-compatible STT", () => {
  const compatible = (url: string, extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) =>
    new OpenAiCompatibleSttProvider({ provider: "openai-compatible", model: "whisper-1", baseUrl: url, apiKeyRef: null, ...extra }, env);

  it("posts the whole utterance as a WAV in a multipart request and returns the text as the final", async () => {
    const server = await httpServer((_request, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ text: " what time is it " })); });
    const provider = compatible(server.url);
    expect(provider.partials).toBe(false);
    const stream = provider.open(opts());
    const events = collect(stream);
    stream.write(pcm(100, 500));
    stream.write(pcm(100, 500));
    stream.end();
    await until(() => events.length > 0);
    expect(events).toEqual([{ type: "final", text: "what time is it" }]);
    const request = server.seen[0]!;
    expect(request.url).toBe("/v1/audio/transcriptions");
    expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const body = request.body.toString("latin1");
    expect(body).toContain('name="model"');
    expect(body).toContain("whisper-1");
    expect(body).toContain('name="language"');
    expect(body).toContain('filename="audio.wav"');
    const riff = request.body.indexOf("RIFF");
    expect(request.body.readUInt32LE(riff + 24)).toBe(16_000);
    expect(request.body.readUInt32LE(riff + 40)).toBe(6400);
    expect(request.headers.authorization).toBeUndefined();
  });

  it("sends the key when one is configured and refuses a configured key that is not set", async () => {
    const server = await httpServer((_request, res) => res.end(JSON.stringify({ text: "ok" })));
    const withKey = compatible(server.url, { apiKeyRef: "${LOCAL_KEY}" }, ENV);
    const stream = withKey.open(opts());
    const events = collect(stream);
    stream.write(pcm(40));
    stream.end();
    await until(() => events.length > 0);
    expect(server.seen[0]!.headers.authorization).toBe("Bearer local-secret-key");
    const unset = compatible(server.url, { apiKeyRef: "${LOCAL_KEY}" });
    expect(unset.status()).toEqual({ available: false, reason: "API key not set: LOCAL_KEY" });
    const failed = collect(unset.open(opts()));
    await sleep(20);
    expect(failed[0]).toMatchObject({ type: "error" });
  });

  it("reports an error status, and sends nothing for an empty utterance", async () => {
    const server = await httpServer((_request, res) => { res.writeHead(503); res.end("down"); });
    const stream = compatible(server.url).open(opts());
    const events = collect(stream);
    stream.write(pcm(40));
    stream.end();
    await until(() => events.length > 0);
    expect(events).toEqual([{ type: "error", message: "transcription failed (HTTP 503)" }]);
    const empty = compatible(server.url).open(opts());
    const emptyEvents = collect(empty);
    empty.end();
    await sleep(30);
    expect(emptyEvents).toEqual([{ type: "final", text: "" }]);
    expect(server.seen).toHaveLength(1);
  });

  it("aborts the request in flight and emits nothing", async () => {
    const server = await httpServer(() => undefined); // never answers
    const controller = new AbortController();
    const stream = compatible(server.url).open(opts(controller.signal));
    const events = collect(stream);
    stream.write(pcm(40));
    stream.end();
    await until(() => server.seen.length > 0);
    controller.abort();
    await until(() => server.aborted() > 0);
    expect(server.aborted()).toBe(1);
    expect(events).toEqual([]);
  });
});

describe("OpenAI-compatible TTS", () => {
  const compatible = (url: string) => new OpenAiCompatibleTtsProvider({ ...side({ provider: "openai-compatible", model: "tts-1", baseUrl: url, apiKeyRef: null }), voice: "alloy", speed: 1 }, {});
  const formats = (seen: Seen[]) => seen.map((request) => JSON.parse(request.body.toString()).response_format);

  it("asks for pcm and streams it", async () => {
    const audio = pcm(30, 800);
    const server = await httpServer((_request, res) => res.end(audio));
    expect((await drain(synth(compatible(server.url)))).equals(audio)).toBe(true);
    expect(formats(server.seen)).toEqual(["pcm"]);
    expect(server.seen[0]!.url).toBe("/v1/audio/speech");
    expect(server.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("falls back to wav when the server will not do pcm, and unwraps it", async () => {
    const audio = pcm(30, 800);
    const server = await httpServer((request, res) => {
      if (JSON.parse(request.body.toString()).response_format === "pcm") { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "unsupported format" } })); }
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(toWav(audio, 24_000));
    });
    expect((await drain(synth(compatible(server.url)))).equals(audio)).toBe(true);
    expect(formats(server.seen)).toEqual(["pcm", "wav"]);
  });

  it("does not retry as wav after an auth failure or a server error", async () => {
    for (const status of [401, 429, 500]) {
      const server = await httpServer((_request, res) => { res.writeHead(status); res.end("no"); });
      await expect(drain(synth(compatible(server.url)))).rejects.toThrow(`HTTP ${status}`);
      expect(server.seen).toHaveLength(1);
    }
  });

  it("unwraps a WAV sent when pcm was asked for, and resamples it to 24 kHz", async () => {
    const slow = pcm(100, 800); // 3200 bytes at 16 kHz
    const server = await httpServer((_request, res) => res.end(toWav(slow, 16_000)));
    const out = await drain(synth(compatible(server.url)));
    expect(out.length).toBe(4800);
  });

  it("refuses a server that can only return MP3, by content type and by content", async () => {
    const byType = await httpServer((_request, res) => { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(Buffer.alloc(200)); }); // zeros: only the header says MP3
    await expect(drain(synth(compatible(byType.url)))).rejects.toThrow(/only returns MP3/);
    const byContent = await httpServer((_request, res) => { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200)])); });
    await expect(drain(synth(compatible(byContent.url)))).rejects.toThrow(/only returns MP3/);
    const frameSync = await httpServer((_request, res) => res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0])));
    await expect(drain(synth(compatible(frameSync.url)))).rejects.toThrow(/only returns MP3/);
  });

  it("refuses a WAV that is not 16-bit mono PCM", async () => {
    const stereo = toWav(pcm(10), 24_000);
    stereo.writeUInt16LE(2, 22);
    const server = await httpServer((_request, res) => res.end(stereo));
    await expect(drain(synth(compatible(server.url)))).rejects.toThrow(/unusable/);
  });
});

// ── VAD and the registry ─────────────────────────────────────────────────────

describe("hosted provider edge cases", () => {
  const compatTts = (url: string) => new OpenAiCompatibleTtsProvider({ ...side({ provider: "openai-compatible", model: "tts-1", baseUrl: url, apiKeyRef: "${LOCAL_KEY}" }), voice: "alloy", speed: 1 }, ENV);
  const compatStt = (url: string, apiKeyRef: string | null = null) => new OpenAiCompatibleSttProvider({ provider: "openai-compatible", model: "whisper-1", baseUrl: url, apiKeyRef }, ENV);

  it("does not put a URL's credentials or the key in a connection error", async () => {
    const closed = await httpServer(() => undefined);
    const dead = closed.url.replace("http://", "http://user:urlsecret99@");
    const refused = await drain(synth(compatTts(dead))).catch((error: Error) => error);
    expect((refused as Error).message).toMatch(/could not be reached/);
    expect((refused as Error).message).not.toMatch(/urlsecret99|local-secret-key/);
    const gone = http.createServer();
    await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
    const goneUrl = `http://127.0.0.1:${(gone.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => gone.close(() => resolve()));
    const nobody = await drain(synth(compatTts(goneUrl))).catch((error: Error) => error);
    expect((nobody as Error).message).toMatch(/could not be reached: ECONNREFUSED/);
  });

  it("redacts the key from a transcription failure that echoes it", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("upstream said bad key local-secret-key"));
    try {
      const stream = compatStt("http://127.0.0.1:1", "${LOCAL_KEY}").open(opts());
      const events = collect(stream);
      stream.write(pcm(40));
      stream.end();
      await until(() => events.length > 0);
      expect(events[0]).toMatchObject({ type: "error" });
      expect(JSON.stringify(events)).not.toContain("local-secret-key");
      expect(JSON.stringify(events)).toContain("***");
    } finally {
      spy.mockRestore();
    }
  });

  it("makes no request and emits nothing when the signal is already aborted", async () => {
    const server = await httpServer((_request, res) => res.end(JSON.stringify({ text: "x" })));
    const controller = new AbortController();
    controller.abort();
    const stream = compatStt(server.url).open(opts(controller.signal));
    const events = collect(stream);
    stream.write(pcm(40));
    stream.end();
    await sleep(100);
    expect(events).toEqual([]);
    expect(server.seen).toHaveLength(0);
  });

  it("unwraps a WAV whose first network chunk is only a few bytes", async () => {
    const audio = pcm(30, 800);
    const wav = toWav(audio, 24_000);
    const server = await httpServer((_request, res) => { res.write(wav.subarray(0, 2)); setTimeout(() => res.end(wav.subarray(2)), 30); });
    expect((await drain(synth(compatTts(server.url)))).equals(audio)).toBe(true);
  });

  it("refuses Ogg and FLAC as it refuses MP3", async () => {
    for (const magic of ["OggS", "fLaC"]) {
      const server = await httpServer((_request, res) => res.end(Buffer.concat([Buffer.from(magic), Buffer.alloc(200)])));
      await expect(drain(synth(compatTts(server.url)))).rejects.toThrow(/compressed audio/);
    }
  });

  it("trims a WAV's odd trailing byte, and sends only a two-letter language code", () => {
    const file = Buffer.concat([toWav(pcm(10), 24_000), Buffer.from([7])]);
    file.writeUInt32LE(0, 40 + 0); // a streamed WAV: unsized data
    const parsed = parseWav(file);
    expect("pcm" in parsed && parsed.pcm.length % 2).toBe(0);
    expect(iso6391("en-GB")).toBe("en");
    expect(iso6391("fil")).toBeUndefined();
    expect(iso6391("pt-BR")).toBe("pt");
  });

  it("omits the language from the transcription request when it has no two-letter code", async () => {
    const server = await httpServer((_request, res) => res.end(JSON.stringify({ text: "ok" })));
    const stream = compatStt(server.url).open({ language: "fil", sampleRate: 16_000, signal: new AbortController().signal });
    const events = collect(stream);
    stream.write(pcm(40));
    stream.end();
    await until(() => events.length > 0);
    expect(server.seen[0]!.body.toString("latin1")).not.toContain('name="language"');
  });
});

describe("energy VAD", () => {
  const params = { threshold: 0.5, minSpeechMs: 100, silenceMs: 200, prerollMs: 60 };

  it("starts after minSpeech of loud audio, backed up by the pre-roll, and ends after the silence", () => {
    const vad = new EnergyVad(params);
    const events: Array<{ kind: string; atMs: number }> = [];
    vad.on((event) => events.push(event));
    vad.write(pcm(200));
    vad.write(pcm(300, 8000));
    vad.write(pcm(400));
    expect(events).toEqual([{ kind: "start", atMs: 200 - 60 }, { kind: "end", atMs: 500 }]);
  });

  it("ignores a burst shorter than minSpeech and audio below the level, and a closed stream", () => {
    const vad = new EnergyVad(params);
    const events: unknown[] = [];
    vad.on((event) => events.push(event));
    vad.write(pcm(60, 8000));
    vad.write(pcm(500, 100)); // far under 0.5 * 0.05 RMS
    vad.write(pcm(300));
    vad.close();
    vad.write(pcm(300, 8000));
    expect(events).toEqual([]);
  });

  it("holds odd-sized writes until a whole frame is there", () => {
    const vad = new EnergyVad(params);
    const events: unknown[] = [];
    vad.on((event) => events.push(event));
    const loud = pcm(200, 8000);
    for (let at = 0; at < loud.length; at += 333) vad.write(loud.subarray(at, at + 333));
    expect(events).toEqual([{ kind: "start", atMs: 0 }]);
  });
});

describe("registry", () => {
  const resolve = (voice: Record<string, unknown>): ResolvedVoiceConfig => resolveVoiceConfig({ voice: { enabled: true, ...voice } })!;
  const stubLocal = (state: "ready" | "not_installed") => ({
    client: { vad: () => ({ write() { /* none */ }, on() { /* none */ }, close() { /* none */ } }), status: () => ({ available: true }) } as unknown as SpeechSidecarClient,
    installer: { status: () => ({ state, progress: state === "ready" ? 1 : 0 }) } as unknown as SpeechInstaller,
  });
  const hosted = { stt: { provider: "openai", apiKey: "${OPENAI_API_KEY}" }, tts: { provider: "openai", apiKey: "${OPENAI_API_KEY}" }, language: "en" };

  it("builds each provider the config names", () => {
    expect(createSttProvider(resolve({}), { local: stubLocal("ready") })).toBeInstanceOf(LocalSttProvider);
    expect(createTtsProvider(resolve({}), { local: stubLocal("ready") })).toBeInstanceOf(LocalTtsProvider);
    expect(createSttProvider(resolve(hosted), { env: ENV })).toBeInstanceOf(OpenAiSttProvider);
    expect(createTtsProvider(resolve(hosted), { env: ENV })).toBeInstanceOf(OpenAiTtsProvider);
    const own = { stt: { provider: "openai-compatible", baseUrl: "http://localhost:8000" }, tts: { provider: "openai-compatible", baseUrl: "http://localhost:8880" } };
    expect(createSttProvider(resolve(own))).toBeInstanceOf(OpenAiCompatibleSttProvider);
    expect(createTtsProvider(resolve(own))).toBeInstanceOf(OpenAiCompatibleTtsProvider);
  });

  it("falls back to the in-process energy VAD when the local sidecar is absent and a hosted provider is in use", () => {
    expect(createVad(resolve(hosted), { local: stubLocal("not_installed") })).toBeInstanceOf(EnergyVad);
  });

  it("reuses the local VAD for hosted providers once the local models are installed", () => {
    expect(createVad(resolve(hosted), { local: stubLocal("ready") })).not.toBeInstanceOf(EnergyVad);
  });

  it("always uses the local VAD with a local provider, installed or not", () => {
    expect(createVad(resolve({}), { local: stubLocal("not_installed") })).not.toBeInstanceOf(EnergyVad);
  });
});

describe("a provider's ids and keys", () => {
  it("never expose the key on the provider object", () => {
    const providers: SttProvider[] = [new OpenAiSttProvider(side(), { env: ENV }), new OpenAiCompatibleSttProvider(side({ provider: "openai-compatible", baseUrl: "http://x", apiKeyRef: "${LOCAL_KEY}" }), ENV)];
    for (const provider of providers) expect(JSON.stringify({ ...provider, status: provider.status() })).not.toMatch(/sentinel|local-secret/);
  });
});
