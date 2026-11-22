# Contract: the `voice:` config block and `GET /api/voice/config`

## `voice:` in `config.yaml`

Type `VoiceConfig` in `packages/hundredfold/src/shared/voice-config.ts`. The validator
`voiceConfigProblems(voice)` is wired into the config loader beside the other
`*Problems`. While there is any problem, voice stays off and each problem names the key
(FR-025). `resolveVoiceConfig(config)` returns `null` unless `enabled === true`, and
otherwise a `ResolvedVoiceConfig` with every default filled.

| Key | Type | Default | Validation |
|---|---|---|---|
| `enabled` | boolean | `false` | |
| `mode` | `hands-free` \| `push-to-talk` | `hands-free` | enum |
| `language` | string | `en` | BCP-47-ish `^[a-z]{2,3}(-[A-Za-z0-9]+)*$`; `local` accepts only `en*` |
| `stt.provider` | `local` \| `openai` \| `openai-compatible` | `local` | known id |
| `stt.model` | string | provider default (`local`: `parakeet-tdt-0.6b-v2`; `openai`: the current transcription model, named in the docs) | non-empty |
| `stt.baseUrl` | URL | — | required for `openai-compatible`; http(s) only |
| `stt.apiKey` | string | — | must be a `${VAR}` reference; a literal is refused with a message telling how to move it to the environment |
| `tts.provider` | as `stt.provider` | `local` | |
| `tts.model` | string | provider default (`local`: `kokoro-v1.0`) | |
| `tts.voice` | string | `local`: the operator's pick (`af_heart` until chosen) | `local`: a voice in the Kokoro voice file (checked when the sidecar is ready, reported in status) |
| `tts.speed` | number | `1.0` | 0.5 to 2 |
| `tts.baseUrl`, `tts.apiKey` | | | as for `stt` |
| `vad.threshold` | number | `0.5` | 0 to 1 |
| `vad.minSpeechMs` | integer | `250` | 50 to 2000 |
| `vad.silenceMs` | integer | `700` | 200 to 5000 |
| `vad.prerollMs` | integer | `300` | 0 to 1000 |
| `bargeIn.enabled` | boolean | `true` | |
| `bargeIn.minSpeechMs` | integer | `250` | 50 to 2000 |
| `bargeIn.onsetThreshold` | number | `0.02` | 0 to 1, RMS of the client's onset detector |
| `autoBackground.enabled` | boolean | `true` | |
| `autoBackground.afterSeconds` | number | `5` | 1 to 600 |
| `prompt` | string | built-in voice prompt (below) | ≤ 8000 chars |
| `promptFile` | instance-relative path | — | must stay inside the instance home; `prompt` wins if both |
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
  "autoBackground": { "enabled": true, "afterSeconds": 5 },
  "limits": { "maxUtteranceSeconds": 60 },
  "install": { "state": "ready", "progress": 1 }
}
```

`install.state`: `not_installed` | `installing` | `ready` | `failed` (with `reason`), for
the local sidecar's first-run bootstrap. `available: false` carries a `reason` a person
can act on ("Python 3.10+ not found", "OpenAI key not set: OPENAI_API_KEY").

When the config says `enabled: true` but the gateway started with voice off (voice is set up only at boot, so turning it on needs a restart), the body is the same with `available: false` and `reason: "Restart the gateway to turn voice on"`. When voice was running and the config then turns it off, the body is `{ "enabled": false }`, a new `/ws/voice` upgrade is refused as when voice is off, and open attachments get `detached {reason: "disabled"}`.

Never present: any key, any base URL, the prompt text.

`POST /api/voice/install` (operator only) starts the local bootstrap if it has not run;
it is idempotent and returns the same `install` object.
