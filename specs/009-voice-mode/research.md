# Research: Voice Mode for a Chat

Phase 0 of the plan. Each entry: decision, rationale, alternatives. Measurements were
taken on the build machine on 2026-11-22 (AMD Threadripper 2990WX, 64 threads, load
average about 110 at the time; NVIDIA Quadro RTX 5000, 16 GB). Spike scripts lived in a
scratch directory and are not part of the change.

## R1. Transport between browser and gateway

**Decision**: a per-session WebSocket, `/ws/voice/:sessionId`, routed by the existing
upgrade handler next to `/ws/pty/:sessionId`. JSON text frames for control and binary
frames for audio. Reply *text* stays on the existing `/ws` broadcast as `session:delta`.

**Rationale**: the broadcast socket fans out to every tab and to member sockets with
re-serialised frames. Audio is per listener and arrives from the client, so it cannot
ride the broadcast. The PTY channel is the precedent for a per-session socket: same
upgrade router, auth gate, origin check and heartbeat sweep. The web client already opens
sockets through `gateway-transport.ts` `openSocket`, and the Tauri shell's Rust `stream`
command already carries text and binary frames both ways (`stream.rs` `OutgoingFrame`).
So the same socket works from a browser and from the mobile app with no new transport.

**Alternatives**: multiplex audio on `/ws`. Rejected: it is a broadcast, and member
sockets are a separate re-serialising path. WebRTC to the gateway. Rejected: it needs a
media stack (ICE, DTLS, SRTP) on the gateway for no gain on a LAN or tailnet, and the
shell's transport is WebSocket. HTTP chunked upload plus SSE. Rejected: two
connections, no binary down on SSE, awkward barge-in.

## R2. Audio format on the wire

**Decision**: PCM16LE mono. Up at 16 kHz in 20 ms frames (640 bytes). Down at 24 kHz with
an 8-byte header (`u8 kind=1, u8 reserved, u16 seq, u32 segmentId`). The gateway
normalises every provider's output to 24 kHz PCM.

**Rationale**: no codec dependency on any side (browser AudioWorklet, Swift, Kotlin,
Node, Python all handle PCM natively). 32 KB/s up and 48 KB/s down are fine on Wi-Fi and
acceptable on mobile data. Kokoro and OpenAI speech both produce 24 kHz natively.

**Alternatives**: Opus. Rejected for the first release (a WASM or native encoder on every
client, a decoder on the gateway). Recorded as the follow-up for mobile data: continuous
upstream (R4) costs about 115 MB/hour.

## R3. Local speech-to-text: Parakeet TDT 0.6B v2

**Decision**: NVIDIA Parakeet TDT 0.6B v2 through `onnx-asr` (0.12.0) on ONNX Runtime,
in a gateway-managed Python sidecar. GPU (CUDA execution provider, fp32 model) when an
NVIDIA GPU is present; CPU (int8 model) otherwise.

**Rationale**: the operator chose Parakeet v2, English only. `onnx-asr` loads the
published ONNX export (`istupakov/parakeet-tdt-0.6b-v2-onnx`) with no NeMo or PyTorch
dependency. Measured, for a 3-second question synthesised by Kokoro:

| Variant | Device | Latency (warm) | Text |
|---|---|---|---|
| fp32 | GPU (CUDA EP) | 51 to 102 ms | exact |
| int8 | GPU requested | 3.4 to 6.3 s (int8 ops fall back to CPU) | exact |
| int8 | CPU, host loaded to ~110 | 4.8 to 7.8 s | exact |

So the GPU path uses fp32 and the CPU path uses int8. CPU latency on an unloaded machine
is not measured here, so the documentation states the GPU figure and says that CPU-only
hosts are slower. Model files: fp32 about 2.4 GB plus data, int8 about 650 MB. Only the
variant in use is downloaded.

**Gotcha found in the spike**: ONNX Runtime 1.32 refuses an external-data file reached
through the Hugging Face cache's symlinked blob layout ("External data path escapes model
directory"). Download with `snapshot_download(..., local_dir=<models dir>)` and load with
`path=`, never from the shared HF cache.

