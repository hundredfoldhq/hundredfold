/**
 * First-use install of the local speech sidecar's runtime
 * (specs/009-voice-mode/contracts/speech-sidecar.md, "Bootstrap"): a Python venv with the
 * pinned packages and the models, all under `<home>/models/voice/`. Nothing is installed
 * system-wide and nothing is shared with Talk's Kokoro sidecar.
 *
 * `status()` reads the install state `GET /api/voice/config` reports; `ensureInstalled()`
 * is what `POST /api/voice/install` and the first use run, and is idempotent.
 */
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HUNDREDFOLD_HOME } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import { DEFAULT_LOCAL_STT_MODEL, type LocalSttModelId } from "../../shared/voice-config.js";

/** The packages the venv gets. `kokoro-onnx` is installed without its dependencies: it requires the CPU
 *  `onnxruntime`, which would sit beside `onnxruntime-gpu` and shadow it. */
export const PIN = {
  onnxAsr: "onnx-asr[hub]==0.12.0",
  kokoro: "kokoro-onnx==0.6.1",
  onnxruntimeCpu: "onnxruntime==1.32.0",
  onnxruntimeGpu: "onnxruntime-gpu[cuda,cudnn]==1.32.0",
  kokoroDeps: ["espeakng-loader==0.2.4", "phonemizer==3.6.0", "numpy", "huggingface_hub"],
} as const;

/** `onnx-asr`'s name for the default model, which it fetches itself. */
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
  /** The Parakeet directory for a model and device: fp32 for the GPU, int8 for the CPU. */
  sttDir(device: VoiceDevice, model?: LocalSttModelId): string;
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
    sttDir: (device, model = DEFAULT_LOCAL_STT_MODEL) => path.join(root, `${model}-${device === "gpu" ? "fp32" : "int8"}`),
  };
}

// ── the local speech-to-text models ──────────────────────────────────────────

/** One pinned file of a model that `onnx-asr` cannot fetch by name: the repository, the commit, its path there, the name the loader wants, and its SHA-256. */
export interface PinnedFile {
  repo: string;
  revision: string;
  remote: string;
  local: string;
  sha256: string;
}

/** Third-party ONNX exports of NVIDIA's `parakeet-unified-en-0.6b` (NVIDIA Open Model License), pinned by commit and checked by hash. */
const UNIFIED_EXPORT = { repo: "eschmidbauer/parakeet-unified-en-0.6b-onnx", revision: "7a16ff98b72e5b0beba6f182a5357c704d977b15" } as const;
/** The same model's vocabulary in the layout `onnx-asr` reads (`token id` per line, blank last). */
const UNIFIED_VOCAB = { repo: "mrfakename/parakeet-unified-ONNX", revision: "a34b30ffd9dc312a4012ec0305d28f92a1c86c66" } as const;

const UNIFIED_FILES: Record<VoiceDevice, PinnedFile[]> = {
  gpu: [
    { ...UNIFIED_EXPORT, remote: "onnx_fp32/encoder.onnx", local: "encoder-model.onnx", sha256: "50083dd0b2af503b87ea8fcf9fd7d7dc15dda3130e4113017c8b37ed00418ba4" },
    // The graphs name their weight files, so these keep their exported names.
    { ...UNIFIED_EXPORT, remote: "onnx_fp32/encoder.onnx.data", local: "encoder.onnx.data", sha256: "c054b2932ee13aa39ed84982a399822f3193311fb6fd8e1e204566722614bd87" },
    { ...UNIFIED_EXPORT, remote: "onnx_fp32/decoder_joint.onnx", local: "decoder_joint-model.onnx", sha256: "ecf068008e3762f8601168c983433ef9e913c685fdaf8ee63882a5d6278f0556" },
    { ...UNIFIED_EXPORT, remote: "onnx_fp32/decoder_joint.onnx.data", local: "decoder_joint.onnx.data", sha256: "dda5c696945373bf9099c5c2fdd092b5c978d03ab79734a9f5623e527f5509ff" },
  ],
  cpu: [
    { ...UNIFIED_EXPORT, remote: "onnx_int8/encoder.int8.onnx", local: "encoder-model.int8.onnx", sha256: "8c430baee5a815b4ceee861f5f51b5b44db5836623ab2bfe9d0386e57b3f25ab" },
    { ...UNIFIED_EXPORT, remote: "onnx_int8/decoder_joint.int8.onnx", local: "decoder_joint-model.int8.onnx", sha256: "26a9f0ffb682cf2a712ac86e2e11b6da932f9860f70dc996841cba6392010b55" },
  ],
};
const UNIFIED_VOCAB_FILE: PinnedFile = { ...UNIFIED_VOCAB, remote: "vocab.txt", local: "vocab.txt", sha256: "dc0b4584ab2e4ddbf888425c076c61b736e7356a015250db7d307e6f1a8188ff" };

/** `config.json` as `onnx-asr` reads it for this model (the export ships none): a FastConformer RNN-T with 128 mel bins and 8x subsampling. */
const UNIFIED_CONFIG = { model_type: "nemo-conformer-rnnt", features_size: 128, subsampling_factor: 8, max_tokens_per_step: 10 } as const;

