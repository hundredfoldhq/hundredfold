---
description: "Tasks for voice mode for a chat"
---

# Tasks: Voice Mode for a Chat

**Input**: spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md
**Tests**: required (the spec's acceptance asks for tests of the gateway voice pipeline,
the provider interface, and the interruption and background logic). Every branch of the
barge-in policy is tested; every new guard is tested to fail without its line; no
snapshot tests.
**Paths**: `G/` = `packages/hundredfold/src/`, `W/` = `packages/web/src/`, `S/` =
`packages/shell/src-tauri/`, `E/` = `packages/gateway-events/src/`.

Format: `[ID] [P?] [Part] [Story] Description`. Parts A to F are delivery parts. Each of
A to E is a child Todo and a PR into `feat/voice-mode`; F is the principal's integration.
After T001 lands, A to E run in parallel against the committed contracts.

## Phase 1: Setup

- [x] T001 [F] Commit the contract code on `feat/voice-mode`: `E/voice-protocol.ts` (frames per contracts/voice-socket.md, exported from `E/index.ts`), `G/voice/provider.ts` (contracts/providers.md), `G/shared/voice-config.ts` (the `VoiceConfig` type only), `SoftInterruptibleEngine` / `ForegroundWork` / `BackgroundedWork` / `isSoftInterruptibleEngine` in `G/shared/types.ts`, `voice?: VoiceConfig` on `HundredfoldConfig`, and `voice: true` in `CONFIG_TOP_LEVEL_KEY_SET` (`G/shared/config.ts`). Typecheck all packages.

## Phase 2: Foundational

- [ ] T002 [A] `voiceConfigProblems` and `resolveVoiceConfig` in `G/shared/voice-config.ts` per contracts/voice-config.md (every key, range and default; literal `apiKey` refused; `promptFile` confined to the instance home; `local` accepts only English). Wire into the loader at `G/shared/config.ts:53`.
- [ ] T003 [P] [A] Tests `G/shared/__tests__/voice-config.test.ts`: each key's bad shapes and ranges name the key; absent or disabled → `null` and no problems; defaults filled; `promptFile` escaping the home refused; a literal key refused with the move-to-env message.
- [x] T004 [B] `mergeMessageMeta(messageId, patch)` in `G/sessions/registry.ts`: merges into `messages.meta` JSON without dropping other keys, one statement.
- [x] T005 [P] [B] Tests for `mergeMessageMeta`: merges, keeps other keys, creates meta when null, unknown id is a no-op.
- [x] T006 [B] `/api/voice*` row in `G/gateway/department-scope/rules.ts` beside `/api/talk*`; test that a scoped caller is refused.

## Phase 3: US1 spoken round trip (P1)

Speech sidecar and local providers (Part A):

- [ ] T007 [A] [US1] `G/voice/speech_sidecar.py`: stdio framing (contracts/speech-sidecar.md), `hello`, `vad.*` (Silero via `onnx-asr`), `stt.partial` / `stt.final` (Parakeet via `onnx-asr`, `path=` local dir), `tts` (Kokoro via `kokoro-onnx` `from_session`, CUDA provider when the device is GPU), `cancel`, `ping`. Standard library plus the pinned packages only.
- [ ] T008 [P] [A] [US1] Python tests `G/voice/__tests__/test_speech_sidecar.py` (unittest, models stubbed): framing round trip incl. binary bodies and max sizes; unknown op → `error`; `cancel` stops a `tts` mid-stream; replies carry their ids out of order.
- [ ] T009 [A] [US1] `G/voice/sidecar/bootstrap.ts`: Python discovery, venv build (from scratch if broken), pinned `pip install` choosing `onnxruntime-gpu[cuda,cudnn]==1.32.0` when the device resolves to GPU, model download with `snapshot_download(local_dir=…)` (fp32 Parakeet for GPU, int8 for CPU, Kokoro v1.0, Silero), progress as `install` state plus a `voice:install` event.
- [ ] T010 [A] [US1] `G/voice/sidecar/client.ts` + `framing.ts`: spawn on first need, multiplexed requests, 15 s ping, respawn at most once per 30 s, warm for 10 min after the last attachment, killed on shutdown.
- [ ] T011 [P] [A] [US1] Tests with a fake sidecar script on stdio: framing; ping loss marks unavailable and fails in-flight work; respawn throttle; idle reap; shutdown kill.
- [ ] T012 [A] [US1] `G/voice/providers/local.ts`: `SttProvider` (partials every 400 ms while speech continues, skip when the previous decode is busy; final on `end()`), `TtsProvider` (24 kHz chunks), `VadStream`.
- [ ] T013 [A] [US1] `G/voice/providers/registry.ts`: `createSttProvider`, `createTtsProvider`, `createVad` from the resolved config.
- [ ] T014 [A] [US1] `G/gateway/voice-api.ts`: `GET /api/voice/config` and `POST /api/voice/install` per contracts/voice-config.md; wired in `G/gateway/api.ts` beside the talk router.
- [ ] T015 [P] [A] [US1] Tests: `GET` disabled → `{enabled:false}`; enabled shape; install states; members get the same shape; `POST /install` operator-only and idempotent.

