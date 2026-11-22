# Quickstart: validating voice mode

Run guide for proving the feature end to end. Contracts:
[voice-socket](contracts/voice-socket.md), [voice-config](contracts/voice-config.md),
[speech-sidecar](contracts/speech-sidecar.md), [providers](contracts/providers.md),
[native-voice](contracts/native-voice.md).

## Prerequisites (also the user-facing pre-installation steps in `docs/voice.md`)

- Python 3.10+ with `venv` and `pip` on the gateway's machine.
- Disk: about 1 GB (CPU models) or 6 GB (GPU models) under the instance home.
- Optional, for the GPU path: an NVIDIA GPU with a driver that supports CUDA 12.
- For the demo only: Playwright Chromium (already on the build machine) and a static
  `ffmpeg` from the `imageio-ffmpeg` wheel in a scratch venv.
- For the mobile app: Android toolchain (JDK 17, Android SDK and NDK, Rust, Tauri CLI);
  the emulator under Docker with `/dev/kvm`. iOS needs a Mac with Xcode.

## 1. Off means off (SC-006)

1. Start an ephemeral gateway with its own home and port and no `voice` block.
2. `GET /api/voice/config` → `{"enabled": false}`.
3. Open a WebSocket to `/ws/voice/<sessionId>` → refused (socket destroyed).
4. Load a chat in the browser → no voice control. Compare against the same chat on the
   base commit (pixel diff of the composer).

## 2. First run of the local providers (FR-023, R7)

1. Add `voice: { enabled: true }`, reload.
2. `GET /api/voice/config` → `install.state` `not_installed`. `POST /api/voice/install`.
3. Poll until `install.state` is `ready`. Expect `stt.provider: local`,
   `tts.voice: af_heart` (or the operator's pick), `available: true`, and a device of
   `gpu` on the build machine.

## 3. Spoken round trip (US1, SC-001, SC-002)

1. In Playwright Chromium with `--use-fake-device-for-media-stream
   --use-file-for-fake-audio-capture=<question.wav>`, open a chat on a mock-engine
   session, then a real Claude session; press the voice control.
2. Expect: a partial transcript within 1 s of speech start; the final lands as a user
   message with a mic mark; the reply text renders and its first sentence is heard
   before the reply finishes; a `metrics` frame with `ttfaMs`.
3. Ten questions: record median `ttfaMs` (gateway, excluding model time, from the debug
   tap's timestamps) and the end-to-end figure.

## 4. Barge-in (US2, SC-003, SC-004)

1. Ask for a reply of several sentences; at sentence two, feed a second WAV (speech).
   Expect playback stopped within 500 ms of speech onset (client log); the utterance
   becomes the next message; the interrupted reply shows the unheard tail; the session
   is told what was heard.
2. Repeat with a WAV of a cough or noise. Expect playback resumes from the first unheard
   sentence and no message is sent. Ten times each.

## 5. Long work (US3, SC-005)

1. On a real Claude session: "Run `node -e \"setTimeout(()=>console.log('done-marker'),90000)\"` in the foreground."
   (The CLI refuses a foreground `sleep N && …`.) Wait 10 s (past the
   5 s threshold), then ask "What's two plus two?"
2. Expect: the answer arrives while the command is still running; a `background` frame
   and chip; about 90 s later the session reports `done-marker` and it is spoken.
3. Repeat on an OpenCode 2.x session: expect the holding line at once and the answer
   after the command.
4. Assert from the gateway log that no `kill` was issued for the session during the run.

## 6. Keys never reach the browser (SC-007)

Configure `openai` with `apiKey: ${VOICE_TEST_KEY}` set to a sentinel. Run the suite's
key-leak test, and grep the browser's recorded frames and responses for the sentinel:
expect zero hits.

## 7. Board members (SC-011)

With accounts on: a member's upgrade to `/ws/voice/<id>` is refused (403) while members
cannot message sessions. `GET /api/voice/config` as a member is refused (403, "Not available to
board members"). Once member chat lets a member message a session, the same
upgrade is accepted; removing their grant closes it with `4401` within one sweep.

## 8. Locked screen (US5, SC-010)

- Android app on the emulator: start voice mode, lock (`adb shell input keyevent 26`),
  wait 60 s, play a question into the emulator's virtual mic; expect the reply audible
  and a barge-in honoured while locked; the notification shows Stop.
- Mobile browser: lock mid-reply, unlock: expect the suspension notice, the missed reply
  spoken, and listening resumed.
- iOS app: same as Android, on a Mac with Xcode and an iPhone; pending access.

## 9. Demo recording (SC-008)

Run 3 to 5 on a real Claude session with the debug audio tap on; mux Playwright's video
and the tap's audio with ffmpeg into one MP4; attach it to the PR.
