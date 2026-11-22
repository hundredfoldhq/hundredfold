/**
 * First-use install of the local speech sidecar's runtime
 * (specs/009-voice-mode/contracts/speech-sidecar.md, "Bootstrap"): a Python venv with the
 * pinned packages and the models, all under `<home>/models/voice/`. Nothing is installed
 * system-wide and nothing is shared with Talk's Kokoro sidecar.
 *
 * `status()` reads the install state `GET /api/voice/config` reports; `ensureInstalled()`
 * is what `POST /api/voice/install` and the first use run, and is idempotent.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HUNDREDFOLD_HOME } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";

/** The packages the venv gets. `kokoro-onnx` is installed without its dependencies: it requires the CPU
 *  `onnxruntime`, which would sit beside `onnxruntime-gpu` and shadow it. */
export const PIN = {
  onnxAsr: "onnx-asr[hub]==0.12.0",
  kokoro: "kokoro-onnx==0.6.1",
  onnxruntimeCpu: "onnxruntime==1.32.0",
  onnxruntimeGpu: "onnxruntime-gpu[cuda,cudnn]==1.32.0",
  kokoroDeps: ["espeakng-loader==0.2.4", "phonemizer==3.6.0", "numpy", "huggingface_hub"],
} as const;

export const PARAKEET_NAME = "nemo-parakeet-tdt-0.6b-v2";
const PYTHON_CANDIDATES = ["python3.13", "python3.12", "python3.11", "python3.10", "python3"];
const MIN_PYTHON: readonly [number, number] = [3, 10];
const INSTALL_VERSION = 1;

export type VoiceDevice = "gpu" | "cpu";
export type InstallState = "not_installed" | "installing" | "ready" | "failed";
export interface InstallStatus {
  state: InstallState;
  /** 0 to 1. */
  progress: number;
  reason?: string;
}

export interface VoicePaths {
  root: string;
  venv: string;
  python: string;
  marker: string;
  script: string;
  vadDir: string;
  kokoroDir: string;
  /** The Parakeet directory for a device: fp32 for the GPU, int8 for the CPU. */
  sttDir(device: VoiceDevice): string;
}

export function voicePaths(home: string = HUNDREDFOLD_HOME): VoicePaths {
  const root = path.join(home, "models", "voice");
  const venv = path.join(root, "venv");
  return {
    root,
    venv,
    python: path.join(venv, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"),
    marker: path.join(root, "install.json"),
    script: sidecarScriptPath(),
    vadDir: path.join(root, "silero-vad"),
    kokoroDir: path.join(root, "kokoro-v1.0"),
    sttDir: (device) => path.join(root, `parakeet-tdt-0.6b-v2-${device === "gpu" ? "fp32" : "int8"}`),
  };
}

/** `speech_sidecar.py` sits beside this module's parent, in src and in dist (the build copies it). */
function sidecarScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "speech_sidecar.py");
}

/** The `hello.models` the sidecar loads from (shape documented in speech_sidecar.py). */
export function helloModels(paths: VoicePaths, device: VoiceDevice): Record<string, unknown> {
  return {
    stt: { name: PARAKEET_NAME, path: paths.sttDir(device), quantization: device === "gpu" ? null : "int8" },
    tts: { model: path.join(paths.kokoroDir, "kokoro-v1.0.onnx"), voices: path.join(paths.kokoroDir, "voices-v1.0.bin") },
    vad: { path: paths.vadDir, model: path.join(paths.vadDir, "silero_vad.onnx") },
  };
}

const PASS_THROUGH_ENV = [
  "PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "LD_LIBRARY_PATH",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "HF_ENDPOINT",
];

/** The environment of every process the voice runtime starts: the few names it needs, never the gateway's keys. */
export function sidecarEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1" };
  for (const name of PASS_THROUGH_ENV) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

export function spawnSidecar(paths: VoicePaths): ChildProcessWithoutNullStreams {
  return spawn(paths.python, ["-u", paths.script], { cwd: paths.root, env: sidecarEnv(), stdio: ["pipe", "pipe", "pipe"] });
}