**Partial transcripts**: Parakeet v2 is an offline model. Partials come from re-decoding
the growing utterance buffer every 400 ms while speech continues, skipping a tick when
the previous decode has not finished. At 50 to 100 ms per decode on the GPU this is
cheap. On CPU the skip rule degrades partials gracefully instead of queueing work.

**Licence**: the ONNX export is published under CC-BY-4.0, and NVIDIA's model card names
its community model licence. Hundredfold does not ship the weights; the gateway
downloads them on first use, as it already does for Whisper and Kokoro. The docs name
the licence and link the model card.

**Alternatives**: sherpa-onnx (Node addon with a Parakeet int8 build). Rejected: a native
npm dependency in the published package for every user, no fp32 GPU path in the prebuilt
binaries, and the repository already runs Kokoro in a Python sidecar. NeMo directly.
Rejected: a multi-GB PyTorch install. Whisper (already used by dictation). Rejected by
the operator's choice; Parakeet is also much faster at equal English accuracy.

## R4. Voice activity detection and endpointing

**Decision**: the **gateway** runs Silero VAD (through `onnx-asr`'s VAD support, in the
same sidecar) on the continuous upstream audio, and owns utterance start and end,
partials and finals. Each **client** runs only a tiny energy-onset detector, and uses it
for one thing: stopping playback at once on barge-in (FR-009).

**Rationale**: one VAD implementation, shared by the browser and the native mobile
clients, so the native client stays thin (capture, play, stop). The gateway can also
gate a hosted STT provider, sending it only speech. FR-009 needs playback to stop
without a round trip, which an energy threshold held for `bargeIn.minSpeechMs` gives on
any platform in a few lines. A false trigger (a cough) costs nothing: the server VAD
plus STT find no words, and FR-010 resumes speech.

