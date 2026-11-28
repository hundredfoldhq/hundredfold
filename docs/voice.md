# Voice mode

Voice mode is a spoken conversation with a chat. You talk, the gateway turns your speech into text and sends it to the session as an ordinary message, and the session's reply is turned back into speech, sentence by sentence, while it is still being written. Every spoken turn is stored and shown in the chat like a typed one, marked as spoken.

Voice mode replaces the old hold-to-talk microphone that sat in the chat composer: the composer has no dictation mic any more, and speaking to a chat is voice mode. The dictation microphones in Notes and Todo quick capture stay, and now run on voice mode's speech-to-text (see [Dictation](#dictation)).

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

Nothing else is needed: no `ffmpeg`, no `whisper-cli`, no system `espeak`. Nothing is installed system-wide and nothing is shared with the read-aloud (`/api/tts`) feature.

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

The speech process starts when voice is first used, stays warm for 10 minutes after the last use, and is stopped when the gateway stops. If it dies it is started again on the next use, at most once every 30 seconds. Starting it loads the models and runs one warm-up decode and synthesis, which takes several seconds on a GPU and longer on a cold disk.

Changing `local.device` between `cpu` and `gpu` needs a new install (a different runtime package and a different Parakeet model); the config reply says `not_installed` until you run it again.

### Choosing the speech-to-text model

The local provider runs one of three Parakeet models, chosen with `stt.model`:

| `stt.model` | What it is | Size on disk | Notes |
|---|---|---|---|
| `parakeet-tdt-0.6b-v2` (default) | NVIDIA Parakeet TDT 0.6B v2, English | 2.4 GB (GPU), 0.65 GB (CPU) | The model every earlier version used. |
| `parakeet-unified-en-0.6b` | NVIDIA Parakeet Unified 0.6B, English; one transducer model for offline and streaming recognition | 2.5 GB (GPU), 0.66 GB (CPU) | NVIDIA reports better accuracy than its earlier transducer models, and on the sample below it made fewer errors; its final decode takes longer on long utterances. The gateway uses its offline mode. NVIDIA Open Model License (see below). |
| `parakeet-unified-en-0.6b-streaming` | The same Unified model run in its chunked streaming mode (560 ms chunks with 560 ms of right context) | 2.5 GB (GPU), 0.67 GB (CPU); the weights are shared with the offline Unified model when both are installed | Decodes the speech as it arrives, so the final text is ready about 40 to 60 ms after speech ends instead of 0.3 to 0.9 s. In our sample it made a few more word errors than the offline mode (see below). NVIDIA Open Model License (see below). |

```yaml
voice:
  enabled: true
  stt:
    model: parakeet-unified-en-0.6b
```

With the local provider, any other value keeps voice off and says so, naming `voice.stt.model` and the three choices (a stale or misspelt name no longer runs the default silently). Leaving `stt.model` out keeps the default, so a configuration that names no model, or the default, is unchanged. Hosted providers (`openai`, `openai-compatible`) keep taking any model name.

Changing the model needs the new model's files, not a new install of everything. Reload the configuration, then ask for the install again (the voice control's "Install", or `POST /api/voice/install`): the Python environment is kept and only the model is downloaded (a few minutes; it refuses to start with less than 3.5 GB free for the GPU path, 1 GB for the CPU path). Every model that has been installed stays installed, and switching between them is instant. Each downloaded file of the unified model is pinned to a commit and its SHA-256, and a file that does not match fails the install.

Measured on one workstation with a 16 GB NVIDIA GPU while its CPU was heavily loaded (load average about 60), over 73 clean LibriSpeech clips (8 minutes of read speech, 1,150 words): word error rate 2.87% for `parakeet-tdt-0.6b-v2` and 2.35% for `parakeet-unified-en-0.6b` (33 and 27 word errors, mostly proper names). The gap is six words, so read it as "no worse", not as proof of better. Warm decode took a median of 0.45 to 0.60 s for the default and 0.55 to 0.70 s for the unified model; it is dominated by a Python decoding loop that the loaded CPU slows, and the unified model's grows faster with the length of the utterance (about 0.85 s against 0.5 to 0.65 s for 10 to 15 seconds of speech). Your numbers on an idle machine will be several times lower.