// ── device and Python discovery ──────────────────────────────────────────────

export type GpuProbe = () => boolean;

const PROBE_TTL_MS = 30_000;
let probed: { at: number; gpu: boolean } | null = null;

/** True when `nvidia-smi` lists a GPU. Remembered for 30 s: it is asked on every status read. */
export const nvidiaSmiProbe: GpuProbe = () => {
  if (probed && Date.now() - probed.at < PROBE_TTL_MS) return probed.gpu;
  const result = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { encoding: "utf8", timeout: 10_000 });
  probed = { at: Date.now(), gpu: result.status === 0 && result.stdout.trim().length > 0 };
  return probed.gpu;
};

/** `local.device` to the device that will run: `auto` is the GPU when one is reported. */
export function resolveDevice(setting: "auto" | "gpu" | "cpu", probe: GpuProbe = nvidiaSmiProbe): VoiceDevice {
  if (setting === "auto") return probe() ? "gpu" : "cpu";
  return setting;
}

export interface PythonInfo {
  command: string;
  version: string;
}

function pythonVersion(command: string): string | null {
  const probe = spawnSync(command, ["-c", "import sys, venv, ensurepip; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8", timeout: 15_000 });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

const atLeast = (version: string, [major, minor]: readonly [number, number]): boolean => {
  const [a, b] = version.split(".").map(Number);
  return a! > major || (a === major && b! >= minor);
};

/** The newest Python 3.10+ that has `venv` and `pip` (`ensurepip`), or null. */
export function findPython(candidates: readonly string[] = PYTHON_CANDIDATES, version: (command: string) => string | null = pythonVersion): PythonInfo | null {
  for (const command of candidates) {
    const found = version(command);
    if (found && atLeast(found, MIN_PYTHON)) return { command, version: found };
  }
  return null;
}

let pythonProbe: { at: number; python: PythonInfo | null } | null = null;

/** `findPython`, remembered for 30 s: the config reply asks while nothing is installed. */
export function findPythonCached(): PythonInfo | null {
  if (pythonProbe && Date.now() - pythonProbe.at < PROBE_TTL_MS) return pythonProbe.python;
  pythonProbe = { at: Date.now(), python: findPython() };
  return pythonProbe.python;
}

// ── the installer ────────────────────────────────────────────────────────────

/** Disk needed under the home: the GPU path adds the CUDA wheels and the 2.4 GB fp32 model. */
export const REQUIRED_BYTES: Record<VoiceDevice, number> = { gpu: 3_800_000_000, cpu: 1_200_000_000 };
const EXPECTED_MODEL_BYTES: Record<VoiceDevice, number> = { gpu: 2_900_000_000, cpu: 1_050_000_000 };
const STAGES = { venv: 0.02, pip: 0.35, models: 1 } as const;

export interface InstallerOptions {
  home?: string;
  device: () => VoiceDevice;
  /** Called on every state or progress change. */
  onChange?: (status: InstallStatus) => void;
  findPython?: () => PythonInfo | null;
  freeBytes?: (dir: string) => number;
}

export class SpeechInstaller {
  private readonly paths: VoicePaths;
  private running: Promise<InstallStatus> | null = null;
  private current: InstallStatus | null = null;

  constructor(private readonly options: InstallerOptions) {
    this.paths = voicePaths(options.home);
  }

  /** What an `install` object in `GET /api/voice/config` says right now. */
  status(): InstallStatus {
    if (this.current && this.current.state !== "failed") return this.current;
    if (this.markerMatches()) return { state: "ready", progress: 1 };
    return this.current ?? { state: "not_installed", progress: 0 };
  }

  /** Install if needed; concurrent callers share one run, and a finished install returns at once. */
  ensureInstalled(): Promise<InstallStatus> {
    if (this.running) return this.running;
    if (this.markerMatches()) return Promise.resolve({ state: "ready", progress: 1 });
    this.running = this.install().finally(() => { this.running = null; });
    return this.running;
  }

  private markerMatches(): boolean {
    try {
      const marker = JSON.parse(fs.readFileSync(this.paths.marker, "utf8")) as { version?: number; device?: string };
      return marker.version === INSTALL_VERSION && marker.device === this.options.device() && fs.existsSync(this.paths.python);
    } catch {
      return false;
    }
  }

  private set(status: InstallStatus): InstallStatus {
    this.current = status;
    this.options.onChange?.(status);
    return status;
  }

  private async install(): Promise<InstallStatus> {
    const device = this.options.device();
    try {
      this.set({ state: "installing", progress: 0 });
      const python = (this.options.findPython ?? (() => findPython()))();
      if (!python) throw new Error("Python 3.10+ with venv and pip not found; install it first (see docs/voice.md)");
      this.checkDisk(device);
      await this.buildVenv(python);
      await this.installPackages(device);
      await this.downloadModels(device);
      fs.writeFileSync(this.paths.marker, JSON.stringify({ version: INSTALL_VERSION, device, python: python.version, installedAt: new Date().toISOString() }));
      return this.set({ state: "ready", progress: 1 });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`[voice] install failed: ${reason}`);
      return this.set({ state: "failed", progress: this.current?.progress ?? 0, reason });
    }
  }

  private checkDisk(device: VoiceDevice): void {
    fs.mkdirSync(this.paths.root, { recursive: true });
    const free = (this.options.freeBytes ?? freeBytesOf)(this.paths.root);
    if (free < REQUIRED_BYTES[device]) {
      throw new Error(`not enough disk space under the instance home: ${Math.ceil(REQUIRED_BYTES[device] / 1e9)} GB needed, ${(free / 1e9).toFixed(1)} GB free`);
    }
  }

  /** The venv is rebuilt from scratch: a venv whose base interpreter went away cannot be repaired in place. */
  private async buildVenv(python: PythonInfo): Promise<void> {
    fs.rmSync(this.paths.venv, { recursive: true, force: true });
    fs.rmSync(this.paths.marker, { force: true });
    await run(python.command, ["-m", "venv", this.paths.venv], { label: "creating the Python environment" });
    this.set({ state: "installing", progress: STAGES.venv });
  }

  private async installPackages(device: VoiceDevice): Promise<void> {
    const pip = (args: string[], label: string) =>
      run(this.paths.python, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", ...args], { label });
    await pip(["--upgrade", "pip"], "updating pip");
    await pip(["--no-deps", PIN.kokoro], "installing kokoro-onnx");
    await pip([PIN.onnxAsr, device === "gpu" ? PIN.onnxruntimeGpu : PIN.onnxruntimeCpu, ...PIN.kokoroDeps], "installing the speech packages");
    this.set({ state: "installing", progress: STAGES.pip });
  }

  private async downloadModels(device: VoiceDevice): Promise<void> {
    const models = helloModels(this.paths, device);
    const watch = setInterval(() => {
      const fraction = Math.min(1, dirBytes(this.paths.root, this.paths.venv) / EXPECTED_MODEL_BYTES[device]);
      this.set({ state: "installing", progress: STAGES.pip + (STAGES.models - STAGES.pip) * 0.98 * fraction });
    }, 1000);
    try {
      await run(this.paths.python, [this.paths.script, "--download", JSON.stringify(models)], { label: "downloading the speech models" });
    } finally {
      clearInterval(watch);
    }
  }
}

function freeBytesOf(dir: string): number {
  const stats = fs.statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Total size of the files under `dir`, skipping one subdirectory (the venv). */
function dirBytes(dir: string, skip: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (full === skip) continue;
    if (entry.isDirectory()) total += dirBytes(full, skip);
    else if (entry.isFile()) total += fs.statSync(full, { throwIfNoEntry: false })?.size ?? 0;
  }
  return total;
}

/** Run a command to completion; its last stderr lines are the failure's reason. */
function run(command: string, args: string[], options: { label: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: sidecarEnv(), stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-2000); });
    child.on("error", (error) => reject(new Error(`${options.label} failed: ${error.message}`)));
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      const last = tail.trim().split("\n").slice(-3).join(" | ");
      reject(new Error(`${options.label} failed (exit ${code})${last ? `: ${last}` : ""}`));
    });
  });
}
