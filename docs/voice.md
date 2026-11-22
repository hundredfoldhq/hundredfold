# Voice mode

Voice mode is a spoken conversation with a chat. You talk, the gateway turns your speech into text and sends it to the session as an ordinary message, and the session's reply is turned back into speech, sentence by sentence, while it is still being written. Every spoken turn is stored and shown in the chat like a typed one, marked as spoken.

Voice mode is **off by default**. With no `voice:` block, or `enabled: false`, the chat shows no voice control, the gateway accepts no voice connection and contacts no speech provider.

The speech itself runs on the gateway's machine by default (Parakeet for speech-to-text, Kokoro for text-to-speech, Silero for voice activity detection), costs nothing and needs no key. OpenAI and any server that speaks the OpenAI audio API can be used instead, per direction.

Voice mode is for the operator. Board members cannot message sessions yet, so they have no chat to speak into: the voice routes answer them "Not available to board members", and a member sees no voice control. It will be offered to members when they can chat with sessions.

## Pre-installation steps

The built-in local speech installs its own runtime and models the first time you ask for it. Before you do, the machine that runs the gateway needs:

1. **Python 3.10 or newer, with `venv` and `pip`.** Check with `python3 --version` and `python3 -m venv --help`.
   - Debian and Ubuntu: `sudo apt install python3 python3-venv python3-pip`
   - macOS: `brew install python`
   - Windows: the local providers are not supported there yet; use a hosted or OpenAI-compatible provider.
2. **Disk space under the instance home** (`~/.hundredfold/models/voice/`): about **1.2 GB free for CPU** models, about **6 GB free for GPU** models (a GPU install takes about 5.2 GB: the fp32 Parakeet model is 2.4 GB, Kokoro 0.3 GB, and the Python environment with the CUDA runtime libraries 2.6 GB). The install refuses to start with less and says how much it needs.
3. **For the GPU path only: an NVIDIA GPU with a driver that supports CUDA 12.** The CUDA and cuDNN runtimes are installed by `pip`, so no CUDA toolkit is needed. `nvidia-smi` must work. Without a GPU the CPU path is used; it works, but it is much slower (see below).
4. **Network access during the install** to PyPI, `huggingface.co` and `github.com` (the Kokoro model files). After the install nothing needs the network.

Nothing else is needed: no `ffmpeg`, no `whisper-cli`, no system `espeak`. Nothing is installed system-wide and nothing is shared with the read-aloud (`/api/tts`) or dictation features.

The container image does not include Python, so the local providers do not run in it unless you extend the image ([docs/docker.md](docker.md)); hosted and OpenAI-compatible providers work there.

## First-run install

1. Add the block and let the gateway reload its configuration:

   ```yaml
   voice:
     enabled: true
   ```

2. Ask for the install. In the web app this is the voice control's "Install" action; with the API:

   ```sh
   curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7777/api/voice/install
   ```

   It builds a Python environment, installs pinned packages (`onnx-asr`, `kokoro-onnx`, ONNX Runtime) and downloads the models into `~/.hundredfold/models/voice/`. It is idempotent, and only the operator can start it. On a fast connection it takes a few minutes.

3. Watch `GET /api/voice/config`: `install.state` goes `not_installed` → `installing` (with `progress` from 0 to 1) → `ready`, or `failed` with a `reason`. A `voice:install` event carries the same state to the browser as it changes. `available: false` always comes with a `reason` a person can act on ("Python 3.10+ with venv and pip not found", "OpenAI key not set: OPENAI_API_KEY").

The speech process starts when voice is first used, stays warm for 10 minutes after the last use, and is stopped when the gateway stops. If it dies it is started again on the next use, at most once every 30 seconds. Starting it loads the models and runs one warm-up decode and synthesis, which takes several seconds on a GPU and longer on a cold disk; speech in the first seconds after voice mode opens, while the models load, may not be transcribed.

Changing `local.device` between `cpu` and `gpu` needs a new install (a different runtime package and a different Parakeet model); the config reply says `not_installed` until you run it again.

