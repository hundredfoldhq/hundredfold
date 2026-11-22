import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSpeech } from "../../voice/providers/local.js";
import { voicePaths, type InstallStatus } from "../../voice/sidecar/bootstrap.js";
import { parseNpzNames } from "../../voice/voices-file.js";
import { handleVoiceApi, voiceConfigResponse, OPENAI_VOICES } from "../voice-api.js";

const KEY = "sk-sentinel-voice-api-0123456789";
const PROMPT = "UNIQUE-PROMPT-TEXT-FOR-THE-LEAK-CHECK";
const BASE_URL = "http://internal-speech-host.example:8123";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "voice-api-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); delete process.env.VOICE_API_TEST_KEY; });

/** A stored-entry zip with the given file names, the shape of Kokoro's `.npz`. */
function zipOf(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const raw = Buffer.from(name);
    const local = Buffer.alloc(30 + raw.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(raw.length, 26);
    raw.copy(local, 30);
    const central = Buffer.alloc(46 + raw.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(raw.length, 28);
    central.writeUInt32LE(offset, 42);
    raw.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function putVoices(names: string[]): void {
  const dir = voicePaths(home).kokoroDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "voices-v1.0.bin"), zipOf(names.map((name) => `${name}.npy`)));
}

function stubLocal(initial: InstallStatus, clientStatus: { available: boolean; reason?: string } = { available: true }) {
  const state = { install: initial, started: 0 };
  const local = {
    client: { status: () => clientStatus, close() { /* none */ } },
    installer: { status: () => state.install, ensureInstalled: vi.fn(async () => { state.started += 1; return state.install; }) },
  } as unknown as LocalSpeech;
  return { local, state };
}

const READY: InstallStatus = { state: "ready", progress: 1 };
const config = (voice: unknown) => ({ voice });

function makeRes() {
  let status = 0;
  const chunks: Buffer[] = [];
  const res = { writeHead(next: number) { status = next; return this; }, setHeader() { return this; }, end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.from(chunk)); } } as unknown as ServerResponse;
  return { res, get status() { return status; }, get body() { return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, any>; }, get raw() { return Buffer.concat(chunks).toString(); } };
}

async function call(method: string, pathname: string, voice: unknown, local: LocalSpeech, extra: { emit?: (event: string, payload: unknown) => void } = {}) {
  const out = makeRes();
  const handled = await handleVoiceApi({} as never, out.res, { method, pathname, url: new URL(`http://x${pathname}`) }, { getConfig: () => config(voice) as never, local, home, emit: extra.emit as never });
  return { handled, out };
}

describe("GET /api/voice/config", () => {
  it("is {enabled:false} when voice is absent, disabled, or has a problem", () => {
    expect(voiceConfigResponse(config(undefined))).toEqual({ enabled: false });
    expect(voiceConfigResponse(config({ enabled: false }))).toEqual({ enabled: false });
    expect(voiceConfigResponse(config({ enabled: true, vad: { threshold: 3 } }))).toEqual({ enabled: false });
  });

  it("describes an enabled, installed local setup in the contract's shape", () => {
    putVoices(["bf_emma", "af_heart", "am_michael"]);
    const { local } = stubLocal(READY);
    expect(voiceConfigResponse(config({ enabled: true }), { local, home })).toEqual({
      enabled: true, available: true, reason: null, mode: "hands-free", language: "en",
      stt: { provider: "local", partials: true, status: { available: true } },
      tts: { provider: "local", voice: "af_heart", voices: ["af_heart", "am_michael", "bf_emma"], status: { available: true } },
      onset: { threshold: 0.02, minSpeechMs: 250 },
      bargeIn: { enabled: true },
      autoBackground: { enabled: true, afterSeconds: 5 },
      limits: { maxUtteranceSeconds: 60 },
      install: { state: "ready", progress: 1 },
    });
  });

  it("reflects the settings the operator chose", () => {
    const { local } = stubLocal(READY);
    const body = voiceConfigResponse(config({ enabled: true, mode: "push-to-talk", bargeIn: { enabled: false, onsetThreshold: 0.05, minSpeechMs: 400 }, autoBackground: { afterSeconds: 9 }, limits: { maxUtteranceSeconds: 30 } }), { local, home });
    expect(body).toMatchObject({ mode: "push-to-talk", onset: { threshold: 0.05, minSpeechMs: 400 }, bargeIn: { enabled: false }, autoBackground: { enabled: true, afterSeconds: 9 }, limits: { maxUtteranceSeconds: 30 } });
  });

  it.each<[string, InstallStatus, string]>([
    ["not installed", { state: "not_installed", progress: 0 }, "not installed yet"],
    ["installing", { state: "installing", progress: 0.4 }, "installing"],
    ["failed", { state: "failed", progress: 0.2, reason: "no disk" }, "install failed: no disk"],
  ])("reports the local install when it is %s: unavailable, with the state and a reason", (_name, install, reasonPart) => {
    const { local } = stubLocal(install);
    const body = voiceConfigResponse(config({ enabled: true }), { local, home });
    expect(body.available).toBe(false);
    expect(String(body.reason)).toContain(reasonPart);
    expect(body.install).toEqual(install.reason ? { state: install.state, progress: install.progress, reason: install.reason } : { state: install.state, progress: install.progress });
  });

  it("reports the sidecar's own failure as the reason once it is installed", () => {
    const { local } = stubLocal(READY, { available: false, reason: "the speech sidecar exited (code 1) (retrying in 20 s)" });
    expect(voiceConfigResponse(config({ enabled: true }), { local, home })).toMatchObject({ available: false, reason: expect.stringContaining("exited") });
  });

  it("flags a local voice that is not in the voice file", () => {
    putVoices(["af_heart"]);
    const { local } = stubLocal(READY);
    const body = voiceConfigResponse(config({ enabled: true, tts: { voice: "zz_nobody" } }), { local, home }) as Record<string, any>;
    expect(body.available).toBe(false);
    expect(body.tts.status).toEqual({ available: false, reason: 'Voice "zz_nobody" is not in the Kokoro voice list' });
    expect(body.stt.status).toEqual({ available: true });
  });

  it("has no voice list yet when the voice file has not been downloaded", () => {
    const { local } = stubLocal({ state: "not_installed", progress: 0 });
    expect((voiceConfigResponse(config({ enabled: true }), { local, home }) as Record<string, any>).tts).toMatchObject({ voices: [] });
  });

  it("names the missing key variable for a hosted provider, and has nothing to install", () => {
    const { local } = stubLocal({ state: "not_installed", progress: 0 });
    const voice = { enabled: true, stt: { provider: "openai", apiKey: "${VOICE_API_TEST_KEY}" }, tts: { provider: "openai", apiKey: "${VOICE_API_TEST_KEY}" } };
    expect(voiceConfigResponse(config(voice), { local, home, env: {} })).toMatchObject({
      available: false, reason: "OpenAI key not set: VOICE_API_TEST_KEY", install: { state: "ready", progress: 1 },
      tts: { provider: "openai", voice: "marin", voices: OPENAI_VOICES },
    });
    const withKey = voiceConfigResponse(config(voice), { local, home, env: { VOICE_API_TEST_KEY: KEY } });
    expect(withKey).toMatchObject({ available: true, reason: null, stt: { provider: "openai", partials: true } });
  });

  it("never carries a key, a base URL or the prompt", () => {
    const { local } = stubLocal(READY);
    const voice = {
      enabled: true, prompt: PROMPT, holdingLine: "still working", promptFile: "voice/p.md",
      stt: { provider: "openai-compatible", baseUrl: BASE_URL, apiKey: "${VOICE_API_TEST_KEY}" },
      tts: { provider: "openai-compatible", baseUrl: BASE_URL, apiKey: "${VOICE_API_TEST_KEY}" },
    };
    const text = JSON.stringify(voiceConfigResponse(config(voice), { local, home, env: { VOICE_API_TEST_KEY: KEY } }));
    for (const secret of [KEY, PROMPT, BASE_URL, "internal-speech-host", "VOICE_API_TEST_KEY", "still working", "voice/p.md"]) expect(text).not.toContain(secret);
  });

  it("is served as JSON by the handler for GET only, and falls through for other paths", async () => {
    const { local } = stubLocal(READY);
    const served = await call("GET", "/api/voice/config", { enabled: true }, local);
    expect(served.handled).toBe(true);
    expect(served.out.status).toBe(200);
    expect(served.out.body).toMatchObject({ enabled: true });
    expect((await call("POST", "/api/voice/config", { enabled: true }, local)).handled).toBe(false);
    expect((await call("GET", "/api/voice/other", { enabled: true }, local)).handled).toBe(false);
  });
});

