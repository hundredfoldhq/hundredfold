# Contract: gateway ↔ speech sidecar (stdio)

`packages/hundredfold/src/voice/speech_sidecar.py`, spawned by
`voice/sidecar/client.ts` with the voice venv's Python, `cwd` = its model dir, and stdin
and stdout as pipes (stderr goes to the gateway log at debug level).

## Framing

Each message both ways: `u32 BE headerLength`, `u32 BE bodyLength`, `header` (UTF-8 JSON),
`body` (raw bytes, may be empty). Maximum header 64 KB; maximum body 4 MB.

## Gateway → sidecar

| `op` | Header fields | Body | Reply |
|---|---|---|---|
| `hello` | `device: "auto"\|"gpu"\|"cpu"`, `models {stt, tts, vad}` | — | `ready {device, voices[], sttPartials: true}` or `error` |
| `vad.open` | `stream`, `threshold`, `minSpeechMs`, `silenceMs`, `prerollMs` | — | — |
| `vad.audio` | `stream` | PCM16LE 16 kHz | zero or more `vad.event {stream, kind: "start"\|"end", atMs}` |
| `vad.close` | `stream` | — | — |
| `stt.partial` | `stream`, `utterance` | PCM16LE 16 kHz (the whole utterance so far) | `stt.text {utterance, text, final: false}` |
| `stt.final` | `stream`, `utterance` | PCM16LE 16 kHz (whole utterance) | `stt.text {utterance, text, final: true}` |
| `tts` | `id`, `text`, `voice`, `speed`, `lang` | — | one or more `tts.audio {id, sampleRate}` + PCM16LE body, then `tts.done {id}` |
| `cancel` | `id` (a `tts` id or an `utterance`) | — | the matching op stops; no further replies for it |
| `ping` | `n` | — | `pong {n}` |

Every reply can instead be `error {ref, message}`. A request is answered in the order the
sidecar finishes it, not the order sent: replies carry the request's id, stream or
utterance.

**VAD offsets**: `vad.event` offsets are into the stream. `start.atMs` is where to cut from, with `prerollMs` already subtracted (minimum 0), so the hub must not subtract pre-roll again. `end.atMs` is where speech stopped, before the trailing silence. On the wire, offsets count from the first audio the sidecar received on this stream, so they start again at 0 when the gateway reopens the stream after a sidecar respawn. The gateway's client shifts them by where that reopen began in what the caller wrote, so the offsets the hub sees are positions in everything written to the stream since it was opened, across respawns. **Reset**: when the sidecar behind an open stream is lost, the client tells the stream's handlers `{ kind: "reset", atMs }`, where `atMs` is the position of the first byte the next sidecar will be sent (what the lost one had taken is gone with it). Nothing before that position will get an `end`, and every later event is at or after it. The in-process detector never emits one. A late frame from a sidecar the client has already replaced is dropped, not attributed to the new one.

**Hold and catch-up**: while the sidecar is not ready the client holds the stream's audio, up to 30 s (1500 frames of 20 ms, `VAD_HOLD_MS`); beyond that the oldest is replaced by silence of the same length, so offsets keep counting every byte written. Once the sidecar is up the VAD works through the hold and its events for that speech arrive late, in a burst. The hub keeps its own ring of `prerollMs` + 1.5 s + `VAD_HOLD_MS` of audio and cuts utterances from it by the event offsets: a `start` that arrives more than `prerollMs` + 1.5 s after the audio it points at opens an utterance that is fed nothing until its `end`, then `[start.atMs, end.atMs + silenceMs]` from the ring, so two utterances spoken during the load stay apart. A start that arrives promptly is streamed live, and so is one whose offset is older than the whole ring (the VAD is further behind than the sidecar holds): it is seeded from the most recent `prerollMs` + 1.5 s. A `reset` ends the open utterance at its position: a live one already holds everything up to there, a catch-up one is cut from its start to it (with the length limit), and any speech being ignored after a cut for length is heard again from the next `start`. A `start` while an utterance is open, with no `reset`, is a fallback with the same effect: the open utterance stops where the new speech begins. No byte of the stream goes to two utterances. How late a start may be and still count as live follows the detector's minimum speech: `max(1.5 s, minSpeechMs + 0.5 s)`. A catch-up utterance is cut for length at `maxUtteranceSeconds`, even when its `end` arrives in the same burst as its `start`, and in any case when its start leaves the ring (about 30 s on).

## Lifecycle

- Spawned on the first attachment, not at boot. Kept warm for 10 minutes after the last
  attachment ends, then sent EOF and reaped.
- `ping` every 15 s while attachments exist. Two missed pongs, or an exit, mark the
  provider unavailable, fail in-flight utterances with `stt_failed` / `tts_failed`, and
  respawn on the next need (at most once per 30 s).
- Killed on gateway shutdown.

## Bootstrap (first use, `voice/sidecar/bootstrap.ts`)

1. Find Python ≥ 3.10 (`python3.13`, `3.12`, `3.11`, `3.10`, `python3`).
2. `python -m venv <home>/models/voice/venv` (rebuilt from scratch if broken, as
   `kokoro.ts` does).
3. `pip install` the pinned set; `onnxruntime-gpu[cuda,cudnn]==1.32.0` when the device
   resolves to GPU, else `onnxruntime==1.32.0`.
4. Download models into `<home>/models/voice/` with `snapshot_download(local_dir=...)`,
   never the shared HF cache (R3 gotcha): Parakeet fp32 for GPU, int8 for CPU; the Kokoro
   ONNX file and voices; Silero VAD.
5. Report progress through `install` in `GET /api/voice/config` and a `voice:install`
   gateway event.
