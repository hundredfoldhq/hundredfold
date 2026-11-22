// A small fake gateway that speaks the voice contract, for exercising the
// native voice client without the real voice hub:
//   - POST /api/auth/pair            -> two HttpOnly cookies and a device receipt
//   - DELETE /api/auth/devices/:id   -> 200
//   - GET /ws/voice/:sessionId       -> the voice socket (specs/009-voice-mode/contracts/voice-socket.md)
//
// It does just enough of the hub's job to drive a locked-screen exchange: a
// level-based VAD on the up audio, a canned transcript, and a spoken reply
// streamed in real time as down frames, split into segments. It honours
// `barge_in`, `played`, `ptt_*`, `resume` and `bye`, and it can send its own
// `stop_playback`. There is no speech recognition and no model: the transcript
// is a placeholder saying how long the utterance was.
//
//   node fake-voice-server.mjs [--port 7790] [--log events.jsonl]
//        [--reply reply.wav] [--gateway-stop-ms 0] [--end-silence-ms 800] [--never-ready]
//
// `--reply` is a 24 kHz mono PCM16 WAV (default: a synthetic tone sequence).
// `--gateway-stop-ms N` sends `stop_playback` after N ms of speech over
// playback (0 disables it, so the client's own onset detector does the work).
// `--never-ready` reads `hello` and then stays silent, to exercise the client's
// wait for `ready`.
// `GET /stats` reports the up-audio frames received, so a run can check that
// audio kept arriving while the phone's screen was locked.

import { createServer } from "node:http"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"

import { WebSocketServer } from "ws"

const UP_RATE = 16_000
const DOWN_RATE = 24_000
const UP_FRAME_BYTES = 640
const PAIR_CODE = "123456"

export function parseWav(buffer) {
  // Minimal RIFF reader: finds `fmt ` and `data` chunks.
  let offset = 12
  let format = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === "fmt ") {
      format = { channels: buffer.readUInt16LE(offset + 10), rate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22) }
    } else if (id === "data") {
      if (!format || format.channels !== 1 || format.bits !== 16) throw new Error("reply must be mono PCM16")
      return { rate: format.rate, pcm: buffer.subarray(offset + 8, offset + 8 + size) }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error("no data chunk")
}

/** Three tone "sentences" of a few seconds each, so a barge-in has somewhere to land. */
function syntheticReply(seconds = [4, 4, 4]) {
  return seconds.map((length, index) => {
    const frames = Math.floor(length * DOWN_RATE)
    const pcm = Buffer.alloc(frames * 2)
    for (let i = 0; i < frames; i++) {
      const t = i / DOWN_RATE
      const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t)
      const sample = Math.sin(2 * Math.PI * (330 + 110 * index) * t) * 0.3 * envelope
      pcm.writeInt16LE(Math.round(sample * 32767), i * 2)
    }
    return pcm
  })
}

function splitSegments(pcm, count) {
  const frames = pcm.length / 2
  const per = Math.ceil(frames / count)
  return Array.from({ length: count }, (_, i) => pcm.subarray(i * per * 2, Math.min(frames, (i + 1) * per) * 2)).filter((p) => p.length > 0)
}

function rms(buffer) {
  const samples = Math.floor(buffer.length / 2)
  if (!samples) return 0
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const s = buffer.readInt16LE(i * 2)
    sum += s * s
  }
  return Math.sqrt(sum / samples) / 32768
}