### Streaming speech-to-text

`parakeet-unified-en-0.6b-streaming` keeps the speech-to-text protocol as it is. The sidecar holds the decoder state for each utterance and, each time the audio of that utterance grows, steps only through the new audio. Partials (`sttPartials`) are therefore cheap, though they trail the speech: a partial shows text only up to about the right context (about 1.1 s) behind the live audio, where an offline partial decodes everything heard so far, so the voice view's live transcript lags a little more. The final is complete either way. By the time the voice detector ends the utterance every chunk but the last is already decoded. The silent tail the voice endpoint already waits for (700 ms or more) serves as the last chunk's right context, so the final does not wait for more audio.

Measured through the real sidecar server on one workstation with a 16 GB NVIDIA GPU and a busy CPU, in real time, with a partial every 400 ms and a 700 ms silent tail, warm, median of six runs. `sttMs` is the time from the end of speech to the final text; "load" is the host's load average over the run:

| Utterance | Load | Offline `sttMs` | Streaming `sttMs` |
|---|---|---|---|
| 3 s | 28 to 37 | 414 ms | 42 ms |
| 10 s | 28 to 37 | 636 ms | 57 ms |
| 30 s | 28 to 37 | 912 ms | 37 ms |
| 3 s | 4 to 16 | 303 ms | 37 ms |
| 10 s | 4 to 16 | 364 ms | 39 ms |
| 30 s | 4 to 16 | 603 ms | 39 ms |

Cold (the first utterance after the sidecar starts, no warm-up, one run each, so only indicative): streaming took 39 to 46 ms at 3 s and 10 s in every run. Offline took anywhere from 0.25 s (3 s of speech) and 0.41 s (10 s) at a load of about 16, to 0.5 s, 1.2 s and 1.3 s (3, 10 and 30 s) on an earlier, busier run whose load was not recorded: how much the first offline decode costs depends on the host and the state of the GPU. The one-off graph planning of streaming happens in the partials, while the person is still speaking.

The offline numbers above are from before the GPU run was padded. The CUDA execution provider plans the model's graph again for every input length it has not just seen, which cost about 200 ms on each utterance of a new length, against 35 to 150 ms for the run itself. On the GPU the sidecar now pads the audio with silence to the next of 4, 8, 12, 16, 24 or 32 seconds and tells the model the real length, the way a padded batch does, and runs one throwaway decode at each of those lengths when it loads (about two seconds more at start-up). Longer utterances keep their own length. Measured the same way, warm, median of six runs at a load of about 20 to 25: the unified model's final fell from 332 to 63 ms at 3 s and from 441 to 180 ms at 10 s, and the default model's from 236 to 39 ms and from 336 to 93 ms. The unified model gave the same text on all 73 clips; the default model gave the same words on all 73 and lost the sentence punctuation on one clip (three marks), a difference any amount of padding makes there. The CPU is not padded: it has no such cost.

Accuracy, on the same 73 LibriSpeech clips (1,150 words): offline 27 word errors (2.35%), or 28 with a 700 ms silent tail; streaming 32 (2.78%), with or without the tail. The 4 to 5 extra errors fall on 11 of the 73 clips and go both ways (streaming was better on four of them, worse on seven), mostly proper names and word forms ("Calico" for "Kaliko", "scepter" for "sceptre"), so treat it as a small accuracy cost of a fraction of a percentage point, not as a clear loss. NVIDIA's own table for this setting is 6.29 against 5.91 word error rate, the same direction.

On a CPU the int8 streaming model gave correct text on 8 short clips (2 errors in 95 words, both in one three-second clip), with the final step taking 0.9 to 2.0 s on a host with a load average of about 15 and four threads. No offline int8 Unified model was installed to compare against, so there is no CPU speed claim: measure on your own machine before choosing it without a GPU.