/** What the sidecar downloads when `onnx-asr` has no name for the model; absent for the default, which it fetches itself. */
export interface SttDownload {
  files: PinnedFile[];
  config: Record<string, unknown>;
}

/** Bytes a model's files take on disk, for the install's progress and its free-space check. */
export const STT_MODEL_BYTES: Record<LocalSttModelId, Record<VoiceDevice, number>> = {
  "parakeet-tdt-0.6b-v2": { gpu: 2_500_000_000, cpu: 700_000_000 },
  "parakeet-unified-en-0.6b": { gpu: 2_500_000_000, cpu: 670_000_000 },
};

export function sttDownload(model: LocalSttModelId, device: VoiceDevice): SttDownload | null {
  return model === "parakeet-unified-en-0.6b" ? { files: [...UNIFIED_FILES[device], UNIFIED_VOCAB_FILE], config: { ...UNIFIED_CONFIG } } : null;
}

/** `speech_sidecar.py` sits beside this module's parent, in src and in dist (the build copies it). */
function sidecarScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "speech_sidecar.py");
}

/** The `hello.models` the sidecar loads from (shape documented in speech_sidecar.py). */
export function helloModels(paths: VoicePaths, device: VoiceDevice, model: LocalSttModelId = DEFAULT_LOCAL_STT_MODEL): Record<string, unknown> {
  return {
    stt: { name: model === "parakeet-unified-en-0.6b" ? "nemo-conformer-rnnt" : PARAKEET_NAME, path: paths.sttDir(device, model), quantization: device === "gpu" ? null : "int8" },
    tts: { model: path.join(paths.kokoroDir, "kokoro-v1.0.onnx"), voices: path.join(paths.kokoroDir, "voices-v1.0.bin") },
    vad: { path: paths.vadDir, model: path.join(paths.vadDir, "silero_vad.onnx") },
  };
}

