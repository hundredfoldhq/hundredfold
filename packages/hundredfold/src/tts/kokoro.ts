/**
 * Kokoro-82M TTS engine behind chat read-aloud (`POST/GET /api/tts`).
 *
 * Implements the `Tts` interface from ./protocol.js. Mirrors the STT sidecar
 * pattern (src/stt/stt.ts): weights live under HUNDREDFOLD_HOME/models/kokoro, a Python
 * venv hosts a long-running HTTP sidecar (kokoro_sidecar.py) that wraps
 * `kokoro-onnx`, and this module owns the sidecar's lifecycle (spawn / health /
 * restart / shutdown).
 *
 * Everything is defensive: if Python, the venv, or the weights are missing,
 * status().available is false and synthesize() rejects gracefully so the route
 * answers 503 and the client falls back to the browser's Web Speech.
 */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { HUNDREDFOLD_HOME } from "../shared/paths.js"
import { logger } from "../shared/logger.js"
import { errorField, traceLine } from "../voice/trace.js"
import { wavFacts } from "./wav-facts.js"
import type { Tts } from "./protocol.js"

/** Model / venv layout under HUNDREDFOLD_HOME. */
const KOKORO_DIR = path.join(HUNDREDFOLD_HOME, "models", "kokoro")
const VENV_PYTHON = path.join(KOKORO_DIR, "venv", "bin", "python")
const ONNX_FILE = path.join(KOKORO_DIR, "kokoro-v1.0.onnx")
const VOICES_FILE = path.join(KOKORO_DIR, "voices-v1.0.bin")

const DEFAULT_VOICE = "af_heart"
const DEFAULT_PORT = 8765
const SYNTH_TIMEOUT_MS = 120_000

interface HealthResponse {
  ok: boolean
  ready: boolean
}

