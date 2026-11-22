// Speaks into the emulated phone's microphone and records what its speaker plays,
// through the emulator's gRPC audio service (the emulator's own PulseAudio
// backend does not work headless, and this does not need one).
//
//   node emulator-audio.mjs inject <speech.wav> [--rate 16000]
//   node emulator-audio.mjs record <out.wav> [--seconds 60]
//
// Connection: EMULATOR_GRPC_ENDPOINT (default 127.0.0.1:8554) and
// EMULATOR_GRPC_TOKEN, the `grpc.token` the emulator advertises in
// `$XDG_RUNTIME_DIR/avd/running/pid_<pid>.ini`.

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import grpc from "@grpc/grpc-js"
import protoLoader from "@grpc/proto-loader"

const here = fileURLToPath(new URL(".", import.meta.url))
const definition = protoLoader.loadSync(`${here}emulator-audio.proto`, { keepCase: true, longs: Number, enums: Number })
const { android } = grpc.loadPackageDefinition(definition)
const endpoint = process.env.EMULATOR_GRPC_ENDPOINT ?? "127.0.0.1:8554"
const token = process.env.EMULATOR_GRPC_TOKEN
const client = new android.emulation.control.EmulatorController(endpoint, grpc.credentials.createInsecure())
const metadata = new grpc.Metadata()
if (token) metadata.set("authorization", `Bearer ${token}`)

function readWav(path) {
  const buffer = readFileSync(path)
  let offset = 12
  let format = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === "fmt ") format = { channels: buffer.readUInt16LE(offset + 10), rate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22) }
    if (id === "data") {
      if (!format || format.channels !== 1 || format.bits !== 16) throw new Error("speech must be mono PCM16 WAV")
      return { rate: format.rate, pcm: buffer.subarray(offset + 8, offset + 8 + size) }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error("no data chunk")
}

function writeWav(path, rate, pcm) {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  writeFileSync(path, Buffer.concat([header, pcm]))
}

const [command, file, ...rest] = process.argv.slice(2)
const option = (name, fallback) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : fallback
}

if (command === "inject") {
  const { rate, pcm } = readWav(file)
  const format = { samplingRate: rate, channels: 0, format: 1, mode: 0 }
  await new Promise((resolve, reject) => {
    const call = client.injectAudio(metadata, (error) => (error ? reject(error) : resolve()))
    const packetBytes = (rate / 1000) * 20 * 2
    let offset = 0
    const pump = () => {
      while (offset < pcm.length) {
        const audio = pcm.subarray(offset, Math.min(pcm.length, offset + packetBytes))
        offset += audio.length
        if (!call.write({ format: offset <= packetBytes ? format : undefined, timestamp: Date.now() * 1000, audio })) {
          call.once("drain", pump)
          return
        }
      }
      call.end()
    }
    pump()
  })
  console.log(JSON.stringify({ injected: file, ms: Math.round((pcm.length / 2 / rate) * 1000) }))
} else if (command === "record") {
  const rate = 24_000
  const seconds = Number(option("seconds", 60))
  const chunks = []
  // The service sends packets only while the phone plays something. Each packet
  // carries its capture time, so gaps are filled with silence and the recording
  // lines up with the wall clock; the first packet's time goes in a sidecar file.
  let startUs = null
  let writtenSamples = 0
  const call = client.streamAudio({ samplingRate: rate, channels: 0, format: 1, mode: 0 }, metadata)
  const finish = () => {
    call.cancel()
    const pcm = Buffer.concat(chunks)
    writeWav(file, rate, pcm)
    if (startUs !== null) writeFileSync(`${file}.json`, JSON.stringify({ startEpochMs: Math.round(startUs / 1000), rate }))
    console.log(JSON.stringify({ recorded: file, ms: Math.round((pcm.length / 2 / rate) * 1000) }))
    process.exit(0)
  }
  call.on("data", (packet) => {
    const audio = Buffer.from(packet.audio)
    const at = Number(packet.timestamp)
    if (startUs === null) startUs = at
    const expected = Math.round(((at - startUs) / 1e6) * rate)
    if (expected > writtenSamples) {
      chunks.push(Buffer.alloc((expected - writtenSamples) * 2))
      writtenSamples = expected
    }
    chunks.push(audio)
    writtenSamples += audio.length / 2
  })
  call.on("error", (error) => (error.code === 1 ? undefined : (console.error(error.message), finish())))
  process.on("SIGTERM", finish)
  process.on("SIGINT", finish)
  setTimeout(finish, seconds * 1000)
} else {
  console.error("usage: emulator-audio.mjs inject <speech.wav> | record <out.wav> [--seconds N]")
  process.exit(2)
}