export function createFakeVoiceServer({ port = 7790, logPath, replyWav, gatewayStopMs = 0, endSilenceMs = 800, neverReady = false, host = "127.0.0.1" } = {}) {
  const log = (event, detail = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...detail })
    if (logPath) appendFileSync(logPath, line + "\n")
    else console.log(line)
  }
  const segments = replyWav
    ? splitSegments(parseWav(readFileSync(replyWav)).pcm, 3)
    : syntheticReply()
  const tokens = new Map() // auth token -> device id
  const state = { attachments: new Map() }
  const totals = { upFrames: 0, sockets: 0 }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    if (req.method === "POST" && url.pathname === "/api/auth/pair") {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        let code = ""
        try { code = JSON.parse(body).code } catch { /* falls through to 401 */ }
        if (code !== PAIR_CODE) { res.writeHead(401).end(); log("pair_refused"); return }
        const token = randomBytes(16).toString("hex")
        const device = `device-${randomBytes(3).toString("hex")}`
        tokens.set(token, device)
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": [`hundredfold_auth=${token}; Path=/; HttpOnly; SameSite=Lax`, `hundredfold_device=${device}; Path=/; HttpOnly; SameSite=Lax`],
        })
        res.end(JSON.stringify({ device: { id: device, name: "Android emulator" } }))
        log("paired", { device })
      })
      return
    }
    if (req.method === "GET" && url.pathname === "/stats") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(totals))
      return
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/auth/devices/")) {
      res.writeHead(200).end("{}")
      log("device_revoked")
      return
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x")
    const match = /^\/ws\/voice\/([A-Za-z0-9._-]+)$/.exec(url.pathname)
    const cookie = /hundredfold_auth=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1]
    if (!match || !cookie || !tokens.has(cookie)) {
      log("upgrade_refused", { path: url.pathname, cookie: Boolean(cookie) })
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => connection(ws, match[1]))
  })

  function connection(ws, sessionId) {
    log("socket_open", { sessionId })
    totals.sockets += 1
    const send = (frame) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(frame))
    const s = {
      mode: "hands-free",
      pttDown: false,
      speaking: false,
      speechMs: 0,
      silenceMs: 0,
      utteranceMs: 0,
      upFrames: 0,
      replyId: 0, // bumps on interrupt: cancels the sender
      playing: false,
      speechOverPlaybackMs: 0,
      nextSegment: 1,
      played: new Set(),
    }

    function interrupt(why) {
      if (!s.playing) return
      s.playing = false
      s.replyId += 1
      send({ type: "turn", state: "idle" })
      log("reply_interrupted", { why })
    }

    async function reply() {
      const id = ++s.replyId
      s.playing = true
      send({ type: "turn", state: "thinking" })
      await new Promise((r) => setTimeout(r, 300))
      if (id !== s.replyId) return
      send({ type: "turn", state: "speaking" })
      let seq = 0
      const chunkBytes = 1920 // 40 ms
      for (const pcm of segments) {
        const segmentId = s.nextSegment++
        send({ type: "segment_start", segmentId, messageId: null, text: `segment ${segmentId}` })
        log("segment_start", { segmentId, ms: Math.round((pcm.length / 2 / DOWN_RATE) * 1000) })
        const started = Date.now()
        let sentMs = 0
        for (let off = 0; off < pcm.length; off += chunkBytes) {
          if (id !== s.replyId || ws.readyState !== ws.OPEN) return
          const chunk = pcm.subarray(off, Math.min(pcm.length, off + chunkBytes))
          const header = Buffer.alloc(8)
          header.writeUInt8(1, 0)
          header.writeUInt16LE(seq++ & 0xffff, 2)
          header.writeUInt32LE(segmentId, 4)
          ws.send(Buffer.concat([header, chunk]))
          sentMs += (chunk.length / 2 / DOWN_RATE) * 1000
          // Stay about 400 ms ahead of real time, as a streaming TTS would.
          const wait = sentMs - (Date.now() - started) - 400
          if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        }
        if (id !== s.replyId) return
        send({ type: "segment_end", segmentId })
        log("segment_end", { segmentId })
      }
      // Wait for the client to report the last segment played, then go idle.
      s.finishing = id
    }

    function utteranceEnded() {
      log("utterance", { ms: s.utteranceMs })
      send({ type: "vad", speaking: false })
      send({ type: "transcript", utteranceId: `u${Date.now()}`, text: `[fake transcript of a ${s.utteranceMs} ms utterance]`, final: true })
      send({ type: "metrics", utteranceId: `u${Date.now()}`, sttMs: 40, ttfaMs: 700 })
      s.utteranceMs = 0
      interrupt("new_utterance")
      void reply()
    }

    function onAudio(frame) {
      s.upFrames += 1
      totals.upFrames += 1
      if (s.upFrames === 1) log("first_up_frame", { bytes: frame.length })
      if (frame.length > 4096) { send({ type: "error", code: "bad_frame", message: "frame too large" }); return }
      const level = rms(frame)
      const frameMs = (frame.length / 2 / UP_RATE) * 1000
      if (level >= 0.02) {
        s.speechMs += frameMs
        s.silenceMs = 0
        if (!s.speaking && s.speechMs >= 100) {
          s.speaking = true
          send({ type: "vad", speaking: true })
          log("speech_start", { playing: s.playing })
        }
        if (s.speaking) s.utteranceMs += frameMs
        if (s.playing && gatewayStopMs > 0) {
          s.speechOverPlaybackMs += frameMs
          if (s.speechOverPlaybackMs >= gatewayStopMs) {
            send({ type: "stop_playback", reason: "speech" })
            log("stop_playback_sent")
            interrupt("gateway_vad")
            s.speechOverPlaybackMs = 0
          }
        }
      } else {
        s.silenceMs += frameMs
        s.speechOverPlaybackMs = 0
        if (s.speaking && s.silenceMs >= endSilenceMs) {
          s.speaking = false
          s.speechMs = 0
          utteranceEnded()
        } else if (!s.speaking) {
          s.speechMs = 0
        }
      }
    }

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!s.ready) { send({ type: "error", code: "bad_frame", message: "audio before hello" }); return }
        if (s.mode === "push-to-talk" && !s.pttDown) return
        onAudio(data)
        return
      }
      let frame
      try { frame = JSON.parse(data.toString()) } catch { send({ type: "error", code: "bad_frame", message: "not json" }); return }
      switch (frame.type) {
        case "hello":
          if (frame.protocol !== 1 || (frame.mode !== "hands-free" && frame.mode !== "push-to-talk")) {
            send({ type: "error", code: "bad_frame", message: "bad hello" })
            ws.close(4400, "protocol")
            return
          }
          s.mode = frame.mode
          log("hello", { mode: frame.mode, client: frame.client })
          if (neverReady) break
          s.ready = true
          send({
            type: "ready", protocol: 1, sessionId,
            input: { encoding: "pcm16", sampleRate: UP_RATE }, output: { encoding: "pcm16", sampleRate: DOWN_RATE },
            stt: { provider: "fake", partials: false }, tts: { provider: "fake", voice: null },
            onset: { threshold: 0.05, minSpeechMs: 200 }, backgrounding: "native", limits: { maxUtteranceSeconds: 60 },
          })
          break
        case "ptt_down": s.pttDown = true; log("ptt_down"); break
        case "ptt_up":
          s.pttDown = false
          log("ptt_up")
          if (s.utteranceMs > 0) { s.speaking = false; s.speechMs = 0; utteranceEnded() }
          break
        case "barge_in":
          log("barge_in", { segmentId: frame.segmentId, playedMs: frame.playedMs })
          interrupt("client_barge_in")
          break
        case "played":
          s.played.add(frame.segmentId)
          log("played", { segmentId: frame.segmentId })
          if (s.finishing === s.replyId && frame.segmentId === s.nextSegment - 1) {
            s.playing = false
            s.finishing = 0
            send({ type: "turn", state: "idle" })
            log("reply_complete")
          }
          break
        case "resume": log("resume", { suspendedMs: frame.suspendedMs }); break
        case "bye": log("bye"); ws.close(1000, "bye"); break
        default: log("unknown_frame", { type: frame.type })
      }
    })
    ws.on("close", (code) => { s.replyId += 1; log("socket_close", { code, upFrames: s.upFrames }) })
  }

  return {
    start: () => new Promise((resolve) => server.listen(port, host, () => { log("listening", { port, host }); resolve(server.address().port) })),
    stop: () => new Promise((resolve) => { wss.clients.forEach((c) => c.terminate()); server.close(() => resolve()) }),
    state,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 ? process.argv[i + 1] : fallback
  }
  const logPath = arg("log")
  if (logPath) writeFileSync(logPath, "")
  const fake = createFakeVoiceServer({
    port: Number(arg("port", 7790)),
    logPath,
    replyWav: arg("reply"),
    gatewayStopMs: Number(arg("gateway-stop-ms", 0)),
    endSilenceMs: Number(arg("end-silence-ms", 800)),
    neverReady: process.argv.includes("--never-ready"),
  })
  await fake.start()
  process.on("SIGTERM", () => fake.stop().then(() => process.exit(0)))
}