**Alternatives**: Silero in the browser (`@ricky0123/vad-web`, ONNX WASM). Rejected as
the authority: it would need a second implementation in Swift and Kotlin for the
locked-screen client, plus an extra ~2 MB WASM payload. A cost: the client streams audio
continuously while voice mode is on (R2). Provider endpointing (OpenAI's server VAD).
Not available for the local provider; used only as a hint where present.

## R5. Local text-to-speech: Kokoro-82M

**Decision**: Kokoro-82M v1.0 through `kokoro-onnx` (0.6.1) in the same sidecar, GPU
when present. The default voice is whichever the operator picks from the recorded
samples; `af_heart` until then.

**Rationale**: the operator asked for a model comparable to Parakeet that is above all
nice to listen to. Published 2026 comparisons consistently put Kokoro first among small
open TTS models for naturalness and speed. It is Apache-2.0, has about 50 preset voices
in American and British English, and the repository already downloads and runs it for
read-aloud (`talk/kokoro.ts`). Measured on the GPU: 0.12 s for a one-word sentence and
0.38 s for 4.35 s of speech. On the loaded CPU: 24 s for 4.35 s of speech. Nine sample
voices were rendered and transcribed back word for word by Parakeet.

**Alternatives** (from 2026 comparisons): Chatterbox (Turbo 350M) has strong cloning but
needs a 4 to 8 GB GPU, and its maintenance status is unclear. Orpheus 3B is the most
expressive but needs 8 to 12 GB of GPU memory and is heavy on CPU. Qwen3-TTS needs 6 GB
or more of GPU memory. None runs acceptably on CPU, which a self-hosted default must.
They can be added later as optional providers if someone wants them (Principle V: not
now).

## R6. One speech sidecar, managed by the gateway

**Decision**: a new Python sidecar `voice/speech_sidecar.py`, spawned and supervised by
the gateway like `talk/kokoro.ts` does Kokoro, with its own venv and models under
`<home>/models/voice/`. It talks to the gateway over its **stdin/stdout** with framed
messages (a 4-byte length plus a JSON header plus an optional binary body), multiplexing
streams by id. One process holds VAD, Parakeet and Kokoro. It installs itself on first
use (`python -m venv`, pinned `pip install`, model download) with progress reported, and
picks `onnxruntime-gpu[cuda,cudnn]` when `nvidia-smi` reports a GPU, else `onnxruntime`.

**Rationale**: stdio needs no port (Kokoro's sidecar binds 8765), cannot be reached by
other local users, and dies with the gateway. Framing carries binary PCM without base64.
One process loads each model once. The venv bootstrap follows `kokoro.ts` `ensureVenv`.
Pinned versions make installs reproducible: `onnx-asr==0.12.0`,
`kokoro-onnx==0.6.1`, `onnxruntime(-gpu)==1.32.0`, `huggingface_hub`, `numpy`.

**Read-aloud is left alone**: `/api/tts` keeps its own Kokoro sidecar. Folding it into
the speech sidecar is a later simplification, not this feature's.

**Alternatives**: HTTP like the Kokoro sidecar. Rejected: VAD needs a continuous frame
stream per attachment, which over HTTP is either chatty or needs a WebSocket server the
Python standard library lacks. Node-native ONNX Runtime (`onnxruntime-node`). Rejected:
no GPU wheels story comparable to pip's CUDA wheels, and Kokoro's phonemiser is Python.

## R7. Pre-installation requirements

**Decision**: documented in `docs/voice.md` as required before enabling the local
providers: Python 3.10 or newer with `venv` and `pip`; about 1 GB of disk for CPU
models or about 3.5 GB for GPU models; for the GPU path, an NVIDIA driver recent enough
for CUDA 12 (the CUDA and cuDNN runtimes come from pip wheels). Nothing else: no
`whisper-cli`, no `ffmpeg`, no espeak (Kokoro's phonemiser ships its own espeak-ng data
in its wheel, confirmed in the spike on a host without espeak). The build machine already
has Python 3.13 and the NVIDIA driver; the sidecar's first run installs the rest, and the
demo phase records that it did.

## R8. Barge-in and long work, per engine

**Decision**: as the spec's FR-009 to FR-018, implemented by a hub policy over engine
capabilities:

| Engine | Capability | Long work on barge-in |
|---|---|---|
| claude (interactive) | `SoftInterruptibleEngine` (new): Ctrl+B then Esc; also `SteerableEngine` | A running Bash is backgrounded by Ctrl+B and keeps running; Claude wakes itself with a task notification when it ends. A long MCP call or sub-agent cannot be backgrounded: the utterance is steered, lands after that call ends, and a holding line is spoken at once. A steer never cuts in on a running call (verified: a paste during a 45 s command was delivered when it ended) |
| opencode 2.x | `SteerableEngine` (exists) | steer at the next step, plus a spoken holding line |
| others | neither | queue behind the turn, plus a holding line; existing interrupt when nothing long runs |

**Rationale**: verified live on Claude Code 2.1.330 in a PTY with hooks relayed
(Part C, T037):

- **Esc alone kills** a running foreground Bash (SIGTERM within about 1 s). The claude
  process stays alive, no task notification follows, and Esc fires no Stop hook (the
  turn ends with "[Request interrupted by user]"), so the engine settles the turn
  itself. `CLAUDE_AUTO_BACKGROUND_TASKS=1` changes nothing here; it only arms the CLI's
  own 120 s auto-background timer. `backgroundedByTurnAbort` applies to a plugin's turn
  abort, not the TUI's Esc.
- **Ctrl+B (0x02), then Esc, preserves the work.** Ctrl+B backgrounds the running Bash
  (`PostToolUse` with `tool_response.backgroundTaskId`, `backgroundedByUser: true`, a
  tool result saying it was manually backgrounded). The engine waits, bounded, for that
  `PostToolUse` before Esc: an Esc in the same tick still keeps the command, but the id
  then arrives only in the later notification. Esc then ends the turn. The command
  runs to completion, claude stays alive, and a `<task-notification>` wakes a fresh turn
  (`UserPromptSubmit` with the notification, then `Stop`).

Ctrl+B with nothing running is harmless. An Esc before the model has produced output puts
the turn's prompt back in the composer, so the engine clears the composer after Esc, or the
next paste would be appended to the old prompt.

So Claude's `softInterrupt` is Ctrl+B (when a foreground Bash is running) followed by
Esc, and never `kill` or a PTY release. Today's `InteractiveClaudeEngine.kill` releases
the PTY and would end background shells. Ctrl+B only backgrounds a Bash, so a long MCP
call or sub-agent is **not backgroundable**. `ForegroundWork.backgroundable` reports
this per call, and the policy steers instead (the steer lands at the next tool boundary,
after that call ends), so it is never aborted. The CLI refuses a foreground
`sleep N && …` (it points at Monitor or `run_in_background`), so live tests and the demo
use a node timer command, as the existing steer tests do.

## R9. Voice instructions

**Decision**: a gateway envelope on the prompt. The full voice prompt goes on the first
voice turn after attach and after a compaction or engine switch; a one-line reminder goes
on every later voice turn. It is stripped in `transcriptEntryText`, carried through every
prompt-recompose site as the left-background note is, and never added to a `/`-led
prompt.

**Rationale**: a system-prompt change needs a respawn on most engines. The envelope
pattern already exists for the left-background-tasks note, the pause notice and the
board reminder, with known gotchas (duplicate transcript rows) and known fixes.

## R10. Board members

**Finding**: board members cannot message sessions today. The board-members design gives
"session transcripts, chat" and "anything that starts or wakes an agent" to the operator
only (`docs/design/board-members.md`, Roles). Member sockets accept only `/ws`
(`accounts/member-router.ts` `memberMayUpgrade`). There is no member chat for voice to
attach to.

**Decision**: voice authorises through **one predicate**, "may this principal send
messages to this session", used at upgrade and re-checked on access changes (the member
socket sweep pattern). Today it is true for the operator, and false for every member
because members have no chat. `memberMayUpgrade` gains `/ws/voice/:id` behind that
predicate, so voice works for a member the moment member chat lets them message a
session. Member chat itself changes the board-member security model and is raised with
the operator separately; it is not designed here.

## R11. Locked screen

**Finding**: iOS suspends a web page's capture and Web Audio when the screen locks or
Safari leaves the foreground. Developer reports and Apple developer-forum threads agree,
and no web API asks otherwise. Android browser behaviour is inconsistent across reports.
Native apps keep the microphone with the screen locked: iOS with the `audio` background
mode and an active `AVAudioSession` (`playAndRecord`, `voiceChat`); Android with a
foreground service of type `microphone` and a notification.

**Decision**: a native voice client inside the Tauri mobile shell. While voice mode runs
in the app, capture, playback and the voice socket all run **natively**: Swift or Kotlin
audio connected to the Rust `stream` socket, with no JavaScript in the audio path. JS in a
backgrounded WebView may be suspended too, so it cannot be in that loop. Because VAD and
barge-in decisions are on the gateway (R4), the native client is small: capture with
platform echo cancellation, send, play, stop on onset or on the gateway's `stop_playback`,
plus the lock-screen control (iOS Now Playing with a stop command; Android notification
with a Stop action).

In a browser, the web client keeps going while the page runs. It listens for
`visibilitychange` and for track `mute` and `ended`, and on return it reports the
suspension, plays a reply that finished meanwhile, and resumes. A Media Session handler
gives a lock-screen stop control where the browser supports one.

**Build and test**: Android builds on the Linux build machine after installing a JDK,
the Android SDK and NDK, Rust and the Tauri CLI. The emulator runs under Docker with KVM:
the build user is in the `docker` group and cannot open `/dev/kvm` directly. iOS needs a
Mac with Xcode and an Apple developer team. The iOS code is written to the same
interface and compiles only there; its run is pending access to one.

## R12. Recording the demo with sound

**Decision**: drive the web UI with Playwright Chromium (installed on the build machine)
using a fake microphone fed from WAV files
(`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture`). The gateway
writes a debug tap of the voice socket's audio, both directions, with timestamps, enabled
only by a test-only environment variable. A static `ffmpeg` (from the `imageio-ffmpeg`
wheel in a scratch venv; nothing installed system-wide) muxes Playwright's video with
the tapped audio into one MP4. The demo runs on a real Claude session, so the
backgrounding is the real client's behaviour.
