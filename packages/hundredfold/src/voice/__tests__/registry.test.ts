import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVoiceConfig } from "../../shared/voice-config.js";
import { voicePaths } from "../sidecar/bootstrap.js";

// The sidecar client is replaced so its `hello` (what the sidecar is told to load) can be read without spawning anything.
const helloOf = new Map<unknown, () => Record<string, unknown>>();
vi.mock("../sidecar/client.js", () => ({
  SpeechSidecarClient: class {
    constructor(options: { hello: () => Record<string, unknown> }) { helloOf.set(this, options.hello); }
    close(): void {}
  },
}));

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "voice-registry-")); });
afterEach(async () => {
  (await import("../providers/registry.js")).closeSharedLocalSpeech();
  fs.rmSync(home, { recursive: true, force: true });
});

const resolved = (model?: string) => {
  const config = resolveVoiceConfig({ voice: { enabled: true, local: { device: "cpu" }, stt: { provider: "local", ...(model ? { model } : {}) } } }, home);
  if (!config) throw new Error("voice resolved off");
  return config;
};

describe("the shared local speech for a home", () => {
  it("is one entry per speech-to-text model, and the same entry for the same model", async () => {
    const { sharedLocalSpeech } = await import("../providers/registry.js");
    const unified = sharedLocalSpeech(resolved("parakeet-unified-en-0.6b"), home);
    const standard = sharedLocalSpeech(resolved(), home);
    expect(unified).not.toBe(standard);
    expect(sharedLocalSpeech(resolved("parakeet-unified-en-0.6b"), home)).toBe(unified);
    expect(sharedLocalSpeech(resolved("parakeet-tdt-0.6b-v2"), home)).toBe(standard);
  });

  it("tells its sidecar to load the chosen model, from the chosen model's folder", async () => {
    const { sharedLocalSpeech } = await import("../providers/registry.js");
    const paths = voicePaths(home);
    const stt = (model?: string) => (helloOf.get(sharedLocalSpeech(resolved(model), home).client)!().models as { stt: { name: string; path: string } }).stt;
    expect(stt("parakeet-unified-en-0.6b")).toMatchObject({ name: "nemo-conformer-rnnt", path: paths.sttDir("cpu", "parakeet-unified-en-0.6b") });
    expect(stt()).toMatchObject({ name: "nemo-parakeet-tdt-0.6b-v2", path: paths.sttDir("cpu", "parakeet-tdt-0.6b-v2") });
  });

  it("gives its installer the chosen model: ready only when that model is installed", async () => {
    const { sharedLocalSpeech } = await import("../providers/registry.js");
    const paths = voicePaths(home);
    fs.mkdirSync(path.dirname(paths.python), { recursive: true });
    fs.writeFileSync(paths.python, "");
    fs.writeFileSync(paths.marker, JSON.stringify({ version: 1, device: "cpu", sttModels: ["parakeet-unified-en-0.6b"] }));
    expect(sharedLocalSpeech(resolved("parakeet-unified-en-0.6b"), home).installer.status().state).toBe("ready");
    expect(sharedLocalSpeech(resolved(), home).installer.status().state).toBe("not_installed");
  });
});
