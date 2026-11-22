import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REQUIRED_BYTES, SpeechInstaller, findPython, installReason, helloModels, resolveDevice, sidecarEnv, voicePaths, type InstallStatus, type VoiceDevice } from "../sidecar/bootstrap.js";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "voice-bootstrap-")); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("resolveDevice", () => {
  it("auto follows the GPU probe; gpu and cpu are taken as given without probing", () => {
    expect(resolveDevice("auto", () => true)).toBe("gpu");
    expect(resolveDevice("auto", () => false)).toBe("cpu");
    const never = () => { throw new Error("probed"); };
    expect(resolveDevice("gpu", never)).toBe("gpu");
    expect(resolveDevice("cpu", never)).toBe("cpu");
  });
});

describe("findPython", () => {
  const versions: Record<string, string | null> = { "python3.13": null, "python3.12": "3.12.3", "python3.10": "3.10.1", python3: "3.9.18" };
  it("takes the first candidate that is 3.10 or newer", () => {
    expect(findPython(["python3.13", "python3.12", "python3.10"], (command) => versions[command] ?? null)).toEqual({ command: "python3.12", version: "3.12.3" });
  });
  it("skips an old Python, and finds none when none qualifies", () => {
    expect(findPython(["python3.10", "python3"], (command) => (command === "python3.10" ? "3.10.0" : versions[command] ?? null))?.command).toBe("python3.10");
    expect(findPython(["python3"], (command) => versions[command] ?? null)).toBeNull();
    expect(findPython(["python3.13"], () => null)).toBeNull();
  });
  it("accepts 3.10 exactly and rejects 3.9.99", () => {
    expect(findPython(["a"], () => "3.10.0")).not.toBeNull();
    expect(findPython(["a"], () => "3.9.99")).toBeNull();
  });
});

describe("paths and environment", () => {
  it("keeps everything under the instance home and picks the model variant by device", () => {
    const paths = voicePaths(home);
    for (const p of [paths.root, paths.venv, paths.python, paths.vadDir, paths.kokoroDir, paths.sttDir("gpu")]) expect(p.startsWith(home)).toBe(true);
    expect(paths.sttDir("gpu")).toMatch(/fp32$/);
    expect(paths.sttDir("cpu")).toMatch(/int8$/);
    expect(helloModels(paths, "gpu").stt).toMatchObject({ quantization: null });
    expect(helloModels(paths, "cpu").stt).toMatchObject({ quantization: "int8" });
  });

  it("gives the sidecar a few names, never the gateway's keys", () => {
    const env = sidecarEnv({ PATH: "/bin", HTTPS_PROXY: "http://proxy:3128", OPENAI_API_KEY: "sk-secret", HUNDREDFOLD_TOKEN: "t", HOME: "/home/x" });
    expect(env.PATH).toBe("/bin");
    expect(env.HTTPS_PROXY).toBe("http://proxy:3128");
    const gpu = sidecarEnv({ CUDA_VISIBLE_DEVICES: "1", NVIDIA_VISIBLE_DEVICES: "all" });
    expect([gpu.CUDA_VISIBLE_DEVICES, gpu.NVIDIA_VISIBLE_DEVICES]).toEqual(["1", "all"]);
    expect(Object.keys(env).join()).not.toMatch(/OPENAI|TOKEN/);
    expect(JSON.stringify(env)).not.toContain("sk-secret");
  });
});

