import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SttEvent } from "../provider.js";
import { LocalSttProvider, LocalTtsProvider, MAX_LOCAL_UTTERANCE_BYTES, openLocalVad, localStatus, type LocalSpeech } from "../providers/local.js";
import type { SpeechInstaller, InstallStatus } from "../sidecar/bootstrap.js";
import { SpeechSidecarClient } from "../sidecar/client.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-sidecar.mjs");
const VAD = { threshold: 0.5, minSpeechMs: 250, silenceMs: 700, prerollMs: 300 };

let dir: string;
let spawned: ChildProcessWithoutNullStreams[];
let clients: SpeechSidecarClient[];
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-local-")); spawned = []; clients = []; });
afterEach(() => { for (const client of clients) client.close(); for (const child of spawned) child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });

function local(env: Record<string, string> = {}, install: InstallStatus = { state: "ready", progress: 1 }): LocalSpeech {
  const log = path.join(dir, "log");
  const client = new SpeechSidecarClient({
    spawnProcess: () => {
      const child = spawn(process.execPath, [FAKE], { env: { ...process.env, FAKE_LOG: log, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      spawned.push(child);
      return child;
    },
    hello: () => ({}),
    timing: { pingEveryMs: 10_000, killGraceMs: 100 },
  });
  clients.push(client);
  return { client, installer: { status: () => install } as unknown as SpeechInstaller };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(10);
}
const opts = (signal = new AbortController().signal) => ({ language: "en", sampleRate: 16_000, signal });
const logged = (): string[] => (fs.existsSync(path.join(dir, "log")) ? fs.readFileSync(path.join(dir, "log"), "utf8").split("\n").filter(Boolean) : []);

function collect(stream: { on(handler: (event: SttEvent) => void): void }): SttEvent[] {
  const events: SttEvent[] = [];
  stream.on((event) => events.push(event));
  return events;
}

describe("local STT", () => {
  it("emits partials while speech continues and one final at end()", async () => {
    const speech = local();
    await speech.client.ensureReady(); // a cold process start under load would eat the partial ticks
    const provider = new LocalSttProvider(speech);
    expect(provider.partials).toBe(true);
    const stream = provider.open(opts());
    const events = collect(stream);
    stream.write(Buffer.alloc(3200));
    await until(() => events.some((event) => event.type === "partial"));
    stream.write(Buffer.alloc(3200));
    await until(() => events.filter((event) => event.type === "partial").length >= 2);
    stream.end();
    await until(() => events.some((event) => event.type === "final"));
    const partials = events.filter((event) => event.type === "partial");
    expect(partials[0]).toEqual({ type: "partial", text: "stt.partial:3200" });
    expect(partials[1]).toEqual({ type: "partial", text: "stt.partial:6400" });
    expect(events.at(-1)).toEqual({ type: "final", text: "stt.final:6400" });
    expect(events.filter((event) => event.type === "final")).toHaveLength(1);
  });

  it("skips a partial tick while the previous decode is still running, even when new audio has arrived", async () => {
    const speech = local({ FAKE_PARTIAL_DELAY_MS: "1800" });
    await speech.client.ensureReady();
    const stream = new LocalSttProvider(speech).open(opts());
    stream.on(() => undefined);
    stream.write(Buffer.alloc(3200));
    await until(() => logged().filter((line) => line === "stt.partial").length === 1);
    stream.write(Buffer.alloc(3200)); // new audio: only the busy guard stops a second decode
    await sleep(1100); // two more ticks, the first decode still running
    expect(logged().filter((line) => line === "stt.partial")).toHaveLength(1);
    stream.abort();
  });

  it("sends no partial when nothing new arrived since the last one", async () => {
    const speech = local();
    await speech.client.ensureReady();
    const stream = new LocalSttProvider(speech).open(opts());
    stream.on(() => undefined);
    stream.write(Buffer.alloc(3200));
    await until(() => logged().filter((line) => line === "stt.partial").length === 1);
    await sleep(1000); // two ticks with no new audio
    expect(logged().filter((line) => line === "stt.partial")).toHaveLength(1);
    stream.abort();
  });

  it("emits nothing after end(): a late partial is dropped before the final", async () => {
    const speech = local({ FAKE_PARTIAL_DELAY_MS: "400" });
    await speech.client.ensureReady();
    const stream = new LocalSttProvider(speech).open(opts());
    const events = collect(stream);
    stream.write(Buffer.alloc(3200));
    await until(() => logged().includes("stt.partial"));
    stream.end(); // the partial's reply is still 400 ms away
    await until(() => events.some((event) => event.type === "final"));
    await sleep(500);
    expect(events.map((event) => event.type)).toEqual(["final"]);
  });

  it("abort() drops an utterance whose decode is running: no final, and the sidecar is told", async () => {
    const speech = local({ FAKE: "nostt" });
    await speech.client.ensureReady();
    const stream = new LocalSttProvider(speech).open(opts());
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));
    stream.write(Buffer.alloc(3200));
    stream.end();
    await until(() => logged().includes("stt.final"));
    stream.abort();
    await sleep(300);
    expect(events).toEqual([]);
    expect(logged().some((line) => line.startsWith("cancel:"))).toBe(true);
  });

  it("abort() before the sidecar is up means the decode is never sent", async () => {
    const stream = new LocalSttProvider(local()).open(opts());
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));
    stream.write(Buffer.alloc(3200));
    stream.end();
    stream.abort();
    await sleep(500);
    expect(events).toEqual([]);
    expect(logged()).not.toContain("stt.final");
  });

  it("aborting through the signal does the same", async () => {
    const controller = new AbortController();
    const stream = new LocalSttProvider(local()).open(opts(controller.signal));
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));
    stream.write(Buffer.alloc(3200));
    controller.abort();
    stream.end();
    await sleep(300);
    expect(events).toEqual([]);
  });

  it("reports an error, once, for an utterance past the sidecar's body limit", async () => {
    const stream = new LocalSttProvider(local()).open(opts());
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));
    stream.write(Buffer.alloc(MAX_LOCAL_UTTERANCE_BYTES));
    stream.write(Buffer.alloc(2));
    stream.write(Buffer.alloc(2));
    stream.end();
    await sleep(100);
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("too long for local speech") }]);
  });

  it("errors at once, with the reason, when local speech is not installed", async () => {
    const speech = local({}, { state: "not_installed", progress: 0 });
    const stream = new LocalSttProvider(speech).open(opts());
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));
    await sleep(20);
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("not installed") }]);
    expect(spawned).toHaveLength(0);
  });
});