/** Resolve the sidecar .py path: next to this module, then a src/ fallback. */
function resolveSidecarPath(): string {
  const here = fileURLToPath(import.meta.url)
  const sameDir = path.join(path.dirname(here), "kokoro_sidecar.py")
  if (fs.existsSync(sameDir)) return sameDir
  // Running from dist before the lead's build copies the .py — fall back to src.
  const srcPath = here.replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`)
  if (srcPath !== here) {
    const candidate = srcPath.replace(/kokoro\.(js|ts)$/, "kokoro_sidecar.py")
    if (fs.existsSync(candidate)) return candidate
  }
  return sameDir // best effort; spawn will surface ENOENT
}

/** Pick a free localhost TCP port (used when no explicit port is configured). */
function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once("error", () => resolve(preferred)) // fall back to preferred on bind error
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : preferred
      srv.close(() => resolve(port))
    })
  })
}

export function createKokoroTts(opts?: {
  voice?: string
  modelDir?: string
  sidecarPort?: number
}): Tts {
  const voice = opts?.voice || DEFAULT_VOICE
  const modelDir = opts?.modelDir || KOKORO_DIR
  const onnxFile = modelDir === KOKORO_DIR ? ONNX_FILE : path.join(modelDir, "kokoro-v1.0.onnx")
  const voicesFile = modelDir === KOKORO_DIR ? VOICES_FILE : path.join(modelDir, "voices-v1.0.bin")
  const pythonBin =
    modelDir === KOKORO_DIR ? VENV_PYTHON : path.join(modelDir, "venv", "bin", "python")

  let child: ChildProcess | null = null
  let port = 0
  let starting: Promise<void> | null = null
  let ready = false // last-known sidecar /health "ready" (model loaded)

  /** Are the on-disk weights present? */
  function weightsPresent(): boolean {
    return fs.existsSync(onnxFile) && fs.existsSync(voicesFile)
  }

  /**
   * Is the venv python runnable? `fs.existsSync` follows symlinks, so a DANGLING
   * symlink (e.g. the base Homebrew python was upgraded/removed out from under
   * the venv) correctly reports false. We additionally surface the broken-symlink case with a warning
   * so a silent python upgrade doesn't quietly strand us on the fallback voice.
   */
  function pythonPresent(): boolean {
    if (fs.existsSync(pythonBin)) return true
    const lst = fs.lstatSync(pythonBin, {
      throwIfNoEntry: false,
    } as fs.StatSyncOptions & { throwIfNoEntry: false })
    if (lst && lst.isSymbolicLink()) {
      logger.warn(
        `[kokoro] venv python is a broken symlink (${pythonBin}) — its base interpreter is gone; the venv must be rebuilt`,
      )
    }
    return false
  }

  async function httpGetHealth(p: number): Promise<HealthResponse | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (!res.ok) return null
      return (await res.json()) as HealthResponse
    } catch {
      return null
    }
  }

  /** Spawn the sidecar and wait until /health answers. Idempotent per failure. */
  async function ensureSidecar(): Promise<void> {
    // Already alive?
    if (child && child.exitCode === null && port) {
      const h = await httpGetHealth(port)
      if (h?.ok) {
        ready = h.ready
        return
      }
    }
    if (starting) return starting

    starting = (async () => {
      if (!pythonPresent()) {
        throw new Error(`Kokoro venv python missing at ${pythonBin} — it has not been set up`)
      }
      if (!weightsPresent()) {
        throw new Error(`Kokoro weights missing in ${modelDir} — it has not been set up`)
      }

      const chosen = opts?.sidecarPort || (await findFreePort(DEFAULT_PORT))
      const sidecar = resolveSidecarPath()
      const spawnedAt = Date.now()
      logger.info(traceLine("kokoro_sidecar_spawn", { port: chosen, voice }))

      const proc = spawn(
        pythonBin,
        [sidecar, "--port", String(chosen), "--model-dir", modelDir, "--voice", voice],
        { stdio: ["ignore", "pipe", "pipe"] },
      )

      let listening = false
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!listening) reject(new Error("Kokoro sidecar did not start in time"))
        }, 20_000)

        proc.stdout?.on("data", (buf: Buffer) => {
          const line = buf.toString()
          if (line.includes("KOKORO_SIDECAR_LISTENING")) {
            listening = true
            clearTimeout(timer)
            resolve()
          }
        })
        proc.stderr?.on("data", (buf: Buffer) => {
          logger.debug(`[kokoro] ${buf.toString().trim()}`)
        })
        proc.on("error", (err) => {
          clearTimeout(timer)
          reject(err)
        })
        proc.on("exit", (code) => {
          if (!listening) {
            clearTimeout(timer)
            reject(new Error(`Kokoro sidecar exited early (code ${code})`))
          }
        })
      })

      // Reset liveness flags whenever the process dies so the next call respawns.
      proc.on("exit", (code, signal) => {
        logger.warn(`[kokoro] sidecar exited (code=${code} signal=${signal})`)
        if (child === proc) {
          child = null
          port = 0
          ready = false
        }
      })

      child = proc
      port = chosen
      const h = await httpGetHealth(chosen)
      ready = h?.ready ?? false
      logger.info(`[kokoro] sidecar listening on 127.0.0.1:${chosen} (voice=${voice})`)
      logger.info(traceLine("kokoro_sidecar_ready", { port: chosen, startup_ms: Date.now() - spawnedAt, model_loaded: ready }))
    })()

    try {
      await starting
    } finally {
      starting = null
    }
  }

  /**
   * POST one sentence to /synth. The sidecar can die between ensureSidecar's
   * liveness check and the request (or mid-request) — if the failure coincides
   * with a dead/absent child, reset state and retry the spawn once.
   */
  async function synth(text: string): Promise<Buffer> {
    try {
      return await synthOnce(text)
    } catch (err) {
      if (child && child.exitCode === null) throw err // sidecar alive — a real synth error
      logger.warn(
        `[kokoro] synth failed with sidecar dead — respawning once (${err instanceof Error ? err.message : err})`,
      )
      child = null
      port = 0
      ready = false
      return synthOnce(text)
    }
  }

  async function synthOnce(text: string): Promise<Buffer> {
    const startedAt = Date.now()
    await ensureSidecar()
    const sidecarMs = Date.now() - startedAt
    if (!port) throw new Error("Kokoro sidecar not available")
    const requestedAt = Date.now()
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${port}/synth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
        signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
      })
    } catch (err) {
      logger.warn(traceLine("kokoro_synth_failed", { chars: text.length, stage: "request", error: errorField(err), ms: Date.now() - startedAt }))
      throw err
    }
    if (!res.ok) {
      let detail = ""
      try {
        detail = ((await res.json()) as { error?: string }).error || ""
      } catch {
        /* non-json error body */
      }
      logger.warn(traceLine("kokoro_synth_failed", { chars: text.length, stage: "status", status: res.status, error: detail.slice(0, 120), ms: Date.now() - startedAt }))
      throw new Error(`Kokoro synth failed (${res.status})${detail ? `: ${detail}` : ""}`)
    }
    ready = true // a successful synth means the model is loaded
    const body = Buffer.from(await res.arrayBuffer())
    const facts = wavFacts(body)
    const line = traceLine("kokoro_synth", {
      chars: text.length, ms: Date.now() - startedAt, sidecar_wait_ms: sidecarMs, request_ms: Date.now() - requestedAt, ...facts,
      // Speech runs at about 12 characters a second; much less audio than that is a clip that was cut short.
      ms_per_char: facts.wav_ms !== undefined && text.length > 0 ? Math.round(facts.wav_ms / text.length) : undefined,
    })
    if (facts.wav_ok) logger.info(line)
    else logger.warn(line)
    return body
  }

  return {
    async synthesize(text: string): Promise<Buffer> {
      // Fail fast & gracefully if the engine can't run at all (the route turns
      // this into a 503 {available:false} so the client falls back to Web Speech).
      if (!pythonPresent() || !weightsPresent()) {
        throw new Error(
          "Kokoro TTS unavailable (missing venv or weights) — falling back to Web Speech",
        )
      }
      const clean = text.replace(/\s+/g, " ").trim()
      if (!clean) throw new Error("Kokoro synthesize: empty text")
      // The kokoro-onnx sidecar handles arbitrary-length text in one /synth call,
      // returning a single valid WAV — no per-sentence concatenation needed.
      return synth(clean)
    },

    async warm(): Promise<void> {
      // Nothing to warm if the engine can't run; synthesize() will surface the error.
      if (!pythonPresent() || !weightsPresent()) return
      try {
        // One throwaway synth spawns the sidecar AND forces the heavy model load
        // so the user's first real sentence doesn't pay it. Audio is discarded.
        await synth(".")
      } catch (err) {
        logger.debug(`[kokoro] warm failed: ${err instanceof Error ? err.message : err}`)
      }
    },

    status() {
      return {
        available: pythonPresent() && weightsPresent(),
        voice,
        ready: ready && child !== null && child.exitCode === null,
      }
    },

    shutdown(): void {
      if (child && child.exitCode === null) {
        try {
          child.kill("SIGTERM")
        } catch {
          /* already gone */
        }
      }
      child = null
      port = 0
      ready = false
    },
  }
}