describe("SpeechInstaller", () => {
  const make = (overrides: Partial<ConstructorParameters<typeof SpeechInstaller>[0]> = {}, device: VoiceDevice = "cpu") => {
    const seen: InstallStatus[] = [];
    const installer = new SpeechInstaller({ home, device: () => device, onChange: (status) => seen.push(status), freeBytes: () => 50e9, ...overrides });
    return { installer, seen };
  };
  const markReady = (device: VoiceDevice) => {
    const paths = voicePaths(home);
    fs.mkdirSync(path.dirname(paths.python), { recursive: true });
    fs.writeFileSync(paths.python, "");
    fs.writeFileSync(paths.marker, JSON.stringify({ version: 1, device }));
  };

  it("starts not_installed", () => {
    expect(make().installer.status()).toEqual({ state: "not_installed", progress: 0 });
  });

  it("is ready, with no work, when a marker for this device exists", async () => {
    markReady("cpu");
    const { installer, seen } = make({ findPython: () => { throw new Error("must not look for Python"); } });
    expect(installer.status()).toEqual({ state: "ready", progress: 1 });
    await expect(installer.ensureInstalled()).resolves.toEqual({ state: "ready", progress: 1 });
    expect(seen).toEqual([]);
  });

  it("is not ready when the marker is for the other device", () => {
    markReady("gpu");
    expect(make({}, "cpu").installer.status().state).toBe("not_installed");
  });

  it("fails with an actionable reason when Python is missing", async () => {
    const { installer, seen } = make({ findPython: () => null });
    const result = await installer.ensureInstalled();
    expect(result).toMatchObject({ state: "failed", reason: expect.stringContaining("Python 3.10+") });
    expect(installer.status()).toMatchObject({ state: "failed" });
    expect(seen.map((status) => status.state)).toEqual(["installing", "failed"]);
  });

  it("fails before touching the venv when there is not enough disk", async () => {
    const { installer } = make({ findPython: () => ({ command: "python3", version: "3.13.0" }), freeBytes: () => 1e9 }, "gpu");
    const result = await installer.ensureInstalled();
    expect(result.reason).toMatch(/not enough disk space.*6 GB needed, 1\.0 GB free/);
    expect(fs.existsSync(voicePaths(home).venv)).toBe(false);
  });

  it("asks for more than the 5.2 GB a first-run GPU install measured, and 1.2 GB for the CPU path", () => {
    expect(REQUIRED_BYTES.gpu).toBeGreaterThan(5.2e9);
    expect(REQUIRED_BYTES.cpu).toBe(1.2e9);
  });

  it("fails with the command's own error when a step fails, and can be retried", async () => {
    const { installer } = make({ findPython: () => ({ command: path.join(home, "no-such-python"), version: "3.13.0" }) });
    const first = await installer.ensureInstalled();
    expect(first).toMatchObject({ state: "failed", reason: expect.stringContaining("creating the Python environment failed") });
    const second = await installer.ensureInstalled();
    expect(second.state).toBe("failed");
  });

  it("shares one run between concurrent callers", async () => {
    let looked = 0;
    const { installer } = make({ findPython: () => { looked += 1; return null; } });
    const [a, b] = await Promise.all([installer.ensureInstalled(), installer.ensureInstalled()]);
    expect(looked).toBe(1);
    expect(a).toEqual(b);
  });
});

describe("install failures", () => {
  it("are reported without the host's paths, on one line, and bounded", () => {
    const root = path.join(home, "models", "voice");
    const reason = installReason(`installing the speech packages failed (exit 1): ERROR: could not write ${home}/models/voice/venv/lib\nand more\n${"x".repeat(900)}`, root);
    expect(reason).not.toContain(home);
    expect(reason).toContain("<home>/models/voice/venv/lib");
    expect(reason).not.toContain("\n");
    expect(reason.length).toBeLessThanOrEqual(300);
  });

  it("end when the install is cancelled: the running child is stopped and the run reports failed", async () => {
    const python = path.join(home, "slow-python.sh");
    fs.writeFileSync(python, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const installer = new SpeechInstaller({ home, device: () => "cpu", freeBytes: () => 50e9, findPython: () => ({ command: python, version: "3.13.0" }) });
    const run = installer.ensureInstalled();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(installer.status().state).toBe("installing");
    const started = Date.now();
    installer.cancel();
    const result = await run;
    expect(result.state).toBe("failed");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
