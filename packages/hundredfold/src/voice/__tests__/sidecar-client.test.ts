import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpeechSidecarClient, SidecarUnavailableError, type SidecarTiming } from "../sidecar/client.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-sidecar.mjs");
const VAD = { threshold: 0.5, minSpeechMs: 250, silenceMs: 700, prerollMs: 300 };
const SPEECH = { text: "hi", voice: "af_heart", speed: 1, lang: "en" };

let dir: string;
let log: string;
let spawned: ChildProcessWithoutNullStreams[];
let clients: SpeechSidecarClient[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-client-"));
  log = path.join(dir, "requests.log");
  spawned = [];
  clients = [];
});

afterEach(() => {
  for (const client of clients) client.close();
  for (const child of spawned) child.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
});

function client(fake = "", timing: Partial<SidecarTiming> = {}): SpeechSidecarClient {
  const made = new SpeechSidecarClient({
    spawnProcess: () => {
      const child = spawn(process.execPath, [FAKE], { env: { ...process.env, FAKE: fake, FAKE_LOG: log }, stdio: ["pipe", "pipe", "pipe"] });
      spawned.push(child);
      return child;
    },
    hello: () => ({ device: "auto", models: {} }),
    timing: { pingEveryMs: 30, respawnMinMs: 400, idleReapMs: 200, killGraceMs: 200, helloTimeoutMs: 1500, ...timing },
  });
  clients.push(made);
  return made;
}

const logged = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (child: ChildProcessWithoutNullStreams): boolean => child.exitCode === null && child.signalCode === null;

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

async function collect(iterable: AsyncIterable<{ pcm: Buffer; sampleRate: number }>): Promise<number> {
  let chunks = 0;
  for await (const chunk of iterable) {
    expect(chunk.sampleRate).toBe(24000);
    chunks += 1;
  }
  return chunks;
}