describe("POST /api/voice/install", () => {
  it("starts the install and answers with the install state it is in", async () => {
    const { local, state } = stubLocal({ state: "installing", progress: 0.1 });
    const { handled, out } = await call("POST", "/api/voice/install", { enabled: true }, local);
    expect(handled).toBe(true);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ state: "installing", progress: 0.1 });
    expect(state.started).toBe(1);
  });

  it("answers the same state for a hosted-only setup's local install too, and 409 when voice is off", async () => {
    const { local } = stubLocal({ state: "not_installed", progress: 0 });
    const hosted = { enabled: true, stt: { provider: "openai", apiKey: "${VOICE_API_TEST_KEY}" }, tts: { provider: "openai", apiKey: "${VOICE_API_TEST_KEY}" } };
    expect((await call("POST", "/api/voice/install", hosted, local)).out.body).toEqual({ state: "not_installed", progress: 0 });
    const off = await call("POST", "/api/voice/install", { enabled: false }, local);
    expect(off.out.status).toBe(409);
    expect(off.out.body.error).toMatch(/not enabled/);
  });

  it("is idempotent, and turns the installer's changes into voice:install events", async () => {
    // The real shared installer in a temp home, with no Python on the PATH: it fails at once and says why.
    const events: Array<[string, any]> = [];
    const emit = (event: string, payload: unknown) => events.push([event, payload]);
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const both = await Promise.all([
        callShared("POST", "/api/voice/install", { enabled: true }, emit),
        callShared("POST", "/api/voice/install", { enabled: true }, emit),
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(both.map((result) => result.out.status)).toEqual([200, 200]);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(events.map(([name, payload]) => [name, payload.state])).toEqual([["voice:install", "installing"], ["voice:install", "failed"]]);
    expect(events[1]![1].reason).toMatch(/Python 3\.10\+/);
  });
});

async function callShared(method: string, pathname: string, voice: unknown, emit: (event: string, payload: unknown) => void) {
  const out = makeRes();
  const handled = await handleVoiceApi({} as never, out.res, { method, pathname, url: new URL(`http://x${pathname}`) }, { getConfig: () => config(voice) as never, home, emit: emit as never });
  return { handled, out };
}

describe("voices file", () => {
  it("reads the names out of an npz's central directory, sorted, ignoring other entries", () => {
    expect(parseNpzNames(zipOf(["bf_emma.npy", "af_heart.npy", "README.txt"]))).toEqual(["af_heart", "bf_emma"]);
    expect(parseNpzNames(Buffer.from("not a zip"))).toEqual([]);
  });
});