Gateway hub (Part B):

- [x] T016 [B] [US1] `G/voice/upgrade.ts` + a `/ws/voice/:id` branch in `server.on("upgrade")` (`G/gateway/server.ts:1105`) mirroring `/ws/pty` (`:1137`): operator gate, origin check, reach guard, session/terminal checks, `voiceWss` in `startWsHeartbeat` (`:1071`). Disabled voice → no branch taken (socket destroyed). Only a few lines in server.ts.
- [x] T017 [B] [US1] `G/voice/hub.ts`: attachment lifecycle and limits per data-model.md (`hello` → `ready`, take-over by the same principal, `4409` for another, `4429` at the cap, cleanup on close, session delete or stop, config disable, shutdown).
- [x] T018 [B] [US1] Utterances in the hub: continuous upstream into `VadStream`; on VAD start open an `SttStream` with pre-roll; partials and the final as `transcript`; `maxUtteranceSeconds` → cut plus `utterance_too_long`; push-to-talk path uses `ptt_down`/`ptt_up` and skips VAD endpointing; `metrics.sttMs`.
- [x] T019 [B] [US1] Dispatch: a final with words goes through `dispatchWebSessionRun` (`G/gateway/web-session-dispatch.ts:149`), sharing the body of `POST /api/sessions/:id/message` (`G/gateway/api.ts:3875`) rather than calling it over HTTP, with `meta.voice` and the envelope.
- [x] T020 [B] [US1] `G/voice/envelope.ts`: full prompt on the first voice turn after attach, compaction or engine switch; one-line reminder after; nothing on a `/`-led prompt; the interrupted line (US2). Strip in `transcriptEntryText` (`G/gateway/external-turns.ts:110`); carried through every prompt-recompose site that `withLeftBackgroundNote` (`G/sessions/left-background-tasks.ts:143`) goes through.
- [x] T021 [B] [US1] `G/voice/emit-tee.ts` wrapping `emit` at `G/gateway/server.ts:834`, installed only when voice is enabled; feeds an attached session's assistant `text` / `text_snapshot` deltas (snapshots never re-spoken), `tool_use` (→ `turn working`) and `session:completed` (→ `idle`) into the hub.
- [x] T022 [B] [US1] `G/voice/speech-pipeline.ts`: sentence chunking (`splitTtsSentences`), `toSpeakable`, TTS, resample to 24 kHz, binary frames with the header, `segment_start` / `segment_end`; synthesis of N+1 overlaps sending N; `ttfaMs` from the final to the first audio byte, stored via `mergeMessageMeta`; `spokenText` at the reply's end.
- [x] T023 [P] [B] [US1] Tests with real `ws` clients against the route: disabled → refused; operator accepted; cross-origin 403; scoped out of reach 403; terminal/missing 404; `4409`; `4429`; take-over sends `detached{taken_over}`.
- [x] T024 [P] [B] [US1] Hub tests with fakes (provider, VAD, engine, clock): round trip; partials; one message per final; no message for an empty final; utterance limit; envelope first/reminder/none for `/`; strip test proves transcript sync writes no duplicate user row; snapshot deltas not re-spoken; TTFA recorded; the tee is not installed when voice is disabled.
- [x] T025 [B] [US1] (the `GET /api/voice/config` leg lands with Part A) Key-leak test: a sentinel key via env, drive a full attachment and `GET /api/voice/config` and `GET /api/config`, and assert no frame, body, error or close reason contains it (SC-007).

Web (Part D):

- [x] T026 [P] [D] [US1] `W/lib/voice/socket.ts`: opens `/ws/voice/:id` through `gateway-transport.ts` `openSocket`, typed frames from `E/voice-protocol.ts`, reconnect only on a user gesture.
- [x] T027 [P] [D] [US1] `W/lib/voice/capture-worklet.ts`: AudioWorklet capture with echo cancellation, noise suppression and auto gain, resampled to 16 kHz PCM16 in 20 ms frames.
- [x] T028 [P] [D] [US1] `W/lib/voice/player.ts`: one AudioContext, a segment queue that can be flushed within a frame, `played` reports, a playback position for `barge_in.playedMs`.
- [x] T029 [D] [US1] `W/components/chat/voice-control.tsx` in the composer (`W/components/chat/chat-input.tsx:184`, beside the mic) and the mobile composer: one tap starts capture and playback; states listening, hearing (live partial), thinking, working (tool), speaking, unavailable (reason from `GET /api/voice/config`), installing (progress); hidden when voice is disabled.
- [x] T030 [D] [US1] Chat rendering: mic mark on messages with `meta.voice.utteranceId`; TTFA readout on the reply.
- [x] T031 [P] [D] [US1] Web tests: control hidden when disabled; state transitions from scripted frames; player flush; worklet resampling maths; mic mark; reconnect needs a gesture.