### Speed

Measured on a workstation with a 16 GB NVIDIA GPU (and a heavily loaded CPU): Parakeet fp32 on the GPU decodes a few seconds of speech in 50 to 100 ms warm, and Kokoro on the GPU speaks a sentence in well under a second. On a CPU, Parakeet's int8 model took several seconds per decode on that loaded machine, and Kokoro about as long as the speech it makes. Expect voice mode on CPU to feel slow; use the GPU, or a hosted provider, for a conversation that flows.

## Configuration reference

Every key is optional. `voice:` lives in `config.yaml`; a wrong value is reported by name and reason when the configuration loads, and the gateway will not load a configuration with a bad `voice:` block.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turns voice mode on. Restart the gateway after turning it on or off: the gateway sets voice mode up when it starts. Turned off without a restart, new voice conversations are refused at once and open ones end. Turned on without a restart, the voice control shows as unavailable and says to restart the gateway. |
| `mode` | `hands-free` | `hands-free` ends an utterance on your pause; `push-to-talk` ends it when you release the control. |
| `language` | `en` | Language code. The local providers speak English only (`en`, `en-GB`, …). |
| `stt.provider` | `local` | `local`, `openai` or `openai-compatible`. |
| `stt.model` | per provider | `local`: `parakeet-tdt-0.6b-v2`; `openai`: `gpt-live-transcribe`; `openai-compatible`: `whisper-1`. |
| `stt.baseUrl` | — | Required for `openai-compatible`: the server's root, without `/v1`. http or https. |
| `stt.apiKey` | — | A `${VAR}` reference to an environment variable. A literal key is refused. |
| `tts.provider` | `local` | As for `stt.provider`. |
| `tts.model` | per provider | `local`: `kokoro-v1.0`; `openai`: `gpt-4o-mini-tts`; `openai-compatible`: `tts-1`. |
| `tts.voice` | `local`: `af_heart`; `openai`, `openai-compatible`: `marin`, `alloy` | The voice. |
| `tts.speed` | `1.0` | 0.5 to 2. |
| `tts.baseUrl`, `tts.apiKey` | — | As for `stt`. |
| `vad.threshold` | `0.5` | Speech probability that counts as speech, 0 to 1. |
| `vad.minSpeechMs` | `250` | Speech must last this long to start an utterance, 50 to 2000. |
| `vad.silenceMs` | `700` | Silence that ends an utterance, 200 to 5000. |
| `vad.prerollMs` | `300` | Audio kept from before speech was detected, 0 to 1000. |
| `bargeIn.enabled` | `true` | Whether speaking over the assistant stops it. |
| `bargeIn.minSpeechMs` | `250` | How long your voice must be heard over playback before playback stops, 50 to 2000. |
| `bargeIn.onsetThreshold` | `0.02` | Loudness (RMS, 0 to 1) the browser's detector treats as you speaking. Raise it if speakers cause false stops. |
| `autoBackground.enabled` | `true` | Move long work to the background when you speak, where the engine can (see below). |
| `autoBackground.afterSeconds` | `5` | A tool call older than this when you speak is long work, 1 to 600. |
| `cues.enabled` | `true` | Soft sound cues while the assistant is thinking and while it runs a tool (see "Sound cues"). `false` turns them off. |
| `cues.volume` | `0.3` | How loud the cues are, 0 (silent) to 1. Even 1 is a gentle tick. |
| `prompt` | built in | The spoken-conversation instructions, at most 8000 characters. |
| `promptFile` | — | A path inside the instance home holding the instructions, read the first time the voice config is resolved and again whenever the `voice:` block changes (not only when the gateway starts). `prompt` wins if both are set. |
| `holdingLine` | "Still working on the last thing. I'll come to that as soon as it's done." | Spoken when your message has to wait behind long work. At most 300 characters. |
| `limits.maxUtteranceSeconds` | `60` | Longest single utterance, 5 to 120 (the local speech-to-text takes at most about 130 seconds of one utterance). |
| `limits.maxConcurrentAttachments` | `4` | Chats in voice mode at once, 1 to 64. |
| `local.device` | `auto` | `auto` uses the GPU when `nvidia-smi` lists one; or `gpu`, or `cpu`. |