describe("speech sidecar client", () => {
  it("spawns on first need, not before, and says hello", async () => {
    const sidecar = client();
    expect(spawned).toHaveLength(0);
    expect(sidecar.status()).toEqual({ available: true });
    const info = await sidecar.ensureReady();
    expect(info).toEqual({ device: "cpu", voices: ["af_heart", "bf_emma"], sttPartials: true });
    expect(sidecar.voices).toEqual(["af_heart", "bf_emma"]);
    expect(spawned).toHaveLength(1);
    await sidecar.ensureReady();
    expect(spawned).toHaveLength(1);
  });

  it("multiplexes concurrent requests and routes each reply to its own id", async () => {
    const sidecar = client();
    const [a, b, partial] = await Promise.all([
      sidecar.transcribe("final", { stream: "s", utterance: "u1" }, Buffer.alloc(10)),
      sidecar.transcribe("final", { stream: "s", utterance: "u2" }, Buffer.alloc(20)),
      sidecar.transcribe("partial", { stream: "s", utterance: "u1" }, Buffer.alloc(5)),
    ]);
    expect([a, b, partial]).toEqual(["stt.final:10", "stt.final:20", "stt.partial:5"]);
    const [x, y] = await Promise.all([collect(sidecar.synthesize("t1", SPEECH, new AbortController().signal)), collect(sidecar.synthesize("t2", SPEECH, new AbortController().signal))]);
    expect([x, y]).toEqual([2, 2]);
  });

  it("delivers VAD events for the stream, holding audio written before it is ready", async () => {
    const sidecar = client();
    const vad = sidecar.vad("v1", VAD);
    const events: unknown[] = [];
    vad.on((event) => events.push(event));
    vad.write(Buffer.alloc(640));
    vad.write(Buffer.alloc(2));
    await until(() => events.length === 2);
    expect(events).toEqual([{ kind: "start", atMs: 640 }, { kind: "end", atMs: 2 }]);
    vad.close();
    await until(() => logged().includes("vad.close"));
    expect(logged()).toEqual(expect.arrayContaining(["vad.open", "vad.audio", "vad.close"]));
  });

  it("cancels a synthesis in the sidecar when it is aborted mid-stream", async () => {
    const sidecar = client();
    const controller = new AbortController();
    const seen: number[] = [];
    const run = (async () => {
      for await (const chunk of sidecar.synthesize("slow1", { ...SPEECH, text: "slow" }, controller.signal)) {
        seen.push(chunk.pcm.length);
        if (seen.length === 2) controller.abort();
      }
    })();
    await run;
    await until(() => logged().includes("cancel:slow1"));
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("cancelling an utterance fails the waiting decode and tells the sidecar", async () => {
    const sidecar = client("nostt");
    await sidecar.ensureReady();
    const pending = sidecar.transcribe("final", { stream: "s", utterance: "gone" }, Buffer.alloc(1));
    await until(() => logged().includes("stt.final"));
    sidecar.cancelUtterance("gone");
    await expect(pending).rejects.toThrow("cancelled");
    await until(() => logged().includes("cancel:gone"));
  });

  it("marks the sidecar unavailable after missed pongs and fails in-flight work", async () => {
    const sidecar = client("nopong");
    const controller = new AbortController();
    const speech = sidecar.synthesize("slow2", { ...SPEECH, text: "slow" }, controller.signal);
    const drained = collect(speech);
    await expect(drained).rejects.toBeInstanceOf(SidecarUnavailableError);
    expect(sidecar.status().available).toBe(false);
    expect(sidecar.status().reason).toMatch(/stopped answering/);
    await until(() => !alive(spawned[0]!));
  });

  it("a sidecar that answers its pings stays up under use", async () => {
    const sidecar = client();
    const release = sidecar.lease();
    await sidecar.ensureReady();
    await sleep(250);
    expect(sidecar.status().available).toBe(true);
    expect(alive(spawned[0]!)).toBe(true);
    release();
  });

  it("fails in-flight requests when the process exits", async () => {
    const sidecar = client("die-on-tts");
    await expect(collect(sidecar.synthesize("t1", SPEECH, new AbortController().signal))).rejects.toThrow(/exited/);
    expect(sidecar.status()).toMatchObject({ available: false });
  });

  it("refuses a bad frame as a crash, not a hang", async () => {
    const sidecar = client("badframe");
    const release = sidecar.lease();
    await sidecar.ensureReady();
    await until(() => !sidecar.status().available);
    expect(sidecar.status().reason).toMatch(/bad frame/);
    release();
  });

  it("respawns at most once per respawn window", async () => {
    const sidecar = client("die-on-tts", { respawnMinMs: 500 });
    await expect(collect(sidecar.synthesize("t1", SPEECH, new AbortController().signal))).rejects.toThrow();
    await expect(sidecar.ensureReady()).rejects.toThrow(/retrying in/);
    expect(spawned).toHaveLength(1);
    await sleep(520);
    expect(sidecar.status()).toEqual({ available: true });
    await expect(sidecar.ensureReady()).resolves.toMatchObject({ device: "cpu" });
    expect(spawned).toHaveLength(2);
  });

  it("reports a failed hello as unavailable with the reason", async () => {
    const sidecar = client("error-hello");
    await expect(sidecar.ensureReady()).rejects.toThrow(/no model files/);
    expect(sidecar.status()).toEqual({ available: false, reason: expect.stringContaining("no model files") });
  });

  it("gives up on a sidecar that never answers hello", async () => {
    const sidecar = client("nohello", { helloTimeoutMs: 100 });
    await expect(sidecar.ensureReady()).rejects.toThrow(/hello/);
  });

  it("reaps an idle sidecar and starts another on the next need", async () => {
    const sidecar = client("", { idleReapMs: 100 });
    await sidecar.transcribe("final", { stream: "s", utterance: "u1" }, Buffer.alloc(1));
    await until(() => !alive(spawned[0]!));
    expect(sidecar.status()).toEqual({ available: true });
    await sidecar.transcribe("final", { stream: "s", utterance: "u2" }, Buffer.alloc(1));
    expect(spawned).toHaveLength(2);
  });

  it("does not reap while a stream is open", async () => {
    const sidecar = client("", { idleReapMs: 80 });
    const vad = sidecar.vad("v1", VAD);
    await sidecar.ensureReady();
    await sleep(300);
    expect(alive(spawned[0]!)).toBe(true);
    vad.close();
    await until(() => !alive(spawned[0]!));
  });

  it("kills the process on shutdown and refuses later use", async () => {
    const sidecar = client();
    await sidecar.ensureReady();
    sidecar.close();
    await until(() => !alive(spawned[0]!));
    await expect(sidecar.ensureReady()).rejects.toBeInstanceOf(SidecarUnavailableError);
  });
});