describe("local status", () => {
  it("names why it is unavailable: installing, failed, not installed", () => {
    expect(localStatus(local({}, { state: "installing", progress: 0.4 }))).toEqual({ available: false, reason: "Local speech is installing" });
    expect(localStatus(local({}, { state: "failed", progress: 0.1, reason: "disk full" })).reason).toBe("Local speech install failed: disk full");
    expect(localStatus(local({}, { state: "not_installed", progress: 0 })).reason).toContain("not installed");
    expect(localStatus(local())).toEqual({ available: true });
  });
});

describe("local TTS", () => {
  const tts = (speech: LocalSpeech) => new LocalTtsProvider(speech, { voice: "bf_emma", speed: 1.1 });

  it("yields 24 kHz PCM chunks and reports its default voice", async () => {
    const provider = tts(local());
    expect(provider.sampleRate).toBe(24_000);
    expect(provider.defaultVoice).toBe("bf_emma");
    const chunks: Buffer[] = [];
    for await (const chunk of provider.synthesize("Hello.", { language: "en", signal: new AbortController().signal })) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBe(8);
  });

  it("stops and cancels in the sidecar when aborted mid-stream", async () => {
    const provider = tts(local());
    const controller = new AbortController();
    let count = 0;
    for await (const _chunk of provider.synthesize("slow", { language: "en", signal: controller.signal })) {
      count += 1;
      if (count === 2) controller.abort();
    }
    await sleep(100);
    expect(logged().some((line) => line.startsWith("cancel:"))).toBe(true);
  });

  it("throws the reason when local speech is not available", async () => {
    const provider = tts(local({}, { state: "not_installed", progress: 0 }));
    await expect((async () => { for await (const _chunk of provider.synthesize("x", { language: "en", signal: new AbortController().signal })) { /* none */ } })()).rejects.toThrow(/not installed/);
  });
});

describe("local VAD", () => {
  it("is a VadStream over the sidecar's VAD", async () => {
    const vad = openLocalVad(local(), VAD);
    const events: unknown[] = [];
    vad.on((event) => events.push(event));
    vad.write(Buffer.alloc(640));
    vad.write(Buffer.alloc(2));
    const deadline = Date.now() + 3000;
    while (events.length < 2 && Date.now() < deadline) await sleep(10);
    expect(events).toEqual([{ kind: "start", atMs: 640 }, { kind: "end", atMs: 2, speechMs: 1234 }]);
    vad.close();
  });
});
