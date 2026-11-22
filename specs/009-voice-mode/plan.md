# Implementation Plan: Voice Mode for a Chat

**Branch**: `feat/voice-mode` | **Date**: 2026-11-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/009-voice-mode/spec.md` (approved with
changes at the spec review gate, 2026-11-22).

## Summary

A spoken conversation with a chat session. The client streams microphone PCM over a new
per-session socket, `/ws/voice/:sessionId`. The gateway runs VAD and speech-to-text,
sends each final transcript to the session as an ordinary message, and turns the
session's streamed reply into speech sentence by sentence back down the same socket.
The built-in local speech runs in one gateway-managed Python sidecar: Parakeet TDT 0.6B
v2 for STT, Kokoro-82M for TTS, Silero for VAD, on the GPU when present. OpenAI and
OpenAI-compatible providers sit behind the same interface. Barge-in stops playback on
the client at once; the gateway then decides, from the engine's capabilities, how the
new utterance reaches a running turn, and never kills long work. On Claude, long work
moves to the background through a new soft interrupt. The locked-phone case runs
through a native voice client in the Tauri mobile shell.

## What already exists (Principle VII)

Lines verified against `origin/main` at `8ec17785a`. `G/` = `packages/hundredfold/src/`,
`W/` = `packages/web/src/`, `S/` = `packages/shell/src-tauri/`, `E/` =
`packages/gateway-events/src/`.

| `path:line` | What it is | Used / rejected |
|---|---|---|
| `G/gateway/server.ts:1105` | `server.on("upgrade")`: the one upgrade router | **extended** with a `/ws/voice/:id` branch |
| `G/gateway/server.ts:1137` | `/ws/pty/:id` branch: gate, origin check, per-session socket | **pattern followed** |
| `G/gateway/server.ts:1146` | `rejectPtyUpgrade(req, socket, {operatorAuthenticated})` | reused for the operator gate |
| `G/gateway/server.ts:1058`, `:1062`, `:1065` | `wss`, `ptyWss`, `memberWss` (`noServer`) | a `voiceWss` beside them |
| `G/gateway/server.ts:1071` | `startWsHeartbeat([...])` | `voiceWss` added |
| `G/gateway/server.ts:834` | `const emit = createTalkProactiveGatewayEmit(initDb(), broadcast)`: emit is a decorator chain | **wrapped** by the voice tee |
| `G/gateway/talk-proactive-events.ts:79` | `createTalkProactiveGatewayEmit(db, broadcast)` | the decorator precedent |
| `G/gateway/upgrade-guards.ts:105`, `:122` | `rejectCrossOriginUpgrade`, `rejectPtyUpgrade` | reused |
| `G/gateway/session-reach-guard.ts:10` | `sessionIsWithinReach(session, callerId)` | reused for scoped callers |
| `G/accounts/member-router.ts:21` | `memberMayUpgrade(url)`: exactly `/ws` | **extended**: `/ws/voice/:id` when the message predicate allows |
| `G/accounts/member-upgrade.ts:49`, `:63` | `routeMemberUpgrade`; `startMemberSocketSweep` (30 s re-check) | voice member sockets join the sweep |
| `docs/design/board-members.md` (Roles) | chat and "anything that wakes an agent" are operator-only | see R10: voice uses one predicate, members false until member chat exists |
| `G/gateway/api.ts:3875` | `POST /api/sessions/:id/message` | the path a voice final must match; its body is factored, not called over HTTP |
| `G/gateway/web-session-dispatch.ts:149` | `dispatchWebSessionRun` | voice dispatch goes through it |
| `G/gateway/message-interrupt.ts` (`resolveMessageDelivery`, `shouldInterruptRunningTurn`) | `delivery: "queue" \| "now"` | reused for the "now" and "queue" branches |
| `G/shared/types.ts:170`, `:184` | `SteerableEngine`, `isSteerableEngine` | reused for the steer branch |
| `G/engines/claude-interactive.ts:1704` | `InteractiveClaudeEngine implements InterruptibleEngine, SteerableEngine, ...` | **gains** `SoftInterruptibleEngine` |
| `G/engines/claude-interactive.ts:3602` | `kill()`: releases the PTY (ends its background shells) | **never** called by voice during long work |
| `G/engines/claude-interactive.ts:3664`, `:3702` | `canSteer`, `steer` (paste into the busy TUI) | the fallback if Esc does not background (R8) |
| `G/engines/background-tasks.ts` | tracks Claude's background tasks from hooks | source of `background` frames and of `foregroundWork` |
| `G/sessions/left-background-tasks.ts:143` | `withLeftBackgroundNote`: the prompt-envelope precedent | voice envelope follows it |
| `G/gateway/external-turns.ts:110` | `transcriptEntryText`: strips gateway text from synced rows | **extended** to strip the voice envelope |
| `G/sessions/registry.ts:2356` | `insertMessage(..., meta)`: messages carry a JSON `meta` | voice meta written here |
| (none) | no helper updates a stored message's `meta` | **new** `mergeMessageMeta` for `spokenText` / `interrupted` / `ttfaMs` |
| `G/talk/speakable.ts:22` | `toSpeakable`: strips markdown, code, URLs, ids | reused |
| `G/talk/tts-stream.ts:74` | `splitTtsSentences` | reused for sentence chunking |
| `G/talk/kokoro.ts:33`, `:408` | Kokoro downloads, `ensureVenv` (venv + pip bootstrap) | **pattern followed** by the speech sidecar's bootstrap; read-aloud left alone |
| `G/talk/kokoro_sidecar.py:114` | Kokoro HTTP sidecar | rejected for voice (R6: stdio framing) |
| `G/stt/stt.ts:212` | whisper-cli `transcribe` for dictation | rejected for voice (Parakeet chosen); dictation untouched |
| `G/shared/voice.ts` | Talk's realtime types and `SttConfig` / `TalkConfig` | untouched; voice config is a new sibling |
| `G/shared/config.ts:53` | config loader collects `*Problems` validators | `voiceConfigProblems` added |
| `G/shared/config.ts:322` | `CONFIG_TOP_LEVEL_KEY_SET` (compile-time aligned) | `voice: true` added |
| `G/shared/context-config.ts` | type + validator module pattern | followed by `shared/voice-config.ts` |
| `G/shared/env-ref.ts` | `resolveEnvVar` for `${VAR}` keys | reused for provider keys |
| `G/gateway/config-payload.ts:40` | `sanitizeConfigForApi`: masks secret-looking keys | covers `voice.*.apiKey` in `GET /api/config` |
| `G/gateway/department-scope/rules.ts:135` | `/api/talk*`, `/api/tts`, `/api/stt*` refused to scoped callers | `/api/voice*` added the same way |
| `E/index.ts` | gateway event protocol package shared by web and gateway | **new** `voice-protocol.ts` exported from it |
| `W/lib/gateway-transport.ts:72` | `openSocket(path)` (browser or shell environment) | voice socket opened through it |
| `W/components/chat/chat-input.tsx:184`, `:632` | composer; mic gestures for dictation | voice control added beside the mic |
| `W/components/chat/audio-player.ts:37` | `TalkAudioPlayer` (read-aloud playback) | rejected for voice: needs a flushable PCM queue |
| `S/src/stream.rs:89`, `:203` | `stream` command: Rust WebSocket, text and binary both ways | **reused** by the native mobile voice client |
| `S/gen/apple`, `S/gen/android` | generated iOS and Android projects (no mic permission, no background mode yet) | **extended** (R11) |
| `G/mcp/__tests__/tool-manifest-budget.test.ts` | MCP manifest budget | untouched: no MCP tool changes |

## Technical Context

**Language/Version**: TypeScript (Node 24.13 pinned by `.npmrc`) for the gateway and
web. Python 3.10+ for the speech sidecar. Rust (Tauri 2), Swift and Kotlin for the
native mobile client.

**Primary Dependencies**: existing `ws`, React. Sidecar (pinned, installed by the gateway
into its own venv): `onnx-asr==0.12.0`, `kokoro-onnx==0.6.1`, `onnxruntime==1.32.0` or
`onnxruntime-gpu[cuda,cudnn]==1.32.0`, `huggingface_hub`, `numpy`. Models: Parakeet TDT
0.6B v2 ONNX, Kokoro v1.0 ONNX and voices, Silero VAD. No new npm dependency in the
published package.

**Storage**: none new. Voice facts live in the existing `messages.meta` JSON.
Attachments, utterances and segments are in memory and die with the socket.

**Testing**: vitest (gateway and web) with fake providers, a fake sidecar on stdio, fake
engines, and real `ws` clients against the upgrade route. Python unittest for the
sidecar's framing and dispatch, with models stubbed. Playwright with a fake microphone
for the end-to-end run and the demo. The native clients get Rust unit tests for the
frame bridge; Android is run on an emulator under Docker.

**Target Platform**: gateway on Linux, macOS and Windows (local providers: Linux and
macOS with Python; GPU path NVIDIA on Linux). Browsers per the spec. Mobile app: iOS
16+, Android 10+.

**Project Type**: web service plus web app plus mobile shell (monorepo packages).

**Performance Goals**: SC-001 (median under 1.5 s excluding model time, GPU host),
SC-002 (first partial under 1 s), SC-003 (playback stops within 500 ms).

**Constraints**: provider keys never leave the gateway (FR-024). Voice never kills long
work (FR-014). Nothing changes when voice is off (FR-021). ESLint `max-params` 5 and
`complexity` 10. The privacy guard test scans shipped trees.

**Scale/Scope**: a handful of concurrent attachments per gateway
(`limits.maxConcurrentAttachments`, default 4). One sidecar process serves them all.

## Constitution Check

*Evaluated before Phase 0 and again after Phase 1. Result: pass, with the notes below.*

| Principle | Check | Result |
|---|---|---|
| I. Fork-local | The design reasons about this fork only | pass |
| II. Direction | Mostly rung 4 (a better surface for people). Rung 3 in one place: when someone speaks during long work, the system decides to move the work to the background and to bring its result back into the conversation, closing a loop the operator closes by hand today. It stops there because voice is a way for a person to direct the company; it is not a source of autonomous work. **Bounded spend**: off by default; local providers are free; hosted ones are opt-in and bounded by utterance length and attachment count (FR-027). **Legible**: every voice turn is an ordinary stored message, with voice facts on its meta. | pass |
| III. Verify the premise | The premises were checked on the tree and on live clients: the Claude `kill` path (`claude-interactive.ts:3602`), no member chat (`member-router.ts:21`), Parakeet and Kokoro latency measured, and the Claude Code background strings read from the installed binary. The Esc-backgrounding premise is the first implementation task, with a fallback named (R8). | pass |
| IV. Footprint Ladder | No MCP tool changes. Rung 1 throughout: the upgrade router, emit chain, message dispatch, steer, `messages.meta` and the Tauri stream are extended. | pass |
| V. No speculative infrastructure | `SttProvider` / `TtsProvider` have three named consumers each (local, openai, openai-compatible), required by FR-023. `SoftInterruptibleEngine` has one implementer (claude) and one consumer (the voice hub), and is a capability check like `SteerableEngine`, not a strategy layer. Each config key maps to an FR-022 item. No GPU TTS alternatives are added. | pass |
| VI. Tests that can fail | Branching logic gets tests: the barge-in policy table, the long-work rule with an injected clock, take-over, limits, envelope stripping, key-leak scan, framing. No snapshots. | pass |
| VII. `file:line` table | Above, verified at `8ec17785a` | pass |
| VIII. Comments stay true | `member-router.ts` and `member-upgrade.ts` docs say "exactly `/ws`", and `board-members.md` says chat is operator-only; each is updated where this change makes it false | pass, tracked as tasks |
| Hard constraints | No real names, paths or keys in shipped trees; demo assets and voice samples stay out of `packages/**` | pass |

## Project Structure

### Documentation (this feature)

```text
specs/009-voice-mode/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── voice-socket.md      # /ws/voice/:sessionId protocol
│   ├── voice-config.md      # the voice: config block and GET /api/voice/config
│   ├── speech-sidecar.md    # gateway ↔ sidecar stdio protocol
│   ├── providers.md         # SttProvider / TtsProvider and SoftInterruptibleEngine
│   └── native-voice.md      # web ↔ native mobile voice client commands
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code

```text
packages/gateway-events/src/
└── voice-protocol.ts                 # wire types, shared by gateway, web and shell

packages/hundredfold/src/
├── shared/voice-config.ts            # VoiceConfig type, validator, defaults resolver
├── shared/types.ts                   # + SoftInterruptibleEngine
├── voice/
│   ├── provider.ts                   # SttProvider / TtsProvider interfaces
│   ├── providers/{local,openai,openai-compatible,registry}.ts
│   ├── sidecar/{client.ts,bootstrap.ts,framing.ts}
│   ├── speech_sidecar.py             # VAD + Parakeet + Kokoro over stdio
│   ├── hub.ts                        # attachments, utterances, dispatch, playback, barge-in
│   ├── barge-in-policy.ts            # the delivery decision table
│   ├── speech-pipeline.ts            # deltas → sentences → speakable → TTS → frames
│   ├── envelope.ts                   # voice prompt envelope + strip
│   ├── emit-tee.ts                   # wraps the gateway emit
│   └── upgrade.ts                    # /ws/voice upgrade handling (operator + member)
├── gateway/voice-api.ts              # GET /api/voice/config
├── engines/claude-interactive.ts     # + softInterrupt, foregroundWork
├── engines/opencode-*                # foregroundWork for the steer branch's holding-line rule
└── sessions/registry.ts              # + mergeMessageMeta

packages/web/src/
├── lib/voice/{socket.ts,capture-worklet.ts,player.ts,onset.ts,suspend.ts}
├── components/chat/voice-control.tsx # composer button and state
└── components/chat/*                 # spoken mark, unheard tail, background chip

packages/shell/src-tauri/
├── src/voice.rs                      # native voice session: audio ↔ stream bridge
├── gen/apple/...                     # Swift audio (AVAudioEngine, voiceChat), Info.plist modes
└── gen/android/...                   # Kotlin foreground service, AudioRecord/AudioTrack, manifest

docs/voice.md                          # user docs, pre-installation steps, per-platform lock-screen table
```

**Structure Decision**: the voice runtime lives in a new `packages/hundredfold/src/voice/`
directory beside `talk/` and `stt/`, with the wire types in the shared events package so
the web and shell compile against the same frames. Talk, read-aloud and dictation are
untouched.

## Phase 0 and Phase 1 outputs

- [research.md](research.md): R1 to R12, all unknowns resolved; the Claude Esc behaviour
  is a verification task with a named fallback.
- [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md).

Post-design Constitution Check: unchanged, pass.

## Open decision for the operator (does not block the build)

Board members cannot chat with sessions today (R10). Voice ships member-ready: one
predicate, members false until member chat exists. Member chat is a change to the
board-member security model and needs the operator's decision on which sessions and which
roles. It is raised on the Todo, not designed here.

## Complexity Tracking

None.