## Phase 4: US2 barge-in (P1)

- [x] T032 [P] [D] [US2] `W/lib/voice/onset.ts`: RMS onset held for `onset.minSpeechMs` over playback → flush player, send `barge_in`; also flush on `stop_playback`. Tests with synthetic frames (onset, sub-threshold noise, echo-level playback does not fire).
- [x] T033 [B] [US2] Hub barge-in: on `barge_in` or VAD start during playback, abort synthesis and drop queued segments, record heard text; on the final, empty → resume from the first unheard sentence, words → `mergeMessageMeta` `{spokenText, interrupted: true}`, interrupted line in the envelope, then deliver per the policy (T034).
- [x] T034 [B] [US2] `G/voice/barge-in-policy.ts`: the pure decision table in contracts/providers.md, the clock injected; the hub executes `soft_then_turn`, `steer`, `steer_with_holding`, `queue_with_holding`, `interrupt_now` (existing `delivery: "now"` via `G/gateway/message-interrupt.ts`) and `wait_then_decide`.
- [x] T035 [P] [B] [US2] Tests: every row of the policy table; `wait_then_decide` with a young call finishing in time and one that does not; empty final resumes from the right segment; no audio for the interrupted reply after `barge_in`; a spy proves `kill` is never called while long work runs, on every branch.
- [x] T036 [D] [US2] Unheard tail: dim and label "not spoken" the part of an interrupted reply after `meta.voice.spokenText`. Test.

## Phase 5: US3 long work (P2)

- [x] T037 [C] [US3] **Verify first**, on the real Claude Code CLI in a PTY (the shape of the existing live steer tests): Esc during a foreground `sleep 60` Bash, then confirm the command keeps running as a background task, the process stays, and a task notification wakes the session when it ends. Record the transcript evidence in the PR. If Esc kills the command, implement `softInterrupt` as steer (paste) and record that.
- [x] T038 [C] [US3] `InteractiveClaudeEngine` (`G/engines/claude-interactive.ts:1704`) implements `SoftInterruptibleEngine`: `foregroundWork` from the hook stream (PreToolUse without PostToolUse, with start time); `softInterrupt` writes Esc (or steers, per T037), waits for the TUI to settle without releasing the PTY, settles the running turn as softly interrupted, and returns the background task ids the hook stream reports.
- [x] T039 [P] [C] [US3] Tests: unit tests with the fake PTY for `foregroundWork` and the soft-interrupt settle (no `releaseSession`, no kill, the turn settles once); a live test gated like the existing steer live tests, proving a `sleep` survives the soft interrupt and its notification arrives.
- [x] T040 [C] [US3] OpenCode 2.x engine: `foregroundWork` from its event stream (running tool step and its start), so the hub can pick `steer_with_holding`. Tests with the fake opencode-v2 server's TOOL/SLOW directives.
- [x] T041 [B] [US3] Hub: `background` frames from the soft interrupt's result and from the background-tasks source while attached; the holding line spoken as a segment without a model turn; `ready.backgrounding` from capabilities. Tests.
- [x] T042 [D] [US3] Web chip for backgrounded work (running / finished) from `background` frames and the session's existing background activity. Test.

## Phase 6: US4 configuration and other providers (P2)

- [ ] T043 [P] [A] [US4] `G/voice/providers/openai.ts`: STT over the Realtime transcription session WebSocket (partials), TTS `POST /v1/audio/speech` `pcm` streamed; key from `resolveEnvVar`; the PR cites the API doc and date used.
- [ ] T044 [P] [A] [US4] `G/voice/providers/openai-compatible.ts`: batch `transcriptions` (multipart WAV), `speech` asking `pcm` then `wav` (unwrapped), MP3-only refused, optional key.
- [ ] T045 [P] [A] [US4] Provider tests against local fake HTTP/WS servers: partials and final, abort mid-stream, error status, MP3 refusal, WAV unwrap, VAD fallback when the local sidecar is absent.
- [ ] T046 [A] [US4] `docs/voice.md`: what it is; **pre-installation steps** (Python 3.10+ with venv and pip, disk, NVIDIA driver for GPU); first-run install; the full `voice:` reference with defaults; each provider's setup (local, OpenAI via `${OPENAI_API_KEY}`, a self-hosted example); voices and how to pick one; model licences; per-engine long-work table (FR-018); per-platform locked-screen table (FR-034); cost notes; off by default. `docs/docker.md` voice line updated.

