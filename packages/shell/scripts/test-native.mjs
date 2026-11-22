// The Rust half of the shell has two parts.
//
// `hundredfold-voice-core` (the native voice session's wire frames, frame bridge
// and state machine) has no platform dependencies, so its tests run anywhere
// cargo is installed.
//
// The shell crate itself needs the platform webview to build (WebKitGTK on Linux,
// WebKit on macOS), so `cargo test` for it runs here only on macOS. It also builds
// and tests on Linux where the WebKitGTK development packages are installed; the
// README has the container command. Say plainly that it was skipped everywhere
// else rather than reporting a pass nobody earned.
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "Cargo.toml")
const cargo = (args) => spawnSync("cargo", ["test", "--manifest-path", manifest, ...args], { stdio: "inherit" })

const core = cargo(["-p", "hundredfold-voice-core"])
if (core.error) {
  if (process.platform === "darwin") {
    console.error(`@hundredfold/shell: could not run cargo (${core.error.message})`)
    process.exit(1)
  }
  console.log(`@hundredfold/shell: skipping cargo test on ${process.platform} (cargo is not installed)`)
  process.exit(0)
}
if (core.status !== 0) process.exit(core.status ?? 1)

if (process.platform !== "darwin") {
  console.log(`@hundredfold/shell: skipping the shell crate's cargo test on ${process.platform} (it needs the platform webview libraries; see the README)`)
  process.exit(0)
}

const result = cargo([])
if (result.error) {
  console.error(`@hundredfold/shell: could not run cargo (${result.error.message})`)
  process.exit(1)
}
process.exit(result.status ?? 1)