The streaming graphs come from a third party's sherpa-onnx conversion of NVIDIA's model; the gateway loads them with the same `onnx-asr` runtime as the other models and does not need `sherpa-onnx`.

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
| `stt.model` | per provider | `local`: `parakeet-tdt-0.6b-v2` (default), `parakeet-unified-en-0.6b` or `parakeet-unified-en-0.6b-streaming`, and nothing else; `openai`: `gpt-live-transcribe`; `openai-compatible`: `whisper-1`, or whatever name the server uses. |
| `stt.baseUrl` | — | Required for `openai-compatible`: the server's root, without `/v1`. http or https. |
| `stt.apiKey` | — | A `${VAR}` reference to an environment variable. A literal key is refused. |
| `tts.provider` | `local` | As for `stt.provider`. |
| `tts.model` | per provider | `local`: `kokoro-v1.0`; `openai`: `gpt-4o-mini-tts`; `openai-compatible`: `tts-1`. |
| `tts.voice` | `local`: `af_heart`; `openai`, `openai-compatible`: `marin`, `alloy` | The voice. |
| `tts.speed` | `1.0` | How fast the assistant speaks its replies, as a multiplier of the voice's natural pace: 0.5 to 2. A change applies to the next sentence spoken, with no restart. See [Speaking speed](#speaking-speed). |
| `tts.baseUrl`, `tts.apiKey` | — | As for `stt`. |
| `vad.threshold` | `0.5` | Speech probability that counts as speech, 0 to 1. Raise it if knocks and taps start utterances. |
| `vad.minSpeechMs` | `250` | Speech must last this long, unbroken, to start an utterance, 50 to 2000, so a knock or a tap that is shorter never counts. Raise it if short noises still get through; a short word such as "yes" or "stop" is voiced for roughly 300 to 500 ms, so keep it under that. |
| `vad.silenceMs` | `1000` | Silence that ends an utterance, 200 to 5000. A shorter pause than this does not end your turn; lower it for a snappier reply, raise it if the assistant still cuts in on your pauses. |
| `vad.unfinishedHoldMs` | `800` | Extra silence waited when the words so far look unfinished (they trail off on "and", "the", "to", a comma, "um" and the like), so a pause to think does not end the turn. Speaking again inside it continues the same utterance. It works from the live transcript, so it helps when the words end on such a word ("book a table and"); a pause after a finished-looking sentence is ended by `vad.silenceMs` alone. 0 turns it off, up to 5000. Hands-free only; push-to-talk ends when you release. |
| `vad.prerollMs` | `300` | Audio kept from before speech was detected, 0 to 1000. |
| `filter.minConfidence` | `0.3` | A transcript the provider is less sure of than this is dropped, 0 to 1 (0 turns it off). See [Noise and phantom words](#noise-and-phantom-words). |
| `filter.noSpeechThreshold` | `0.8` | A transcript the provider says is probably not speech, above this chance, is dropped when the provider gave no confidence for it (a confident transcript is kept, as Whisper itself keeps it; a low-confidence one is already dropped by `filter.minConfidence`), 0 to 1 (1 turns it off). |
| `filter.phantomMaxMs` | `500` | A clip whose speech (summed over its stretches of speech, first voiced frame to last) lasted less than this many ms, whose whole transcript is one of `filter.phantomPhrases`, is dropped, 0 to 5000 (0 turns the list off). |
| `filter.phantomPhrases` | `you`, `thank you`, `thanks for watching`, `amen`, `uh`, `um`, `hmm`, `mm`, `mhm`, `huh`, `oh`, `ah` | The words speech to text invents out of noise. Matched on the whole transcript, ignoring case and punctuation. `[]` turns the list off. |
| `bargeIn.enabled` | `true` | Whether speaking over the assistant stops it. |
| `bargeIn.minSpeechMs` | `250` | How long your voice must be heard over playback before playback stops, 50 to 2000. |
| `bargeIn.onsetThreshold` | `0.02` | Loudness (RMS, 0 to 1) the browser's detector treats as you speaking. Raise it if speakers cause false stops. |
| `autoBackground.enabled` | `true` | Move long work to the background when you speak, where the engine can (see below). |
| `autoBackground.afterSeconds` | `5` | A tool call older than this when you speak is long work, 1 to 600. |
| `cues.enabled` | `true` | Soft sound cues while the assistant is thinking and while it runs a tool (see "Sound cues"). `false` turns them off. |
| `cues.volume` | `0.3` | How loud the cues are, 0 (silent) to 1. Even 1 is a soft note. |
| `prompt` | built in | The spoken-conversation instructions, at most 8000 characters. |
| `promptFile` | — | A path inside the instance home holding the instructions, read the first time the voice config is resolved and again whenever the `voice:` block changes (not only when the gateway starts). `prompt` wins if both are set. |
| `stylePrompt` | — | Your own directions for how spoken replies sound, added to the voice instructions on every voice turn, in the browser and the app. At most 2000 characters; empty or unset changes nothing. It is read on each turn, so a config reload applies it to the next spoken turn, even in a conversation already open (no gateway restart). Also editable in Settings, under Voice style, once voice mode is on. Example below. |
| `holdingLine` | "Still working on the last thing. I'll come to that as soon as it's done." | Spoken when your message has to wait behind long work. At most 300 characters. |
| `limits.maxUtteranceSeconds` | `60` | Longest single utterance, 5 to 120 (the local speech-to-text takes at most about 130 seconds of one utterance). The offline local models need GPU memory that grows with the length: about 3.5 GB in all for a minute of speech and 5 to 7 GB for two minutes, most of it kept after the run. On a GPU that other programs share, a long utterance can fail with "the GPU ran out of memory"; lower this limit, use the streaming model (its memory does not grow with the utterance), or free the GPU. |
| `limits.maxConcurrentAttachments` | `4` | Chats in voice mode at once, 1 to 64. A chat whose connection dropped and has not come back does not count against a new one: it is let go when the limit is reached. |
| `local.device` | `auto` | `auto` uses the GPU when `nvidia-smi` lists one; or `gpu`, or `cpu`. |

### Voice style

`stylePrompt` is for taste, `prompt` is for replacing the instructions. The built-in instructions stay in place and your text is added to them, so the replies keep their spoken shape and take on your voice:

```yaml
voice:
  enabled: true
  stylePrompt: >-
    Replies much shorter, more personal, a bit funny. Make jokes.
```

The first spoken turn of a conversation carries the full instructions with your directions under "Style directions from the user"; every later turn carries them again as one line next to the short reminder (a multi-line style is joined into one line there). That line says it replaces any earlier style directions, so an edit takes effect in a conversation already open; clearing the style sends one line saying to ignore the earlier directions. Typed messages never carry the style, and neither does a message that starts with `/`. Voice mode starts with the gateway, so turning `voice.enabled` on needs a restart before the first spoken turn; after that, edits to the style need none.

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

`apiKey` is optional here. Speech-to-text is batch, and asks for `verbose_json` so [phantom words](#noise-and-phantom-words) can be told from speech: the whole utterance is sent when you stop, so no partial transcripts. Text-to-speech asks for `pcm`, then `wav`; a server that can only return MP3 is refused with a message saying so. Audio at another sample rate is converted to 24 kHz.

### Voice activity detection with a hosted provider

The gateway decides when you have stopped speaking. With the local models installed it uses Silero, even when speech-to-text is hosted. Without them it falls back to a simple in-process loudness detector, which is less accurate: a fan or a keyboard can start an utterance. Install the local models if you use a hosted provider with a noisy room.

## Noise and phantom words

A knock, a bump or a tap can get past voice activity detection, and speech to text then writes words for it ("Thank you", "Amen", a lone "You"), which would be sent to the assistant as if you had said them. Three checks stand between a noise and the chat, in this order; an utterance that fails one is dropped like silence: nothing is dispatched, the transcript line is empty, and an assistant you interrupted carries on speaking. The gateway log says why, with numbers and never your words.

1. **The detector.** `vad.threshold` and `vad.minSpeechMs` decide what starts an utterance at all; a transient shorter than `minSpeechMs` never does.
2. **What the provider reports.** A provider that says how sure it was is believed: a transcript with a confidence below `filter.minConfidence` is dropped, and so is one with a no-speech chance above `filter.noSpeechThreshold` when no confidence came with it. A high no-speech chance next to a high confidence is not enough to drop it, because Whisper-style servers often report one for short clips they decoded well. Only `openai-compatible` reports these today (it asks the server for `verbose_json`, which Whisper-style servers answer with a confidence and a no-speech chance per segment, and falls back to plain `json` for a server that refuses it). The local Parakeet models and OpenAI's Realtime transcription report neither, so for them only 1 and 3 apply.
3. **Known phantoms in a short clip.** A clip whose speech, from the detector's first voiced frame to its last (summed over its stretches of speech when it resumed inside an unfinished-speech hold), lasted under `filter.phantomMaxMs` whose whole transcript is in `filter.phantomPhrases` is dropped. The same words in a longer clip go through: "thank you" said on purpose lasts longer than a knock. Push-to-talk has no detector, so this check does not apply to it.

Tuning: if a real short reply is ever dropped, lower `filter.minConfidence` and `filter.phantomMaxMs`, or remove its phrase from `filter.phantomPhrases` (the default list holds only "you", "thank you" and similar, never "yes" or "stop"); if phantoms still get through, raise `vad.threshold` or `vad.minSpeechMs`, or add the phrases you see to `filter.phantomPhrases`. A change applies to a voice conversation opened after it (a conversation already open keeps the settings it started with).

```yaml
voice:
  enabled: true
  vad: { threshold: 0.6, minSpeechMs: 300 }
  filter:
    minConfidence: 0.35
    phantomPhrases: [you, thank you, amen, bye]
```

## Speaking speed

`voice.tts.speed` sets how fast the assistant speaks its replies; it is not how soon a reply starts. `1.0` is the voice's natural pace, `1.5` is half as fast again, `0.8` is slower. Any number from 0.5 to 2 is accepted; anything else (`3`, `fast`, `0`) stops the configuration loading, with a message naming `voice.tts.speed`, the range, and what it got. Leave the key out for the natural pace.

```yaml
voice:
  enabled: true
  tts: { speed: 1.25 }
```

In the web app, **Settings → Voice → Voice mode → Speaking speed** writes the same key. It offers Slower (0.8×), Normal (1×), Faster (1.25×) and Fastest (1.5×); a value you put in the file that is none of these shows as "Custom" and is left alone until you pick another. Both write `voice.tts.speed`, so the file and the control never disagree.

The gateway reads the setting for every sentence it speaks, so a change made while voice mode is open (in the settings, or in the file when the configuration reloads) is heard from the next sentence; a sentence already being made or played keeps the speed it had. The web and the mobile app speak at the speed the gateway sends, so nothing in either needs setting or restarting.

Where the pace is applied:

| Voice | How |
|---|---|
| Local (Kokoro) | Kokoro is asked to speak at the speed, which changes the pace of the voice itself. |
| OpenAI `tts-1`, `tts-1-hd`, and OpenAI-compatible servers | The speed goes in the speech request's `speed` field, which these apply. |
| OpenAI `gpt-4o-mini-tts` (the OpenAI default) | OpenAI accepts `speed` for this model and ignores it. The gateway asks for the natural pace and speeds the audio up itself, keeping the pitch (a time stretch), so the voice does not turn chipmunk. It sounds a little less natural than a voice made at that speed, more so past 1.5. |

The pace is applied on the gateway rather than as a playback rate in each client because everything that depends on how much of a reply was heard is measured on the audio the client plays: the words recorded as spoken, what is read out again after you interrupt, and when you speak over the assistant. That audio is the sped-up audio, so those stay right at any speed. A playback rate in the client would make the time played differ from the audio sent, and each client would have to correct for it. An OpenAI-compatible server is assumed to apply `speed` (Kokoro and Speaches do); if yours ignores it, point `tts.model` at one that does.

## Voices

The local voices are Kokoro's: `af_*` and `am_*` are American English female and male, `bf_*` and `bm_*` British. `GET /api/voice/config` lists the installed ones under `tts.voices`. Set `tts.voice` to one, for example `af_heart` (the default), `af_bella`, `am_michael` or `bf_emma`. A name that is not in the list makes the text-to-speech report itself unavailable and say which voice it could not find.

## Model licences

The gateway does not ship the models; it downloads them on first use.

- **Parakeet TDT 0.6B v2** (speech-to-text): NVIDIA's model, converted to ONNX by a third party under CC-BY-4.0; see NVIDIA's model card for its community model licence.
- **Parakeet Unified 0.6B (English)**, offline and streaming (speech-to-text, opt-in): NVIDIA's model, governed by the [NVIDIA Open Model License Agreement](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/): commercial use is allowed, and NVIDIA claims no rights in what it transcribes. Passing the model on to others requires a copy of that agreement and the notice "Licensed by NVIDIA Corporation under the NVIDIA Open Model License"; the gateway does not do that, because it does not ship the model: the install fetches the third-party ONNX conversions ([the encoder and decoder](https://huggingface.co/eschmidbauer/parakeet-unified-en-0.6b-onnx) and [the vocabulary](https://huggingface.co/mrfakename/parakeet-unified-ONNX), both marked with that licence; for the streaming model also [its encoder graph](https://huggingface.co/csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-streaming-1120ms), whose repository has no licence metadata; its safety note cites the same NVIDIA licence) from Hugging Face straight onto your machine, so the agreement is between you and NVIDIA. One of the conversions the install does not use is labelled CC-BY-4.0 on its page, which is not what NVIDIA's own model card says; the agreement is the one that applies. You must not bypass or disable the model's guardrails without an equivalent of your own, and your licence ends if you sue anyone claiming the model infringes a patent or copyright.
- **Kokoro-82M v1.0** (text-to-speech): Apache-2.0.
- **Silero VAD**: MIT.

## Starting voice on a new chat

The voice control is on a new chat too, before anything is typed. Tapping it asks for the microphone, creates the chat with the composer's current employee, engine, model and effort, opens it, and attaches voice to it. The first thing you say becomes the chat's first message, and names it the way a typed first message would (a first message typed instead names it the same way); nothing is sent to the engine until you speak.

The web does this with `POST /api/sessions` and `{ "speech": true }` and no `prompt`. The gateway accepts that form only from the operator: it creates the chat idle (same employee, engine, model, effort and fallback resolution and the same permission checks as a prompted create, but no message and no turn) and answers `201` with the usual session body. Any other caller, and any request without `speech: true`, still gets `400 prompt or message is required`.

A voice conversation that ends on such a chat before a message was spoken (hang up, a clean close, the ten-minute resume window running out, voice turned off) deletes the empty chat on the gateway, so nothing is left behind. A chat that never gets a voice connection at all (the tab closed between the two requests) stays as an empty chat and can be deleted like any other.

## Hanging up by voice

Say "hang up" or "end the call" and the assistant ends the voice call itself, with no need to reach for the control. It does it with the built-in `end_voice_call` tool, which says a short goodbye first: the call ends once the turn that called the tool is over and the goodbye has been heard, so the microphone and the speaker stop on their own. The client is told with `detached { reason: "ended" }`, and nothing shows as an error.

What it ends, and what it does not:

- It ends the **call**, not the chat. The chat, its messages and its engine are untouched; start voice again, or type, and the conversation carries on. (A chat made for a spoken start that never got a message is still removed, as for any other end of the call.)
- It acts on the calling session's own call only. The tool takes no session id, so a session cannot hang up another chat's call, and a call by the operator or by a tool call that lost its identity is refused (`403`).
- With no call open (typed chat, or voice off) it fails with `409` and the assistant answers in text instead. The tool is on the built-in server for every session because an engine's tool list is fixed when it starts, before any call exists, so it cannot appear only during a call.
- There is no spoken "are you sure": an instruction to hang up is clear, ending a call costs nothing (start another), and a confirmation round trip in a hands-free call is worse than the mistake. The tool's own description and the built-in voice prompt limit it to a clear request. If you start speaking while the goodbye is still pending, the hang-up waits to hear what you say: words drop it and the call stays; noise or a failed recognition lets it go through after the goodbye. If the client never reports the goodbye played (an older build, a lost frame), the call ends 20 seconds after the turn does.
- The request is not lost on the way: if the phone drops the connection while it is pending, the call ends as soon as the client reconnects (it is told `ended` instead of `ready`); if a second tab takes the call over, the hang-up carries over to it; and a request that is never followed by the end of its turn lapses after five minutes rather than ending some later turn.
- A custom `voice.prompt` replaces the built-in instructions, including the line that names the tool; the tool's description still tells the assistant what it is for.

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

- **Thinking:** one soft, low note (about G4) every 1.6 seconds, while the model is working and nothing is being spoken yet.
- **Tool:** a pair of soft notes, the second a little higher (about F4 then A4), every 1.8 seconds, while a tool is running. It takes over from the thinking note at the first tool call and gives it back when the tool returns.

Both are made on the device (a plain sine note that swells and fades gently, with no overtones; no audio file and no network), in the web app and in the mobile app, and the first note comes about a third of a second after the state starts, so a brief pause makes no sound. They follow the gateway's own `turn`, `vad` and `background` frames, not a guess made on the client.

**They stop at once** when the assistant starts to speak (a reply or the holding line, from the moment the gateway announces the sentence), when you are heard speaking (the gateway's voice activity, a partial transcript, or push-to-talk held), when the turn ends, and when voice mode stops, is suspended by the device or is paused by a call. A cue that was silenced for speech starts again if the work is still going when the speech has played out.

**Long work moved to the background:** when a tool call is moved to the background (see above), the tool sound stops and the thinking sound takes its place until the turn ends, since the assistant is free to answer. Background work that keeps running after the turn has ended is silent; the chat shows it as moved and still running. The hand-over is approximate: the gateway's `background` frame does not name the tool call, so a task moved while a different tool is running also switches the sound early.

**Settings:** Settings, Voice mode, has a switch and a volume slider; the same keys are `voice.cues.enabled` and `voice.cues.volume` in `config.yaml`. They are on at a low volume by default, apply the next time voice mode starts, and a config with no `cues` block, or one with stale keys, loads and uses the defaults.

**Why a cue cannot trigger the microphone.** The phone or computer can hear its own speaker, so this is guarded in four ways:

1. A cue never goes through the speech player. Barge-in only listens while speech is playing (browser, Android and iOS alike), and a cue is never playing then, so a cue is never taken for you interrupting.
2. The gateway only hears a cue if it leaks into the microphone, and the cue is built not to look like speech to it: notes of 110 to 140 milliseconds with long gaps, at most -16 dBFS at volume 1 and about -26 dBFS at the default, well under the 250 ms hold that starts an utterance. The echo canceller of the browser, Android and iOS removes most of it before that.
3. A cue that is playing is silenced the moment the gateway says it hears you, so it never sits under your own voice for long.
4. Its audio is on a player of its own, on the same audio session as the microphone, so the platform's echo canceller knows it is output.

Measured against the real Silero detector on a gateway, with the cue played straight into the microphone uplink and no echo cancelling at all: each cue at volume 1 for 20 seconds (about 0.07 RMS, above the default onset level for the 110 to 140 ms of each note, never for 250 ms), and a cue at five times that level (about 0.35 RMS), started no utterance, no transcript and no `stop_playback`, while a spoken sentence at normal level did. If a loud room or an open speaker still sets it off on your setup, lower `cues.volume` or turn the cues off.

## The screen is locked

| Platform | Browser | Hundredfold mobile app |
|---|---|---|
| Desktop browser, tab in the background | Keeps listening and speaking while the page runs. | — |
| iPhone and iPad | Safari suspends the page's microphone and audio when the screen locks. On return you are told voice mode was suspended, replies that finished meanwhile are spoken, and listening resumes (a tap if the browser asks for one). | Keeps listening, speaking and accepting interruptions with the screen locked, with a lock-screen control to stop it. |
| Android | Varies by browser and version: some keep the page running, some suspend it, and the same recovery applies. | Keeps listening, speaking and accepting interruptions with the screen locked, with a notification that has a Stop action. |

## Dictation

The dictation microphones in Notes and Todo quick capture, and the voice notes the Telegram connector transcribes, use voice mode's speech-to-text. There is no second speech engine to install or configure: whichever provider `voice.stt` names (the local Parakeet, OpenAI, or an OpenAI-compatible server) transcribes them, in `voice.language`.

- **Voice mode must be set up.** While `voice.enabled` is off, or the speech-to-text provider is not ready (for example the local models are still installing), a dictation mic says so and links to Settings. It does not need the gateway restarted the way starting a voice conversation does, and it works while only the speech half of voice mode is ready.
- **How it works.** The browser decodes its recording to 16 kHz mono 16-bit audio and posts it to `POST /api/voice/transcribe` (optional `?language=`; at most 20 minutes). The gateway cuts a long recording into segments of about a minute, at the quietest moment near each cut, and joins the text. The reply is `{ "text": "…" }`; it answers 409 with the reason while voice mode is off or not ready.
- **Telegram voice notes** arrive as Ogg/Opus, so decoding them needs `ffmpeg` on the gateway machine. It is optional: without it, the bot replies that it cannot decode the audio. Voice mode itself never needs it.
- **Removed:** the separate whisper.cpp engine (`whisper-cli`, a downloaded ggml model, the Settings "Dictation" section and its language list) and `/api/stt/*`. A `stt:` block in `config.yaml` is ignored. Model files already downloaded stay under `~/.hundredfold/models/whisper/` and can be deleted by hand.

## Diagnosing with the logs

Every stage of a spoken turn writes one line per event, in the form `[voice] event=<name> key=value ...`, with ids, counts, lengths and milliseconds, never the words spoken or a credential.

- **Gateway** (`logs/gateway.log`): `grep -E '\[voice(-sidecar)?\]' gateway.log`. One conversation is `grep 'att=<id>'`. The default level (`info`) is enough to follow a turn: `hello`, `ready_sent`, `utterance_open`, `stt_final`, `dispatch_plan`, `reply_start`, `segment_queued`, `synth_start`, `synth_end`, `segment_start`, `segment_end`, `reply_spoken`, and for an interruption `client_barge_in`, `pipeline_cut`, `barge_in_begin`, `barge_in_resume`. Each `segment_end` and `synth_end` carries frames, bytes, audio milliseconds and timings. Set the log level to `debug` to add every audio frame and provider chunk. Read-aloud (`/api/tts`) logs `tts_stream_*` and `kokoro_synth` lines, with the WAV's own rate and length.
- **Web app:** lines are in the browser console and behind the mobile menu's "Share debug log". Add `?voice_debug=1` to the address, or run `window.__voiceDebug(true)` in the console, for per-chunk lines.
- **Mobile app:** see "Diagnostic logs" in `packages/shell/README.md` (Console.app or `log stream` on iPhone, `adb logcat -s HundredfoldVoice` on Android).

A cut-off or garbled reply is easiest to read from the per-segment summaries: `segment_end` on the gateway, `segment_summary` in the web app and `segment_received` / `segment_outcome` in the mobile app should agree on frames and audio milliseconds, and `reply_spoken` compares the characters the reply had with the characters that were spoken.

## Cost

- **Local:** free; it uses the gateway machine's CPU or GPU and disk.
- **OpenAI:** billed by OpenAI per its price list for the models you choose. Cost is bounded by `limits.maxUtteranceSeconds` and `limits.maxConcurrentAttachments`; nothing is spent unless `enabled: true` names a hosted provider and someone is in voice mode.
- **OpenAI-compatible:** whatever your server costs to run.
- **Model usage:** every spoken turn is an ordinary message to the session's engine and costs what a typed one costs. The instructions added to a spoken turn are small.
