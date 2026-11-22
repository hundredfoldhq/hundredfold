# Contract: native voice client (Tauri mobile shell)

Used only when the web app runs inside the Hundredfold mobile app. In a browser the web
client handles audio itself.

## Commands (web → Rust), confined to the local `main` window like the other four

| Command | Input | Result |
|---|---|---|
| `voice_start` | `{ target, sessionId, mode }` | `{ ok }`, or an error: `permission_denied`, `not_paired`, `unsupported` |
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
{ "type": "native_state", "state": "connecting" | "running" | "paused" | "stopped", "reason": "user" | "notification" | "interruption" | "error" | "socket_closed" }
```

`reason` is optional. A gateway never emits `native_state`, so it lives in the web's
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
| Onset detector | RMS over 20 ms frames, `minSpeechMs` hold (same parameters as `ready.onset`) | same |
| Lock-screen control | Now Playing info ("Voice mode on"), remote `pause`/`stop` → `voice_stop` | notification action "Stop" → `voice_stop` |
| Permissions | `NSMicrophoneUsageDescription` | `RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS` |

Interruptions (a phone call, Siri, another app taking audio) pause capture and playback,
and resume when the system ends the interruption. A route change (headphones) keeps the
session going.
