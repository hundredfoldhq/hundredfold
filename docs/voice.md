# Voice mode

Voice mode is a spoken conversation with a chat. You talk, the gateway turns your speech into text and sends it to the session as an ordinary message, and the session's reply is turned back into speech, sentence by sentence, while it is still being written. Every spoken turn is stored and shown in the chat like a typed one, marked as spoken.

Voice mode is **off by default**. With no `voice:` block, or `enabled: false`, the chat shows no voice control, the gateway accepts no voice connection and contacts no speech provider.

The speech itself runs on the gateway's machine by default (Parakeet for speech-to-text, in one of two versions you can choose between, Kokoro for text-to-speech, Silero for voice activity detection), costs nothing and needs no key. OpenAI and any server that speaks the OpenAI audio API can be used instead, per direction.

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

### Choosing the speech-to-text model

The local provider runs one of two Parakeet models, chosen with `stt.model`:

| `stt.model` | What it is | Size on disk | Notes |
|---|---|---|---|
| `parakeet-tdt-0.6b-v2` (default) | NVIDIA Parakeet TDT 0.6B v2, English | 2.4 GB (GPU), 0.65 GB (CPU) | The model every earlier version used. |
| `parakeet-unified-en-0.6b` | NVIDIA Parakeet Unified 0.6B, English; one transducer model for offline and streaming recognition | 2.5 GB (GPU), 0.66 GB (CPU) | NVIDIA reports better accuracy than its earlier transducer models, and on the sample below it made fewer errors; its final decode takes longer on long utterances. The gateway uses its offline mode. NVIDIA Open Model License (see below). |

```yaml
voice:
  enabled: true
  stt:
    model: parakeet-unified-en-0.6b
```

With the local provider, any other value keeps voice off and says so, naming `voice.stt.model` and the two choices (a stale or misspelt name no longer runs the default silently). Leaving `stt.model` out keeps the default, so a configuration that names no model, or the default, is unchanged. Hosted providers (`openai`, `openai-compatible`) keep taking any model name.

Changing the model needs the new model's files, not a new install of everything. Reload the configuration, then ask for the install again (the voice control's "Install", or `POST /api/voice/install`): the Python environment is kept and only the model is downloaded (a few minutes; it refuses to start with less than 3.5 GB free for the GPU path, 1 GB for the CPU path). Both models can stay installed, and switching back is instant. Each downloaded file of the unified model is pinned to a commit and its SHA-256, and a file that does not match fails the install.

Measured on one workstation with a 16 GB NVIDIA GPU while its CPU was heavily loaded (load average about 60), over 73 clean LibriSpeech clips (8 minutes of read speech, 1,150 words): word error rate 2.87% for `parakeet-tdt-0.6b-v2` and 2.35% for `parakeet-unified-en-0.6b` (33 and 27 word errors, mostly proper names). The gap is six words, so read it as "no worse", not as proof of better. Warm decode took a median of 0.45 to 0.60 s for the default and 0.55 to 0.70 s for the unified model; it is dominated by a Python decoding loop that the loaded CPU slows, and the unified model's grows faster with the length of the utterance (about 0.85 s against 0.5 to 0.65 s for 10 to 15 seconds of speech). Your numbers on an idle machine will be several times lower.

### Speed

Measured on a workstation with a 16 GB NVIDIA GPU (and a heavily loaded CPU): Parakeet fp32 on the GPU decodes a few seconds of speech in 50 to 100 ms warm, and Kokoro on the GPU speaks a sentence in well under a second. On a CPU, Parakeet's int8 model took several seconds per decode on that loaded machine, and Kokoro about as long as the speech it makes. Expect voice mode on CPU to feel slow; use the GPU, or a hosted provider, for a conversation that flows.

## Configuration reference

