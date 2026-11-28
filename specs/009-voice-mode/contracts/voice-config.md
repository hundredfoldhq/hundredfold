# Contract: the `voice:` config block and `GET /api/voice/config`

## `voice:` in `config.yaml`

Type `VoiceConfig` in `packages/hundredfold/src/shared/voice-config.ts`. The validator
`voiceConfigProblems(voice)` is not part of the config's shape validation, so a bad block
never stops the gateway starting or a reload. While there is any problem, voice stays off, the
loader logs each problem naming its key (FR-025), and `GET /api/voice/config` says why (below). `resolveVoiceConfig(config)` returns `null` unless `enabled === true`, and
otherwise a `ResolvedVoiceConfig` with every default filled.

| Key | Type | Default | Validation |
|---|---|---|---|
| `enabled` | boolean | `false` | |
| `mode` | `hands-free` \| `push-to-talk` | `hands-free` | enum |
| `language` | string | `en` | BCP-47-ish `^[a-z]{2,3}(-[A-Za-z0-9]+)*$`; `local` accepts only `en*` |
| `stt.provider` | `local` \| `openai` \| `openai-compatible` | `local` | known id |
| `stt.model` | string | provider default (`local`: `parakeet-tdt-0.6b-v2`; `openai`: the current transcription model, named in the docs) | non-empty; for `local`, one of `parakeet-tdt-0.6b-v2`, `parakeet-unified-en-0.6b`, `parakeet-unified-en-0.6b-streaming` |
| `stt.baseUrl` | URL | — | required for `openai-compatible`; http(s) only |
| `stt.apiKey` | string | — | must be a `${VAR}` reference; a literal is refused with a message telling how to move it to the environment |
| `tts.provider` | as `stt.provider` | `local` | |
| `tts.model` | string | provider default (`local`: `kokoro-v1.0`) | |
| `tts.voice` | string | `local`: the operator's pick (`af_heart` until chosen) | `local`: a voice in the Kokoro voice file (checked when the sidecar is ready, reported in status) |
| `tts.speed` | number | `1.0` | 0.5 to 2 |
| `tts.baseUrl`, `tts.apiKey` | | | as for `stt` |
| `vad.threshold` | number | `0.5` | 0 to 1 |
| `vad.minSpeechMs` | integer | `250` | 50 to 2000 |
| `vad.silenceMs` | integer | `1000` | 200 to 5000 |
| `vad.unfinishedHoldMs` | integer | `800` | 0 to 5000 |
| `vad.prerollMs` | integer | `300` | 0 to 1000 |
| `filter.minConfidence` | number | `0.3` | 0 to 1; a final whose provider-reported confidence is below it is dropped (0: never) |
| `filter.noSpeechThreshold` | number | `0.8` | 0 to 1; a final whose provider-reported no-speech chance is above it and that came with no confidence is dropped (1: never); with a confidence, only `filter.minConfidence` applies |
| `filter.phantomMaxMs` | integer | `500` | 0 to 5000; a clip whose speech (each stretch from its first voiced frame to its last, summed across an unfinished-speech hold) is shorter, whose whole transcript is a phantom phrase, is dropped (0: never) |
| `filter.phantomPhrases` | list of strings | `you`, `thank you`, `thanks for watching`, `amen`, `uh`, `um`, `hmm`, `mm`, `mhm`, `huh`, `oh`, `ah` | at most 100, each 1 to 80 characters; matched on the whole transcript after lower-casing and dropping punctuation; `[]` turns it off |
| `bargeIn.enabled` | boolean | `true` | |
| `bargeIn.minSpeechMs` | integer | `250` | 50 to 2000 |
| `bargeIn.onsetThreshold` | number | `0.02` | 0 to 1, RMS of the client's onset detector |
| `autoBackground.enabled` | boolean | `true` | |
| `autoBackground.afterSeconds` | number | `5` | 1 to 600 |
| `cues.enabled` | boolean | `true` | soft sound cues while the assistant thinks and runs a tool (see voice-socket.md `ready.cues`) |
| `cues.volume` | number | `0.3` | 0 to 1 |
| `prompt` | string | built-in voice prompt (below) | ≤ 8000 chars |
| `promptFile` | instance-relative path | — | must stay inside the instance home; `prompt` wins if both |
| `stylePrompt` | string | unset (no change) | ≤ 2000 chars; added to the voice instructions on every voice turn, read live from the loaded config |
| `holdingLine` | string | "Still working on the last thing. I'll come to that as soon as it's done." | ≤ 300 chars |
| `limits.maxUtteranceSeconds` | integer | `60` | 5 to 120 (the sidecar's 4 MB body is about 131 s of 16 kHz PCM16) |
| `limits.maxConcurrentAttachments` | integer | `4` | 1 to 64 |
| `local.device` | `auto` \| `gpu` \| `cpu` | `auto` | `auto` = GPU when `nvidia-smi` reports one |

Built-in voice prompt:

> You are in a spoken conversation. Your replies are converted to speech. Answer in
> short, natural sentences and lead with the answer. Never read out code, logs, tables,
> paths or URLs: put them in the chat and say you have. Summarise rather than recite.
> Before work that takes more than a moment, say in one sentence what you are about to
> do. If the user interrupts you, drop the old thread and answer what they just said.

Per-turn reminder: `[Voice: spoken reply. Short, plain sentences; no markdown or code read aloud.]`

Style directions (`voice.stylePrompt`, when set; a turn that starts with `/` carries none):

- First turn (full prompt): inside the `[Voice mode]` block, after the instructions, under the heading `Style directions from the user (follow these in how you sound):`.
- Later turns: one line after the reminder, `[Voice: style directions from the user, replacing any earlier style directions: <style, on one line>]`.
- When the style goes from set to empty: `[Voice: the user's style directions were removed; ignore any earlier style directions.]` once, on the next reminder turn.
- The block markers inside the style or the prompt are stripped, repeatedly, so nesting cannot rebuild one.

## `GET /api/voice/config`

Operator only. Refused to department-scoped callers (`department-scope/rules.ts`,
`/api/voice*`). Board members get no voice config: the member router serves only
`/api/member/*`, and members cannot message sessions yet, so nothing on the member side
would use it. When member chat lands, it adds `GET /api/member/voice/config` (same body)
with its consumer; nothing is added for members now (Principle V).

Disabled or absent:

```json
{ "enabled": false }
```

Enabled:

```json
{
  "enabled": true,
  "available": true,
  "reason": null,
  "mode": "hands-free",
  "language": "en",
  "stt": { "provider": "local", "partials": true, "status": { "available": true } },
  "tts": { "provider": "local", "voice": "af_heart", "voices": ["af_heart", "..."], "status": { "available": true } },
  "onset": { "threshold": 0.02, "minSpeechMs": 250 },
  "bargeIn": { "enabled": true },
  "cues": { "enabled": true, "volume": 0.3 },
  "autoBackground": { "enabled": true, "afterSeconds": 5 },
  "limits": { "maxUtteranceSeconds": 60 },
  "install": { "state": "ready", "progress": 1 }
}
```

`install.state`: `not_installed` | `installing` | `ready` | `failed` (with `reason`), for
the local sidecar's first-run bootstrap. `available: false` carries a `reason` a person
can act on ("Python 3.10+ not found", "OpenAI key not set: OPENAI_API_KEY").

When the config asks for voice (`enabled: true`, or an `enabled` that is not a boolean) but the `voice` block has problems, voice is off and the body is `{ "enabled": true, "available": false, "reason": "Voice is off because config.yaml has problems in voice: <each problem, naming its key, joined by \"; \">" }`, with none of the other fields. The reason never carries a key or a URL's user name. A block with `enabled: false` (or no `enabled`) is `{ "enabled": false }` whatever else it holds. A reload that makes a running voice block invalid ends open attachments with `detached {reason: "disabled"}` as turning voice off does.

When the config says `enabled: true` but the gateway started with voice off (voice is set up only at boot, so turning it on needs a restart), the body is the same with `available: false` and `reason: "Restart the gateway to turn voice on"`. When voice was running and the config then turns it off, the body is `{ "enabled": false }`, a new `/ws/voice` upgrade is refused as when voice is off, and open attachments get `detached {reason: "disabled"}`.

Never present: any key, any base URL, the prompt text.

The gateway takes the environment variables named by the enabled block's `apiKey` settings out of its own environment at load and withholds them from every engine child process (as for opencode account keys); only its voice providers read them.

`POST /api/voice/install` (operator only) starts the local bootstrap if it has not run;
it is idempotent and returns the same `install` object.

`POST /api/voice/end` (a session's own tool call, the built-in `end_voice_call` tool; no body, no session id) hangs up the voice call on the calling session once its goodbye has been heard, and answers `200 {"status": "ending"}`. `409 {"error"}` when no call is open on that session or voice is not running; `403 {"error"}` for the operator or a call that lost its session identity. The call ends with `detached {reason: "ended"}` and close `1000` (see `voice-socket.md`).