Provider keys are never sent to a browser, in any response, message or error. They are read from the gateway's environment when a provider is created and kept only inside it.

## Providers

### Local (the default)

Nothing to configure beyond `enabled: true` and the install above.

### OpenAI

```yaml
voice:
  enabled: true
  stt: { provider: openai, apiKey: "${OPENAI_API_KEY}" }
  tts: { provider: openai, apiKey: "${OPENAI_API_KEY}", voice: marin }
```

Set `OPENAI_API_KEY` in the environment the gateway runs in. Speech-to-text streams over OpenAI's Realtime transcription session (partial transcripts while you speak); text-to-speech streams `POST /v1/audio/speech` as raw 24 kHz PCM. Voices (`GET /api/voice/config` lists them): `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer`, `verse`, `marin`, `cedar`.

OpenAI's own documentation, read on 2026-11-22, marks the `/v1/audio/speech` models (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`) as retiring on 2027-01-06 with no replacement for that endpoint, and several transcription models on 2027-02-26. Check the current state before relying on them.

### A self-hosted OpenAI-compatible server

For a server that offers `/v1/audio/transcriptions` and `/v1/audio/speech` (Speaches, a Whisper or Kokoro server, and others):

```yaml
voice:
  enabled: true
  stt: { provider: openai-compatible, baseUrl: "http://localhost:8000", model: Systran/faster-whisper-small }
  tts: { provider: openai-compatible, baseUrl: "http://localhost:8880", model: kokoro, voice: af_heart }
```

`apiKey` is optional here. Speech-to-text is batch: the whole utterance is sent when you stop, so no partial transcripts. Text-to-speech asks for `pcm`, then `wav`; a server that can only return MP3 is refused with a message saying so. Audio at another sample rate is converted to 24 kHz.

### Voice activity detection with a hosted provider

The gateway decides when you have stopped speaking. With the local models installed it uses Silero, even when speech-to-text is hosted. Without them it falls back to a simple in-process loudness detector, which is less accurate: a fan or a keyboard can start an utterance. Install the local models if you use a hosted provider with a noisy room.

## Voices

The local voices are Kokoro's: `af_*` and `am_*` are American English female and male, `bf_*` and `bm_*` British. `GET /api/voice/config` lists the installed ones under `tts.voices`. Set `tts.voice` to one, for example `af_heart` (the default), `af_bella`, `am_michael` or `bf_emma`. A name that is not in the list makes the text-to-speech report itself unavailable and say which voice it could not find.

## Model licences

The gateway does not ship the models; it downloads them on first use.

- **Parakeet TDT 0.6B v2** (speech-to-text): NVIDIA's model, converted to ONNX by a third party under CC-BY-4.0; see NVIDIA's model card for its community model licence.
- **Kokoro-82M v1.0** (text-to-speech): Apache-2.0.
- **Silero VAD**: MIT.

## What happens when you speak over a long job

Speaking while the assistant is working never stops the work. How the gateway lets your new message through depends on the session's engine:

| Engine | What happens when you speak during long work |
|---|---|
| Claude (interactive terminal engine) | The running command is moved to the background, your message goes in at once, the chat shows the work as moved and still running, and when it finishes the session is woken to report it, and the report is spoken. |
| OpenCode 2.x | Your message is steered in at the next step, and the holding line is spoken straight away. |
| Every other engine | Your message waits behind the turn, and the holding line is spoken straight away. When nothing long is running, speaking interrupts the turn as a typed message with "send now" does. |

"Long" means a tool call that has run longer than `autoBackground.afterSeconds`. Shorter work is left to finish up to that point before your message is acted on.

## Sound cues

So that silence while the assistant works does not feel like a hang, voice mode plays two soft sounds, one at a time:

