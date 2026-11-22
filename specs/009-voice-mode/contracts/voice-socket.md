# Contract: `/ws/voice/:sessionId`

Implemented as TypeScript types in `packages/gateway-events/src/voice-protocol.ts`,
shared by the gateway, the web client and (by mirror) the native client.

## Upgrade

`GET /ws/voice/:sessionId` with `Upgrade: websocket`.

| Condition | Result |
|---|---|
| voice absent or disabled | socket destroyed (no route), as for an unknown path |
| operator: `verifyGatewayAuth`, or a same-origin browser when auth is not required (the `/ws/pty` rule) | accepted |
| member cookie: `memberMayUpgrade` allows `/ws/voice/:id` **and** the member may send messages to the session | accepted, joins the member socket sweep |
| cross-origin browser | 403 (`rejectCrossOriginUpgrade`) |
| scoped caller outside reach (`sessionIsWithinReach`) | 403 |
| session missing, deleted, or a terminal | 404 |
| a different principal holds the session's attachment | accepted then closed `4409` with reason `in_use` |
| `limits.maxConcurrentAttachments` reached | accepted then closed `4429` with reason `limit` |

## Audio

- **Up**: binary frames of PCM16LE mono at 16 kHz, 20 ms (640 bytes) each, max 4096
  bytes per frame. Hands-free: sent continuously while voice mode is on. Push-to-talk:
  sent only between `ptt_down` and `ptt_up`.
- **Down**: binary frames `[u8 kind=1][u8 0][u16 seq LE][u32 segmentId LE][PCM16LE mono
  @ 24 kHz]`, max 16 KB of PCM per frame.

## Frames, client → gateway (JSON)

| `type` | Fields | Meaning |
|---|---|---|
| `hello` | `protocol: 1`, `mode`, `client: "web" \| "native"` | first frame; anything before it is a `bad_frame` |
| `ptt_down` / `ptt_up` | | push-to-talk boundaries |
| `barge_in` | `segmentId: number \| null`, `playedMs` | the client's onset detector fired over playback; playback already stopped |
| `played` | `segmentId` | a segment finished playing in full |
| `resume` | `suspendedMs` | the client is back after a device suspension (FR-033) |
| `bye` | | end voice mode |

## Frames, gateway → client (JSON)

| `type` | Fields | Meaning |
|---|---|---|
| `ready` | `protocol`, `sessionId`, `input {encoding, sampleRate}`, `output {encoding, sampleRate}`, `stt {provider, partials}`, `tts {provider, voice}`, `onset {threshold, minSpeechMs}`, `backgrounding: "native" \| "steer" \| "none"`, `limits {maxUtteranceSeconds}`, `keepaliveMs?: number` | after `hello`; `keepaliveMs` is the interval of `keepalive` frames (10 s today), absent from older gateways |
| `vad` | `speaking: boolean` | the gateway's VAD state (UI only) |
| `transcript` | `utteranceId`, `text`, `final` | partial or final |
| `stop_playback` | `reason: "speech"` | the gateway's VAD heard speech over playback before the client's onset did |
| `turn` | `state`, `tool?` | `idle` / `thinking` / `working` / `speaking` |
| `segment_start` | `segmentId`, `messageId`, `text` | before that segment's audio |
| `segment_end` | `segmentId` | after its last audio frame |
| `holding` | `text` | a holding line is being spoken (also sent as a segment) |
| `background` | `taskId`, `description` | long work moved to the background |
| `missed` | `messageIds: string[]` | replies that finished while the client was suspended; their speech follows |
| `metrics` | `utteranceId`, `sttMs`, `ttfaMs \| null` | per exchange |
| `error` | `code`, `message`, `utteranceId?` | `bad_frame`, `utterance_too_long`, `stt_failed`, `tts_failed`, `dispatch_failed`, `speech_unavailable`, `internal` |
| `keepalive` | | every `ready.keepaliveMs` while attached; no state, only proof of life (browsers cannot see ws pings). A client that saw `keepaliveMs` may treat the connection as lost after 2.5 intervals with no message of any kind. Additive: no protocol version bump |
| `detached` | `reason` | `taken_over`, `session_gone`, `disabled`, `access_lost`, `shutdown` |

## Close codes

`1000` normal (`bye`), `1001` shutdown, `4401` access lost, `4404` session gone, `4409`
in use by another principal, `4429` attachment limit, `4400` protocol error.

## Invariants (tested)

- No frame, error message or close reason ever contains a provider key or base-URL
  credentials (SC-007).
- A `final` with words produces exactly one user message.
- After `barge_in`, no audio frame for an already-queued segment of the interrupted
  reply is sent.
- The gateway never calls an engine's `kill` while that engine reports long foreground
  work.