const PASS_THROUGH_ENV = [
  "PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "LD_LIBRARY_PATH",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "HF_ENDPOINT",
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
  const result = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] });
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
  const probe = spawnSync(command, ["-c", "import sys, venv, ensurepip; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
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

/** Disk needed under the home. The GPU path adds the CUDA wheels and the 2.4 GB fp32 model: measured at 5.2 GB after a first-run install, so 6 GB leaves headroom. */
export const REQUIRED_BYTES: Record<VoiceDevice, number> = { gpu: 6_000_000_000, cpu: 1_200_000_000 };
/** Adding one speech-to-text model to an install that has its Python environment: the model plus headroom. */
export const MODEL_ONLY_REQUIRED_BYTES: Record<VoiceDevice, number> = { gpu: 3_500_000_000, cpu: 1_000_000_000 };
const EXPECTED_MODEL_BYTES: Record<VoiceDevice, number> = { gpu: 2_900_000_000, cpu: 1_050_000_000 };
const STAGES = { venv: 0.02, pip: 0.35, models: 1 } as const;

export interface InstallerOptions {
  home?: string;
  device: () => VoiceDevice;
  /** The speech-to-text model to have installed. Defaults to the default model. */
  sttModel?: () => LocalSttModelId;
  /** Called on every state or progress change. */
  onChange?: (status: InstallStatus) => void;
  findPython?: () => PythonInfo | null;
  freeBytes?: (dir: string) => number;
}

interface Marker {
  version?: number;
  device?: string;
  python?: string;
  /** The speech-to-text models downloaded so far; a marker from before there were several holds only the default. */
  sttModels?: string[];
  installedAt?: string;
}

/**
 * One install at a time per instance home, across installers: a second installer (another speech-to-text
 * model, after a config reload) waits for the first, then looks at the marker again. Two at once would
 * rebuild the venv under each other.
 */
const homeInstalls = new Map<string, Promise<unknown>>();

export class SpeechInstaller {
  private readonly paths: VoicePaths;
  private running: Promise<InstallStatus> | null = null;
  private current: InstallStatus | null = null;

  constructor(private readonly options: InstallerOptions) {
    this.paths = voicePaths(options.home);
  }

  private model(): LocalSttModelId {
    return this.options.sttModel?.() ?? DEFAULT_LOCAL_STT_MODEL;
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
    const root = this.paths.root;
    const ahead = homeInstalls.get(root);
    if (ahead) this.set({ state: "installing", progress: 0 });
    const turn = (ahead ?? Promise.resolve()).then(() => (this.markerMatches() ? this.set({ state: "ready", progress: 1 }) : this.install()));
    const tail = turn.catch(() => undefined);
    homeInstalls.set(root, tail);
    this.running = turn.finally(() => {
      this.running = null;
      if (homeInstalls.get(root) === tail) homeInstalls.delete(root);
    });
    return this.running;
  }

  /** Stop a running install (gateway shutdown): its children end, and the run reports itself failed. */
  cancel(): void {
    killLiveChildren();
  }

  private readMarker(): Marker | null {
    try {
      return JSON.parse(fs.readFileSync(this.paths.marker, "utf8")) as Marker;
    } catch {
      return null;
    }
  }

  /** The Python environment and the packages are in place for this device (whatever speech-to-text models are downloaded). */
  private environmentReady(marker: Marker | null): marker is Marker {
    return marker !== null && marker.version === INSTALL_VERSION && marker.device === this.options.device() && fs.existsSync(this.paths.python);
  }

  private markerMatches(): boolean {
    const marker = this.readMarker();
    return this.environmentReady(marker) && (marker.sttModels ?? [DEFAULT_LOCAL_STT_MODEL]).includes(this.model());
  }

  private set(status: InstallStatus): InstallStatus {
    this.current = status;
    this.options.onChange?.(status);
    return status;
  }

  private async install(): Promise<InstallStatus> {
    const device = this.options.device();
    const model = this.model();
    try {
      this.set({ state: "installing", progress: 0 });
      const marker = this.readMarker();
      // A new model on an install that works: fetch the model, keep the environment.
      const modelOnly = this.environmentReady(marker);
      if (!modelOnly) {
        const python = (this.options.findPython ?? (() => findPython()))();
        if (!python) throw new Error("Python 3.10+ with venv and pip not found; install it first (see docs/voice.md)");
        this.checkDisk(REQUIRED_BYTES[device]);
        await this.buildVenv(python);
        await this.installPackages(device);
        await this.downloadModels(device, model, false);
        this.writeMarker(device, [model], python.version);
      } else {
        this.checkDisk(MODEL_ONLY_REQUIRED_BYTES[device]);
        await this.downloadModels(device, model, true);
        this.writeMarker(device, [...new Set([...(marker.sttModels ?? [DEFAULT_LOCAL_STT_MODEL]), model])], marker.python);
      }
      return this.set({ state: "ready", progress: 1 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`[voice] install failed: ${detail}`);
      return this.set({ state: "failed", progress: this.current?.progress ?? 0, reason: installReason(detail, this.paths.root) });
    }
  }

  private writeMarker(device: VoiceDevice, sttModels: string[], python: string | undefined): void {
    const marker: Marker = { version: INSTALL_VERSION, device, python, sttModels, installedAt: new Date().toISOString() };
    fs.writeFileSync(this.paths.marker, JSON.stringify(marker));
  }

  private checkDisk(needed: number): void {
    fs.mkdirSync(this.paths.root, { recursive: true });
    const free = (this.options.freeBytes ?? freeBytesOf)(this.paths.root);
    if (free < needed) {
      throw new Error(`not enough disk space under the instance home: ${Math.ceil(needed / 1e9)} GB needed, ${(free / 1e9).toFixed(1)} GB free`);
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

  /** `sttOnly` fetches just the speech-to-text model (the other models are already there). */
  private async downloadModels(device: VoiceDevice, model: LocalSttModelId, sttOnly: boolean): Promise<void> {
    const hello = helloModels(this.paths, device, model);
    const download = sttDownload(model, device);
    const models = { ...hello, stt: { ...(hello.stt as object), ...(download ? { download } : {}) }, ...(sttOnly ? { only: ["stt"] } : {}) };
    // Progress is the bytes on disk against what is expected: the whole models folder, or just this model's.
    const [watched, skipped, from, expected] = sttOnly
      ? [this.paths.sttDir(device, model), "", 0, STT_MODEL_BYTES[model][device]]
      : [this.paths.root, this.paths.venv, STAGES.pip, EXPECTED_MODEL_BYTES[device]];
    const watch = setInterval(() => {
      const fraction = Math.min(1, dirBytes(watched, skipped) / expected);
      this.set({ state: "installing", progress: from + (STAGES.models - from) * 0.98 * fraction });
    }, 1000);
    try {
      await run(this.paths.python, [this.paths.script, "--download", JSON.stringify(models)], { label: "downloading the speech models" });
    } finally {
      clearInterval(watch);
    }
  }
}

/** A failure's reason as a person (and a board member) may read it: no host path, one line, bounded. */
export function installReason(detail: string, root: string): string {
  const home = path.resolve(root, "..", "..");
  const oneLine = detail.split(home).join("<home>").replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
}

function freeBytesOf(dir: string): number {
  const stats = fs.statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Total size of the files under `dir`, skipping one subdirectory (the venv). */
function dirBytes(dir: string, skip: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // the download renamed or removed it mid-scan; the next tick counts again
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (full === skip) continue;
    if (entry.isDirectory()) total += dirBytes(full, skip);
    else if (entry.isFile()) total += fs.statSync(full, { throwIfNoEntry: false })?.size ?? 0;
  }
  return total;
}

/** The install's running children: killed when the gateway exits, so pip is not left running under init. */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function killLiveChildren(): void {
  for (const child of liveChildren) child.kill("SIGTERM");
  liveChildren.clear();
}

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", killLiveChildren);
}

/** Run a command to completion; its last stderr lines are the failure's reason. */
function run(command: string, args: string[], options: { label: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: sidecarEnv(), stdio: ["ignore", "ignore", "pipe"] });
    trackChild(child);
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
