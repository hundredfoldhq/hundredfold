// Evaluates JavaScript in the shell's main WebView over the Chrome DevTools
// protocol, so a run can call the native voice commands from the real,
// confined main window with no UI for them yet (debug builds only).
//
//   ADB="docker exec hf-emu adb" node drive-shell.mjs '<expression>'
//
// The expression may return a promise; its value is printed as JSON.

import { execFileSync } from "node:child_process"
import WebSocket from "ws"

const adb = (process.env.ADB ?? "adb").split(" ")
const run = (...args) => execFileSync(adb[0], [...adb.slice(1), ...args], { encoding: "utf8" }).trim()
const port = Number(process.env.CDP_PORT ?? 9222)

const pid = run("shell", "pidof", "run.hundredfold.shell").split(/\s+/)[0]
if (!pid) throw new Error("the shell is not running")
run("forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`)
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === "page" && /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost)/.test(t.url))
if (!page) throw new Error(`no main page among: ${targets.map((t) => t.url).join(", ")}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
const result = await new Promise((resolve, reject) => {
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString())
    if (message.id === 1) message.error ? reject(new Error(message.error.message)) : resolve(message.result)
  })
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: process.argv[2], awaitPromise: true, returnByValue: true } }))
})
socket.close()
if (result.exceptionDetails) {
  console.log(JSON.stringify({ exception: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text }))
  process.exitCode = 1
} else {
  console.log(JSON.stringify(result.result.value ?? null))
}
