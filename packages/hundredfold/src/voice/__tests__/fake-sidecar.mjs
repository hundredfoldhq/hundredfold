// A stand-in for speech_sidecar.py that speaks the same stdio framing. Behaviour is chosen
// with FAKE (nopong, nostt, partial-error, die-on-tts, badframe, nohello, error-hello, marker-vad); FAKE_MARKER=1 turns the marker VAD on in any mode; FAKE_LOG names a file that
// receives one line per request, so a test can see what the sidecar was sent.
import fs from "node:fs";

const mode = process.env.FAKE ?? "";
const log = process.env.FAKE_LOG;
let pending = Buffer.alloc(0);
const cancelled = new Set();
// marker-vad: a VAD that calls a 20 ms frame loud when its first sample is at least LOUD, with the real endpointer's rules
// (start moved back by prerollMs, end after silenceMs of quiet, end.atMs at the last loud frame). Offsets count every byte.
const LOUD = 1000;
const vads = new Map();
const marker = mode === "marker-vad" || process.env.FAKE_MARKER === "1";

function markerVad(header, body) {
  const v = vads.get(header.stream) ?? { offset: 0, preroll: 0, silence: 700, speaking: false, quiet: 0, lastLoudEnd: 0 };
  vads.set(header.stream, v);
  for (let at = 0; at + 640 <= body.length; at += 640, v.offset += 640) {
    const loud = body.readInt16LE(at) >= LOUD;
    if (loud && !v.speaking) {
      v.speaking = true;
      send({ op: "vad.event", stream: header.stream, kind: "start", atMs: Math.max(0, v.offset / 32 - v.preroll) });
    }
    if (loud) { v.quiet = 0; v.lastLoudEnd = (v.offset + 640) / 32; continue; }
    v.quiet += 20;
    if (v.speaking && v.quiet >= v.silence) {
      v.speaking = false;
      send({ op: "vad.event", stream: header.stream, kind: "end", atMs: v.lastLoudEnd });
    }
  }
}

function send(header, body = Buffer.alloc(0)) {
  const raw = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(raw.length, 0);
  prefix.writeUInt32BE(body.length, 4);
  process.stdout.write(Buffer.concat([prefix, raw, body]));
}

function handle(header, body) {
  if (log) fs.appendFileSync(log, `${header.op}${header.id ? `:${header.id}` : ""}\n`);
  switch (header.op) {
    case "hello":
      if (mode === "nohello") return;
      if (mode === "error-hello") return send({ op: "error", ref: "hello", message: "could not load the speech models: no model files" });
      return setTimeout(() => send({ op: "ready", device: "cpu", voices: ["af_heart", "bf_emma"], sttPartials: true }), Number(process.env.FAKE_HELLO_DELAY_MS ?? 0));
    case "ping":
      if (mode === "badframe") return process.stdout.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]));
      if (mode !== "nopong") send({ op: "pong", n: header.n });
      return;
    case "vad.open":
      if (marker) vads.set(header.stream, { offset: 0, preroll: header.prerollMs, silence: header.silenceMs, speaking: false, quiet: 0, lastLoudEnd: 0 });
      return;
    case "vad.audio":
      if (marker) return markerVad(header, body);
      return send({ op: "vad.event", stream: header.stream, kind: body.length === 2 ? "end" : "start", atMs: body.length });
    case "stt.partial":
    case "stt.final":
      if (mode === "nostt") return;
      if (mode === "partial-error" && header.op === "stt.partial") return send({ op: "error", ref: header.utterance, message: "partial decode failed", final: false });
      return setTimeout(
        () => send({ op: "stt.text", stream: header.stream, utterance: header.utterance, text: `${header.op}:${body.length}`, final: header.op === "stt.final" }),
        header.op === "stt.partial" ? Number(process.env.FAKE_PARTIAL_DELAY_MS ?? 0) : mode === "partial-error" ? 200 : 0,
      );
    case "cancel":
      cancelled.add(header.id);
      return;
    case "tts":
      if (mode === "die-on-tts") process.exit(1);
      return speak(header);
    default:
  }
}

function speak(header) {
  const chunk = Buffer.alloc(8);
  if (header.text !== "slow") {
    send({ op: "tts.audio", id: header.id, sampleRate: 24000 }, chunk);
    send({ op: "tts.audio", id: header.id, sampleRate: 24000 }, chunk);
    return send({ op: "tts.done", id: header.id });
  }
  const timer = setInterval(() => {
    if (cancelled.has(header.id)) return clearInterval(timer);
    send({ op: "tts.audio", id: header.id, sampleRate: 24000 }, chunk);
  }, 15);
}

process.stdin.on("data", (data) => {
  pending = Buffer.concat([pending, data]);
  while (pending.length >= 8) {
    const headerLength = pending.readUInt32BE(0);
    const bodyLength = pending.readUInt32BE(4);
    if (pending.length < 8 + headerLength + bodyLength) return;
    const header = JSON.parse(pending.subarray(8, 8 + headerLength).toString());
    const body = pending.subarray(8 + headerLength, 8 + headerLength + bodyLength);
    pending = pending.subarray(8 + headerLength + bodyLength);
    handle(header, body);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
