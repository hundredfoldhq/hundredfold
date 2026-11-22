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