- **Thinking:** one quiet tick about once a second, while the model is working and nothing is being spoken yet.
- **Tool:** a quicker, higher tick-tick about every 1.3 seconds, while a tool is running. It takes over from the thinking tick at the first tool call and gives it back when the tool returns.

Both are made on the device (a short sine tick with a soft envelope; no audio file and no network), in the web app and in the mobile app, and the first tick comes about a third of a second after the state starts, so a brief pause makes no sound. They follow the gateway's own `turn`, `vad` and `background` frames, not a guess made on the client.

**They stop at once** when the assistant starts to speak (a reply or the holding line, from the moment the gateway announces the sentence), when you are heard speaking (the gateway's voice activity, a partial transcript, or push-to-talk held), when the turn ends, and when voice mode stops, is suspended by the device or is paused by a call. A cue that was silenced for speech starts again if the work is still going when the speech has played out.

**Long work moved to the background:** when a tool call is moved to the background (see above), the tool sound stops and the thinking sound takes its place until the turn ends, since the assistant is free to answer. Background work that keeps running after the turn has ended is silent; the chat shows it as moved and still running. The hand-over is approximate: the gateway's `background` frame does not name the tool call, so a task moved while a different tool is running also switches the sound early.

**Settings:** Settings, Voice mode, has a switch and a volume slider; the same keys are `voice.cues.enabled` and `voice.cues.volume` in `config.yaml`. They are on at a low volume by default, apply the next time voice mode starts, and a config with no `cues` block, or one with stale keys, loads and uses the defaults.

**Why a cue cannot trigger the microphone.** The phone or computer can hear its own speaker, so this is guarded in four ways:

1. A cue never goes through the speech player. Barge-in only listens while speech is playing (browser, Android and iOS alike), and a cue is never playing then, so a cue is never taken for you interrupting.
2. The gateway only hears a cue if it leaks into the microphone, and the cue is built not to look like speech to it: ticks of 35 to 50 milliseconds with long gaps, at most -14 dBFS at volume 1 and about -24 dBFS at the default, well under the 250 ms hold that starts an utterance. The echo canceller of the browser, Android and iOS removes most of it before that.
3. A cue that is playing is silenced the moment the gateway says it hears you, so it never sits under your own voice for long.
4. Its audio is on a player of its own, on the same audio session as the microphone, so the platform's echo canceller knows it is output.

Measured against the real Silero detector on a gateway, with the cue played straight into the microphone uplink and no echo cancelling at all: each cue at volume 1 for 20 seconds (about 0.07 RMS, above the default onset level for the 35 to 50 ms of each tick, never for 250 ms), and a cue at five times that level (about 0.36 RMS), started no utterance, no transcript and no `stop_playback`, while a spoken sentence at normal level did. If a loud room or an open speaker still sets it off on your setup, lower `cues.volume` or turn the cues off.

## The screen is locked

| Platform | Browser | Hundredfold mobile app |
|---|---|---|
| Desktop browser, tab in the background | Keeps listening and speaking while the page runs. | — |
| iPhone and iPad | Safari suspends the page's microphone and audio when the screen locks. On return you are told voice mode was suspended, replies that finished meanwhile are spoken, and listening resumes (a tap if the browser asks for one). | Keeps listening, speaking and accepting interruptions with the screen locked, with a lock-screen control to stop it. |
| Android | Varies by browser and version: some keep the page running, some suspend it, and the same recovery applies. | Keeps listening, speaking and accepting interruptions with the screen locked, with a notification that has a Stop action. |

## Cost

- **Local:** free; it uses the gateway machine's CPU or GPU and disk.
- **OpenAI:** billed by OpenAI per its price list for the models you choose. Cost is bounded by `limits.maxUtteranceSeconds` and `limits.maxConcurrentAttachments`; nothing is spent unless `enabled: true` names a hosted provider and someone is in voice mode.
- **OpenAI-compatible:** whatever your server costs to run.
- **Model usage:** every spoken turn is an ordinary message to the session's engine and costs what a typed one costs. The instructions added to a spoken turn are small.
