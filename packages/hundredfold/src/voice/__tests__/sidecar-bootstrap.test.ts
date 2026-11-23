import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_ONLY_REQUIRED_BYTES, REQUIRED_BYTES, SpeechInstaller, findPython, installReason, helloModels, resolveDevice, sidecarEnv, sttDownload, voicePaths, type InstallStatus, type VoiceDevice } from "../sidecar/bootstrap.js";
import type { LocalSttModelId } from "../../shared/voice-config.js";

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

  it("keeps the default model's directory and loader name exactly as before, and gives the unified model its own", () => {
    const paths = voicePaths(home);
    expect(paths.sttDir("gpu")).toBe(path.join(paths.root, "parakeet-tdt-0.6b-v2-fp32"));
    expect(paths.sttDir("gpu", "parakeet-tdt-0.6b-v2")).toBe(paths.sttDir("gpu"));
    expect(helloModels(paths, "gpu").stt).toEqual({ name: "nemo-parakeet-tdt-0.6b-v2", path: paths.sttDir("gpu"), quantization: null });
    expect(helloModels(paths, "gpu", "parakeet-unified-en-0.6b").stt).toEqual({ name: "nemo-conformer-rnnt", path: path.join(paths.root, "parakeet-unified-en-0.6b-fp32"), quantization: null });
    expect(helloModels(paths, "cpu", "parakeet-unified-en-0.6b").stt).toEqual({ name: "nemo-conformer-rnnt", path: path.join(paths.root, "parakeet-unified-en-0.6b-int8"), quantization: "int8" });
    expect(helloModels(paths, "cpu", "parakeet-unified-en-0.6b").tts).toEqual(helloModels(paths, "cpu").tts);
  });

  it("gives the streaming model its own directory and tells the sidecar to keep per-utterance state, for it alone", () => {
    const paths = voicePaths(home);
    const streaming = helloModels(paths, "gpu", "parakeet-unified-en-0.6b-streaming").stt;
    expect(streaming).toEqual({ name: "nemo-conformer-rnnt", path: path.join(paths.root, "parakeet-unified-en-0.6b-streaming-fp32"), quantization: null, streaming: true });
    expect(helloModels(paths, "cpu", "parakeet-unified-en-0.6b-streaming").stt).toEqual({ name: "nemo-conformer-rnnt", path: path.join(paths.root, "parakeet-unified-en-0.6b-streaming-int8"), quantization: "int8", streaming: true });
    for (const model of ["parakeet-tdt-0.6b-v2", "parakeet-unified-en-0.6b"] as const) expect(helloModels(paths, "gpu", model).stt).not.toHaveProperty("streaming");
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

describe("sttDownload", () => {
  it("is none for the default model, which onnx-asr fetches by name", () => {
    expect(sttDownload("parakeet-tdt-0.6b-v2", "gpu")).toBeNull();
    expect(sttDownload("parakeet-tdt-0.6b-v2", "cpu")).toBeNull();
  });

  it.each<[VoiceDevice, string[]]>([
    ["gpu", ["encoder-model.onnx", "encoder.onnx.data", "decoder_joint-model.onnx", "decoder_joint.onnx.data", "vocab.txt"]],
    ["cpu", ["encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "vocab.txt"]],
  ])("names the files onnx-asr loads for the unified model on the %s", (device, locals) => {
    const download = sttDownload("parakeet-unified-en-0.6b", device)!;
    expect(download.files.map((file) => file.local)).toEqual(locals);
    expect(download.config).toMatchObject({ model_type: "nemo-conformer-rnnt", features_size: 128, subsampling_factor: 8 });
  });

  it("pins every file to a commit and a SHA-256, never a branch", () => {
    for (const device of ["gpu", "cpu"] as const) {
      for (const file of [...sttDownload("parakeet-unified-en-0.6b", device)!.files, ...sttDownload("parakeet-unified-en-0.6b-streaming", device)!.files]) {
        expect(file.revision, file.remote).toMatch(/^[0-9a-f]{40}$/);
        expect(file.sha256, file.remote).toMatch(/^[0-9a-f]{64}$/);
        expect(file.repo, file.remote).toMatch(/^[\w.-]+\/[\w.-]+$/);
      }
    }
  });

  it.each<[VoiceDevice, string[]]>([
    ["gpu", ["encoder-model.onnx", "encoder.weights", "decoder_joint-model.onnx", "decoder_joint.onnx.data", "vocab.txt"]],
    ["cpu", ["encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "vocab.txt"]],
  ])("names the files for the streaming model on the %s: its own encoder graph over the offline model's decoder, joint and vocabulary", (device, locals) => {
    const streaming = sttDownload("parakeet-unified-en-0.6b-streaming", device)!;
    const offline = sttDownload("parakeet-unified-en-0.6b", device)!;
    expect(streaming.files.map((file) => file.local)).toEqual(locals);
    expect(streaming.config).toEqual(offline.config);
    const shared = (file: { local: string }) => file.local.startsWith("decoder_joint") || file.local === "vocab.txt";
    expect(streaming.files.filter(shared)).toEqual(offline.files.filter(shared));
    const encoder = streaming.files[0]!;
    expect(encoder.sha256).not.toBe(offline.files[0]!.sha256);
    expect(encoder.repo).toContain("streaming");
  });

  it("lets the streaming model share the offline model's weights on the GPU, where the bytes are identical", () => {
    const streaming = sttDownload("parakeet-unified-en-0.6b-streaming", "gpu")!.files;
    const offline = sttDownload("parakeet-unified-en-0.6b", "gpu")!.files;
    const weights = streaming.find((file) => file.local === "encoder.weights")!;
    const offlineWeights = offline.find((file) => file.local === "encoder.onnx.data")!;
    expect(weights.sha256).toBe(offlineWeights.sha256);
    expect(weights.reuse).toBe(`../parakeet-unified-en-0.6b-fp32/${offlineWeights.local}`);
    expect(sttDownload("parakeet-unified-en-0.6b-streaming", "cpu")!.files.some((file) => file.reuse)).toBe(false);
  });

  it("does not share files between the two devices' variants except the vocabulary", () => {
    const gpu = sttDownload("parakeet-unified-en-0.6b", "gpu")!.files.map((file) => file.sha256);
    const cpu = sttDownload("parakeet-unified-en-0.6b", "cpu")!.files.map((file) => file.sha256);
    expect(gpu.filter((hash) => cpu.includes(hash))).toHaveLength(1);
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

  describe("per speech-to-text model", () => {
    const unified: LocalSttModelId = "parakeet-unified-en-0.6b";
    const markWith = (device: VoiceDevice, extra: Record<string, unknown>) => {
      const paths = voicePaths(home);
      fs.mkdirSync(path.dirname(paths.python), { recursive: true });
      fs.writeFileSync(paths.python, "");
      fs.writeFileSync(paths.marker, JSON.stringify({ version: 1, device, python: "3.13.0", ...extra }));
    };

    it("treats a marker from before there were several models as holding the default only", () => {
      markReady("cpu");
      expect(make().installer.status().state).toBe("ready");
      expect(make({ sttModel: () => unified }).installer.status().state).toBe("not_installed");
    });

    it("is ready for a model its marker lists, and not for one it does not", () => {
      markWith("cpu", { sttModels: [unified] });
      expect(make({ sttModel: () => unified }).installer.status().state).toBe("ready");
      expect(make({ sttModel: () => "parakeet-tdt-0.6b-v2" }).installer.status().state).toBe("not_installed");
      markWith("cpu", { sttModels: ["parakeet-tdt-0.6b-v2", unified] });
      expect(make({ sttModel: () => unified }).installer.status().state).toBe("ready");
      expect(make().installer.status().state).toBe("ready");
    });

    it("adds only the model to an install whose environment works: no Python lookup, no venv rebuild, and a smaller disk check", async () => {
      markWith("cpu", {});
      const venvMarker = path.join(path.dirname(voicePaths(home).python), "kept");
      fs.writeFileSync(venvMarker, "x");
      // The download step runs this stand-in "python": it records its arguments and succeeds.
      const log = path.join(home, "download-args.json");
      fs.writeFileSync(voicePaths(home).python, `#!/bin/sh\nprintf '%s' "$3" > ${JSON.stringify(log)}\n`, { mode: 0o755 });
      fs.chmodSync(voicePaths(home).python, 0o755); // markWith made it as an empty, non-executable file
      const { installer, seen } = make({ sttModel: () => unified, findPython: () => { throw new Error("must not look for Python"); }, freeBytes: () => MODEL_ONLY_REQUIRED_BYTES.cpu + 1 });
      await expect(installer.ensureInstalled()).resolves.toEqual({ state: "ready", progress: 1 });
      expect(fs.existsSync(venvMarker)).toBe(true);
      const args = JSON.parse(fs.readFileSync(log, "utf8")) as { only: string[]; stt: { name: string; download: { files: unknown[] } } };
      expect(args.only).toEqual(["stt"]);
      expect(args.stt.name).toBe("nemo-conformer-rnnt");
      expect(args.stt.download.files).toHaveLength(3);
      const marker = JSON.parse(fs.readFileSync(voicePaths(home).marker, "utf8")) as { sttModels: string[]; device: string; python: string };
      expect(marker).toMatchObject({ device: "cpu", python: "3.13.0" });
      expect([...marker.sttModels].sort()).toEqual(["parakeet-tdt-0.6b-v2", unified].sort());
      expect(seen.at(-1)).toEqual({ state: "ready", progress: 1 });
      expect(make().installer.status().state).toBe("ready"); // the default is still installed
    });

    it("refuses a model-only install without room for the model, naming the smaller need", async () => {
      markReady("gpu");
      const { installer } = make({ sttModel: () => unified, freeBytes: () => 1e9 }, "gpu");
      const result = await installer.ensureInstalled();
      expect(result.reason).toMatch(/not enough disk space.*4 GB needed, 1\.0 GB free/);
      expect(MODEL_ONLY_REQUIRED_BYTES.gpu).toBeLessThan(REQUIRED_BYTES.gpu);
    });

    it("two installers on one home, for two models, build the venv once and the marker lists both", async () => {
      const calls = path.join(home, "calls.log");
      const python = path.join(home, "fake-python.sh");
      // The base interpreter makes the venv; the venv's python is slow at pip, so a second installer arrives mid-install.
      const venvPython = `#!/bin/sh\necho "venv $*" >> ${calls}\nif [ "$2" = "pip" ]; then sleep 1; fi\nexit 0\n`;
      fs.writeFileSync(python, `#!/bin/sh\necho "base $*" >> ${calls}\nif [ "$1" = "-m" ] && [ "$2" = "venv" ]; then mkdir -p "$3/bin" && cat > "$3/bin/python" <<'EOS'\n${venvPython}EOS\nchmod +x "$3/bin/python"; fi\nexit 0\n`, { mode: 0o755 });
      const findPython = () => ({ command: python, version: "3.13.0" });
      const first = make({ findPython }).installer;
      const second = make({ sttModel: () => unified, findPython }).installer;
      const a = first.ensureInstalled();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(second.status().state).toBe("not_installed");
      const b = second.ensureInstalled();
      expect(second.status().state).toBe("installing"); // waiting its turn
      await expect(Promise.all([a, b])).resolves.toEqual([{ state: "ready", progress: 1 }, { state: "ready", progress: 1 }]);
      const log = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean);
      expect(log.filter((line) => line.startsWith("base -m venv"))).toHaveLength(1);
      expect(log.filter((line) => line.includes("pip install") && line.includes("--upgrade pip"))).toHaveLength(1);
      expect(log.filter((line) => line.includes("--download"))).toHaveLength(2); // both models were fetched
      const marker = JSON.parse(fs.readFileSync(voicePaths(home).marker, "utf8")) as { sttModels: string[] };
      expect([...marker.sttModels].sort()).toEqual(["parakeet-tdt-0.6b-v2", unified].sort());
    }, 30_000);

    it("a second installer that finds its model installed by the first does no work", async () => {
      const python = path.join(home, "fake-python.sh");
      fs.writeFileSync(python, `#!/bin/sh\nif [ "$1" = "-m" ] && [ "$2" = "venv" ]; then mkdir -p "$3/bin" && printf '#!/bin/sh\\nexit 0\\n' > "$3/bin/python" && chmod +x "$3/bin/python"; fi\nexit 0\n`, { mode: 0o755 });
      const findPython = () => ({ command: python, version: "3.13.0" });
      const a = make({ sttModel: () => unified, findPython }).installer;
      const b = make({ sttModel: () => unified, findPython: () => { throw new Error("must not look for Python"); } }).installer;
      const first = a.ensureInstalled();
      const second = b.ensureInstalled();
      await expect(Promise.all([first, second])).resolves.toEqual([{ state: "ready", progress: 1 }, { state: "ready", progress: 1 }]);
    });

    it("a fresh install records the model it downloaded", async () => {
      const python = path.join(home, "fake-python.sh");
      // `-m venv <dir>` makes a venv whose python is the stand-in below; everything else succeeds.
      fs.writeFileSync(python, `#!/bin/sh\nif [ "$1" = "-m" ] && [ "$2" = "venv" ]; then mkdir -p "$3/bin" && printf '#!/bin/sh\\nexit 0\\n' > "$3/bin/python" && chmod +x "$3/bin/python"; fi\nexit 0\n`, { mode: 0o755 });
      const { installer } = make({ sttModel: () => unified, findPython: () => ({ command: python, version: "3.13.0" }) });
      await expect(installer.ensureInstalled()).resolves.toEqual({ state: "ready", progress: 1 });
      const marker = JSON.parse(fs.readFileSync(voicePaths(home).marker, "utf8")) as { sttModels: string[] };
      expect(marker.sttModels).toEqual([unified]);
      expect(make({ sttModel: () => unified }).installer.status().state).toBe("ready");
      expect(make().installer.status().state).toBe("not_installed");
    });
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