## Phase 7: US5 phone and locked screen (P2)

- [x] T047 [D] [US5] `W/lib/voice/suspend.ts`: detect suspension (`visibilitychange`, track `mute`/`ended`, socket close while hidden); on return send `resume`, show "voice mode was suspended by the device", play what `missed` announces, ask for a tap only if the AudioContext needs a gesture. Media Session handler with a stop action. Tests with a fake document and tracks.
- [x] T048 [B] [US5] Hub: keep an attachment's replies during a client suspension (socket closed with a `resume` window of 10 minutes keyed by principal and session); on `resume` send `missed` and speak the finished replies. Tests.
- [ ] T049 [E] [US5] Install the Android toolchain on the build machine in the work area (JDK 17, Android SDK and NDK, Rust stable, `cargo-tauri`, Android targets) and the Docker emulator image; record the exact steps in `packages/shell/README.md`.
- [ ] T050 [E] [US5] `S/src/voice.rs`: the native voice session per contracts/native-voice.md (commands, confinement, socket through the `stream` machinery, PCM bridge to the platform audio, frames forwarded to the web channel). Rust unit tests for the frame bridge and confinement.
- [ ] T051 [E] [US5] Android: Kotlin foreground service (type `microphone`), `AudioRecord` `VOICE_COMMUNICATION` + `AcousticEchoCanceler`, flushable `AudioTrack`, onset detector, notification with Stop; manifest permissions in `S/gen/android`. Build an APK.
- [ ] T052 [E] [US5] iOS: Swift `AVAudioSession` `.playAndRecord`/`.voiceChat`, `AVAudioEngine` capture and flushable playback, onset detector, Now Playing stop command, interruption handling; `UIBackgroundModes: audio` and `NSMicrophoneUsageDescription` in `S/gen/apple`. Written to the contract; built and run only on a Mac (pending access).
- [x] T053 [D] [US5] Web: when running in the shell, `voice-control.tsx` uses `voice_start`/`voice_stop`/`voice_ptt` and renders from forwarded frames; the browser path otherwise.
- [ ] T054 [E] [US5] Android emulator run under Docker per quickstart §8: lock, wait, spoken exchange with a barge-in while locked, Stop from the notification. Screen recording attached to the child PR.
- [x] T055 [B] [US5] Member path: `memberMayUpgrade` (`G/accounts/member-router.ts:21`) admits `/ws/voice/:id` when the "may send messages to this session" predicate holds (false for members today); voice member sockets join `startMemberSocketSweep` (`G/accounts/member-upgrade.ts:63`) and close `4401` on access loss. Update the "exactly `/ws`" doc comments and `docs/design/board-members.md`. Tests: member refused today; with the predicate stubbed true, accepted and closed on grant removal within one sweep.

## Phase 8: Integration and polish (Part F)

- [ ] T056 [F] Merge A to E into `feat/voice-mode` in dependency order; resolve; full suite with a clean environment (`env -i`, built `dist/`), typecheck, lint, `check-footguns --diff origin/main`, web build and perf budget.
- [ ] T057 [F] Functional run on an ephemeral gateway per quickstart §1 to §7, including the local sidecar's real first-run install on the build machine. Record TTFA (gateway and end-to-end medians over ten questions) in the PR.
- [ ] T058 [F] Recorded demo with sound (quickstart §9): spoken round trip, barge-in, backgrounded long command whose result is spoken later; attach to the PR.
- [ ] T059 [F] CHANGELOG entry; README feature line; privacy scan of the diff, commits and PR body; top-tier QA review (spec conformance across contracts/), fix, ready.

## Dependencies

- T001 blocks everything.
- Part A (T002, T003, T007 to T015, T043 to T046), Part B (T004 to T006, T016 to T025, T033 to T035, T041, T048, T055), Part C (T037 to T040), Part D (T026 to T032, T036, T042, T047, T053) and Part E (T049 to T052, T054) run in parallel. Each builds against the contracts with fakes.
- T034 consumes C's capability through the contract; T053 consumes E's commands through the contract.
- F (T056 to T059) after A to E are accepted.

## Parallel examples

- A: T007 (sidecar) ∥ T009/T010 (bootstrap, client) ∥ T043/T044 (hosted providers).
- B: T016/T017 (route, lifecycle) ∥ T020 (envelope) ∥ T034 (policy).
- D: T026 ∥ T027 ∥ T028 ∥ T032.

## Implementation strategy

MVP is US1 plus US2 on the local providers in a desktop browser (Parts A, B and D, plus
C's verification), which is what the demo's first two acts need. US3 completes with
Part C. US5's browser path is in Part D; the native locked-screen client is Part E, with
iOS gated on a Mac.
