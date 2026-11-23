# Contract: native voice client (Tauri mobile shell)

Used only when the web app runs inside the Hundredfold mobile app. In a browser the web
client handles audio itself.

## Commands (web → Rust), confined to the local `main` window like the other four

| Command | Input | Result |
|---|---|---|
| `voice_start` | `{ target, sessionId, mode }` | `{ ok }`, or an error code: `permission-denied`, `not-paired`, `unsupported`, `voice-busy`, `invalid-path`, `invalid-request`, `transport-failed` |
| `voice_stop` | — | `{ ok }` |
| `voice_ptt` | `{ down: boolean }` | `{ ok }` |
| `voice_status` | — | `{ running, state }` |

`voice_start` opens `/ws/voice/:sessionId` through the existing `stream` machinery (same
pairing credential, same origin rules), sends `hello {client: "native"}`, and starts
native capture and playback. From then on audio never passes through JavaScript.

## Events (Rust → web), on a Tauri channel

The gateway's JSON frames are forwarded as-is (`ready`, `transcript`, `turn`,
`segment_start`, `metrics`, `background`, `error`, `detached`...), so the web UI renders
voice the same way in both modes. Binary audio is not forwarded.

One extra, shell-only object on the same channel reports the native session's own state,
so the web learns when voice was stopped from the lock screen or notification, or paused
by a system interruption:

```json
{ "type": "native_state", "state": "connecting" | "running" | "paused" | "stopped", "reason": "user" | "notification" | "interruption" | "error" | "socket_closed", "code": 4409 }
```

`reason` is optional. `code` is present only with `reason: "socket_closed"` and carries the
WebSocket close code, so the web can say why: `4409` voice in use by someone else, `4429`
attachment limit, `4401` access lost, `4404` session gone (see voice-socket.md). Error codes
follow the shell's existing kebab-case convention for native errors. A gateway never emits `native_state`, so it lives in the web's
shell types, not in `voice-protocol.ts`.

## Credentials on Android

The shell's keyring backend is Apple-only, and Android has no OS-backed credential store
in the shell today. For non-Apple targets the shell keeps the pairing credential in a
process-lifetime, in-memory store. It is never written to disk, the user pairs again
after the app restarts, and the README says plainly that this is not secure storage.
Persistent Android Keystore storage is a separate security change and not part of this
feature.

## Native audio (per platform)

| | iOS (Swift) | Android (Kotlin) |
|---|---|---|
| Session | `AVAudioSession` `.playAndRecord`, mode `.voiceChat` (echo cancellation), `UIBackgroundModes: audio` | foreground service, type `microphone`, ongoing notification |
| Capture | `AVAudioEngine` input → 16 kHz PCM16 | `AudioRecord`, source `VOICE_COMMUNICATION`, `AcousticEchoCanceler` |
| Playback | `AVAudioPlayerNode` queue, flushable | `AudioTrack` streaming, flushable |
| Sound cue | `AVAudioPlayerNode` of its own, looped; never in the speech queue | `AudioTrack` of its own (static, looped) on the capture's audio session; never in the speech queue |
| Onset detector | RMS over 20 ms frames, `minSpeechMs` hold (same parameters as `ready.onset`) | same |
| Lock-screen control | Now Playing info ("Voice mode on"), remote `pause`/`stop` → `voice_stop` | notification action "Stop" → `voice_stop` |
| Permissions | `NSMicrophoneUsageDescription` | `RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS` |

A transient interruption (a phone call, Siri, a short focus loss) pauses capture and
playback, reported as `native_state {state: "paused", reason: "interruption"}`, and resumes
when the system ends it. If the system ends it without allowing a resume (iOS without
`.shouldResume`, or a failed reactivation), or another app takes audio focus permanently
(Android `AUDIOFOCUS_LOSS`), the session ends cleanly (`bye`, close 1000) and reports
`native_state {state: "stopped", reason: "interruption"}`, not `error`. A route change
(headphones, Bluetooth) keeps the session going; when it changes the input format, the
client rebuilds its capture path for the new format.

While voice runs, the session outlives the UI: on Android, BACK at the app root moves the
task to the background instead of finishing the activity. Removing the task from recents
ends the session cleanly (`bye`, close 1000).

## Sound cues

Rust decides (`voice-core/src/cues.rs`, `session.rs`) from the forwarded gateway frames (see voice-socket.md,
"Sound cues") and hands the platform one PCM16LE mono 24 kHz loop at a time (`SetCue`); an empty loop stops it.
The platform loops it on a channel of its own. The speech ledger, the onset detector and the `played` reports
never see a cue, so a cue cannot be taken for speech playing or for a barge-in. A pause for an interruption stops
the cue, and the end of the interruption asks for it again if it is still wanted. The Android build is
tested; the iOS code is written to this contract and needs a Mac with Xcode to build.