Every key is optional. `voice:` lives in `config.yaml`; a wrong value is reported by name and reason when the configuration loads. A bad `voice:` block does not stop the gateway starting or a reload: the rest of the configuration loads, voice stays off, the gateway logs why, and `GET /api/voice/config` answers `available: false` with a `reason` naming each bad key (the voice control shows it). A reload that makes a running voice block invalid ends open voice conversations the same way turning voice off does.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turns voice mode on. Restart the gateway after turning it on or off: the gateway sets voice mode up when it starts. Turned off without a restart, new voice conversations are refused at once and open ones end. Turned on without a restart, the voice control shows as unavailable and says to restart the gateway. |
| `mode` | `hands-free` | `hands-free` ends an utterance on your pause; `push-to-talk` ends it when you release the control. |
| `language` | `en` | Language code. The local providers speak English only (`en`, `en-GB`, …). |
| `stt.provider` | `local` | `local`, `openai` or `openai-compatible`. |
| `stt.model` | per provider | `local`: `parakeet-tdt-0.6b-v2` (default) or `parakeet-unified-en-0.6b`, and nothing else; `openai`: `gpt-live-transcribe`; `openai-compatible`: `whisper-1`, or whatever name the server uses. |
| `stt.baseUrl` | — | Required for `openai-compatible`: the server's root, without `/v1`. http or https. |
| `stt.apiKey` | — | A `${VAR}` reference to an environment variable. A literal key is refused. |
| `tts.provider` | `local` | As for `stt.provider`. |
| `tts.model` | per provider | `local`: `kokoro-v1.0`; `openai`: `gpt-4o-mini-tts`; `openai-compatible`: `tts-1`. |
| `tts.voice` | `local`: `af_heart`; `openai`, `openai-compatible`: `marin`, `alloy` | The voice. |
| `tts.speed` | `1.0` | 0.5 to 2. |
| `tts.baseUrl`, `tts.apiKey` | — | As for `stt`. |
| `vad.threshold` | `0.5` | Speech probability that counts as speech, 0 to 1. |
| `vad.minSpeechMs` | `250` | Speech must last this long to start an utterance, 50 to 2000. |
| `vad.silenceMs` | `1000` | Silence that ends an utterance, 200 to 5000. A shorter pause than this does not end your turn; lower it for a snappier reply, raise it if the assistant still cuts in on your pauses. |
| `vad.unfinishedHoldMs` | `800` | Extra silence waited when the words so far look unfinished (they trail off on "and", "the", "to", a comma, "um" and the like), so a pause to think does not end the turn. Speaking again inside it continues the same utterance. It works from the live transcript, so it helps when the words end on such a word ("book a table and"); a pause after a finished-looking sentence is ended by `vad.silenceMs` alone. 0 turns it off, up to 5000. Hands-free only; push-to-talk ends when you release. |
| `vad.prerollMs` | `300` | Audio kept from before speech was detected, 0 to 1000. |
| `bargeIn.enabled` | `true` | Whether speaking over the assistant stops it. |
| `bargeIn.minSpeechMs` | `250` | How long your voice must be heard over playback before playback stops, 50 to 2000. |
| `bargeIn.onsetThreshold` | `0.02` | Loudness (RMS, 0 to 1) the browser's detector treats as you speaking. Raise it if speakers cause false stops. |
| `autoBackground.enabled` | `true` | Move long work to the background when you speak, where the engine can (see below). |
| `autoBackground.afterSeconds` | `5` | A tool call older than this when you speak is long work, 1 to 600. |
| `prompt` | built in | The spoken-conversation instructions, at most 8000 characters. |
| `promptFile` | — | A path inside the instance home holding the instructions, read the first time the voice config is resolved and again whenever the `voice:` block changes (not only when the gateway starts). `prompt` wins if both are set. |
| `holdingLine` | "Still working on the last thing. I'll come to that as soon as it's done." | Spoken when your message has to wait behind long work. At most 300 characters. |
| `limits.maxUtteranceSeconds` | `60` | Longest single utterance, 5 to 120 (the local speech-to-text takes at most about 130 seconds of one utterance). |
| `limits.maxConcurrentAttachments` | `4` | Chats in voice mode at once, 1 to 64. |
| `local.device` | `auto` | `auto` uses the GPU when `nvidia-smi` lists one; or `gpu`, or `cpu`. |

Provider keys are never sent to a browser, in any response, message or error. The gateway takes each variable an `apiKey` names out of its own environment when the configuration loads and keeps it only inside the gateway: no engine process, tool or shell a model runs inherits it. A variable that only voice needs, such as `VOICE_OPENAI_API_KEY`, is the clearest choice: another tool the gateway starts that expects the same variable will not find it. A `${VAR}` you write elsewhere in `config.yaml` (a realtime key, an MCP server's environment) still resolves it.

## Providers

### Local (the default)

Nothing to configure beyond `enabled: true` and the install above.

### OpenAI

```yaml
voice:
  enabled: true
  stt: { provider: openai, apiKey: "${VOICE_OPENAI_API_KEY}" }
  tts: { provider: openai, apiKey: "${VOICE_OPENAI_API_KEY}", voice: marin }
```

Set `VOICE_OPENAI_API_KEY` in the environment the gateway runs in. Speech-to-text streams over OpenAI's Realtime transcription session (partial transcripts while you speak); text-to-speech streams `POST /v1/audio/speech` as raw 24 kHz PCM. Voices (`GET /api/voice/config` lists them): `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer`, `verse`, `marin`, `cedar`.

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
- **Parakeet Unified 0.6B (English)** (speech-to-text, opt-in): NVIDIA's model, governed by the [NVIDIA Open Model License Agreement](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/): commercial use is allowed, and NVIDIA claims no rights in what it transcribes. Passing the model on to others requires a copy of that agreement and the notice "Licensed by NVIDIA Corporation under the NVIDIA Open Model License"; the gateway does not do that, because it does not ship the model: the install fetches the third-party ONNX conversions ([the encoder and decoder](https://huggingface.co/eschmidbauer/parakeet-unified-en-0.6b-onnx) and [the vocabulary](https://huggingface.co/mrfakename/parakeet-unified-ONNX), both marked with that licence) from Hugging Face straight onto your machine, so the agreement is between you and NVIDIA. One of the conversions the install does not use is labelled CC-BY-4.0 on its page, which is not what NVIDIA's own model card says; the agreement is the one that applies. You must not bypass or disable the model's guardrails without an equivalent of your own, and your licence ends if you sue anyone claiming the model infringes a patent or copyright.
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
