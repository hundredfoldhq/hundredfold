# Feature Specification: Voice Mode for a Chat

**Feature Branch**: `feat/voice-mode`

**Created**: 2026-11-22

**Status**: Approved with changes at the spec review gate (2026-11-22)

**Input**: "Add a voice conversation mode to Hundredfold, like the voice modes in ChatGPT
and Claude: the user talks, Hundredfold listens and transcribes, sends the text to the
session's model, the model thinks, and the reply comes back spoken (and shown as text).
Everything streams through the gateway, and all of it is configurable so anyone running
their own gateway can turn it on with their own providers. Partial transcripts while the
user speaks; the reply streamed as it is produced, speech starting on the first sentence.
Interruptible (barge-in). Long-running work moves to the background when the user talks,
and the agent picks the result up when it finishes. A configurable voice prompt. A
`voice:` config section, off by default, with pluggable providers: at least one hosted
option and one self-hostable option. Web UI first, working on mobile browsers."

## Problem

A chat with a session is typed today. The gateway already has three speech pieces, and
none of them is a spoken conversation with a session:

- **Dictation** (`POST /api/stt/transcribe`, `packages/hundredfold/src/stt/stt.ts`):
  records a clip, transcribes it on the gateway with a local Whisper binary, and puts the
  text in the composer. One clip at a time, no partial text, nothing spoken back.
- **Read-aloud** (`/api/tts`, `packages/hundredfold/src/gateway/talk-tts-api.ts`): speaks
  one finished message on request through a local Kokoro sidecar, sentence by sentence.
  It does not follow a reply while it is being written.
- **Talk** (`docs/talk-session-runtime.md`): a realtime speech-to-speech model that acts
  as a company-control front end. The browser connects straight to the hosted provider
  with a short-lived credential, and the voice model, not the session's own engine,
  decides what to say. It does not let the user talk to a chosen session's engine and
  model, and its audio does not pass through the gateway.

Nothing lets a user hold a conversation by voice with the session they are looking at,
answered by that session's own engine and model. Talking over the reply has nothing to
stop. Speaking while the session runs a long command cannot be handled without either
waiting for the command or cutting it off. On the Claude engine today a message that
interrupts a turn ends the engine process (`InteractiveClaudeEngine.kill`, which releases
the terminal), and any command running in it ends too.

Constitution, Principle II: this feature is mainly a surface for the people using the gateway (rung 4).
One part reaches rung 3: when the user speaks during long work, the system decides on its
own to move that work to the background and to bring its result back into the
conversation, a loop the operator closes by hand today. The plan states why it stops
there.

## Clarifications

### Session 2026-11-22 (spec review gate)

- Q: Who can use voice mode? → A: The operator **and board members**, from the first
  release onward.
- Q: Which built-in local providers? → A: Speech-to-text "Parakeet style", NVIDIA
  Parakeet TDT 0.6B v2. English only is required. Text-to-speech: a comparable local
  model that is above all **nice to listen to**. Chosen: Kokoro-82M (see Assumptions),
  with the default voice picked by the operator from recorded samples.
- Q: Hands-free or push-to-talk by default? → A: Hands-free, confirmed.
- Q: What about a locked phone? → A: Voice mode **must keep working with the phone's
  screen locked**. The operator asked whether this can be supported or is down to the
  device. Answer recorded in User Story 5 and Assumptions: a web page cannot keep the
  microphone on iOS once the screen locks, so a locked iPhone needs the Hundredfold
  mobile app.
- Q: Engines without background work (item 4 of the review)? → A: Accepted as specified.
- Install whatever the build host needs, and document it as pre-installation steps in
  the feature's documentation.

## Glossary

- **Voice mode**: the state of a chat in which the user's speech is the input and the
  assistant's replies are spoken as well as shown.
- **Utterance**: one stretch of the user's speech, from when they start talking until a
  pause long enough to count as the end of what they said.
- **Partial transcript**: text for an utterance still in progress, which may change.
  **Final transcript**: the settled text once the utterance has ended.
- **Speech provider**: a service that turns speech into text (STT) or text into speech
  (TTS). **Hosted**: run by a third party and usually billed. **Self-hosted**: run by
  whoever runs the gateway, on their own machine or network.
- **Barge-in**: the user starting to speak while the assistant is speaking or working.
- **Long work**: a tool call or command, started by the session in the course of a
  reply, that has been running longer than the configured threshold.
- **Backgrounding**: moving long work out of the way of the conversation so that it keeps
  running while the session takes the user's new utterance, with its result brought back
  into the conversation when it finishes.
- **Voice prompt**: the instructions a session is given for how to speak in voice mode.
- **Time to first audio**: the time from the end of the user's utterance to the first
  sound of the reply.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hold a spoken back-and-forth with a session (Priority: P1)

A user (the user, or a board member on a chat they may use) opens a chat on a gateway
where voice is configured and turns voice mode on.
They speak. While they talk, their words appear as they are recognised. When they stop,
the settled text is sent to the session like a typed message. The reply appears as text
as usual and is spoken at the same time, starting with its first sentence while the rest
is still being written. When the reply ends, the session is listening again and the
user can carry on talking.

**Why this priority**: it is the feature. Every other story builds on a working spoken
round trip, and on its own it already lets someone use a session hands-free.

**Independent Test**: on a gateway with voice configured to a self-hosted provider, open
a chat, turn voice mode on, say a question, and confirm that the partial text shows
while speaking, the question lands in the chat as the user's message, the reply is heard
before it has finished rendering, and the time to first audio is shown.

**Acceptance Scenarios**:

1. **Given** voice is configured and a chat is open, **When** the user turns voice
   mode on and speaks, **Then** partial text of their speech appears while they talk.
2. **Given** the user has stopped speaking, **When** the utterance ends, **Then** its
   final text is sent to the session exactly as a typed message would be, and is marked
   in the chat as spoken.
3. **Given** the session is writing its reply, **When** the first sentence is complete,
   **Then** that sentence is heard while later sentences are still being produced.
4. **Given** a reply contains code, a table, a path or a link, **When** it is spoken,
   **Then** that content is not read out, and it stays in the chat as text.
5. **Given** a spoken exchange has completed, **When** the user looks at the chat,
   **Then** the time to first audio for that exchange is reported.
6. **Given** voice mode is on, **When** the user turns it off, leaves the chat or
   closes the page, **Then** listening and playback stop and nothing more is captured.

---

### User Story 2 - Interrupt the assistant by talking over it (Priority: P1)

While the assistant is speaking, the user starts talking. The speech stops at once.
What the user says is handled as their next message, the same as sending a new
message in the middle of a turn. The chat shows how much of the interrupted reply was
actually heard. If the "interruption" turns out to be a cough or background noise with
no words in it, the assistant carries on from where it stopped.

**Why this priority**: without barge-in a spoken conversation is a walkie-talkie. It is
named in the acceptance of the request and must be shown on video.

**Independent Test**: start a reply that takes several sentences to speak, talk over it
after the first sentence, and confirm that playback stops within the time in SC-003, the
new utterance becomes the next message, the interrupted reply shows what was heard, and
the session answers the new utterance.

**Acceptance Scenarios**:

1. **Given** the assistant is speaking, **When** the user starts talking, **Then**
   playback stops within the time in SC-003.
2. **Given** playback stopped because the user talked, **When** their utterance ends
   with words in it, **Then** it is sent as their next message and the session answers
   it, and the session is told that it was interrupted and how far the user had heard.
3. **Given** playback stopped because the user talked, **When** the utterance ends
   with no words in it, **Then** nothing is sent and speech resumes from the first
   sentence that had not been heard.
4. **Given** a reply was interrupted, **When** the user reads the chat, **Then** the
   part that was not heard is visibly set apart from the part that was.
5. **Given** the assistant's own voice is coming out of the device's speaker, **When**
   nobody is talking, **Then** the assistant does not interrupt itself.

---

### User Story 3 - Keep talking while long work runs (Priority: P2)

The session starts a command that takes minutes, such as a full test run. The user
asks something else in the meantime. The long command does not stop and does not hold up
the conversation: it moves to the background, the session answers the new question, and
when the command finishes its result is brought back into the conversation and spoken.

**Why this priority**: it is what makes voice usable for development work, where long
commands are routine. It depends on Stories 1 and 2.

**Independent Test**: in voice mode, ask the session to run a command that takes well
over the threshold, speak a different question while it runs, and confirm that the
question is answered while the command keeps running, and that the command's result is
later spoken without the user asking again.

**Acceptance Scenarios**:

1. **Given** the session is running a command that has gone past the threshold, **When**
   the user speaks, **Then** the command keeps running, the session is told it was
   moved to the background, and the new utterance is answered without waiting for it.
2. **Given** a backgrounded command finishes, **When** voice mode is still on, **Then**
   the session takes up the result and its reply about it is spoken.
3. **Given** the session is running a command younger than the threshold, **When** the
   user speaks, **Then** the command is given until the threshold to finish on its
   own before anything is moved.
4. **Given** the session's engine cannot move work to the background, **When** the
   user speaks during long work, **Then** the long work is never stopped; the
   user hears a short spoken note that their message will be handled when the work
   is done, and it is.
5. **Given** a command was moved to the background, **When** the user looks at the
   chat, **Then** they can see that it was moved and that it is still running.

---

### User Story 4 - Turn voice on for my own gateway with my own providers (Priority: P2)

Someone running their own gateway turns voice on in the configuration file, chooses a
speech provider (a self-hosted one, a hosted one, or the default), and sets the voice,
language, listening sensitivity, interruption sensitivity, long-work threshold and voice
prompt. Provider keys stay on the gateway. With voice off or absent, the gateway and the
chat behave exactly as before.

**Why this priority**: the request asks for it explicitly, and without it nobody outside
one setup can use the feature. It is P2 because a P1 demo can run on the defaults.

**Independent Test**: start a gateway with no `voice` section and confirm that nothing in
the chat or the gateway's surface has changed; then add the section with a self-hosted
provider, reload, and confirm voice mode works and that no provider key appears in
anything the browser receives.

**Acceptance Scenarios**:

1. **Given** no `voice` section or voice disabled, **When** the gateway runs, **Then** no
   voice control appears in the chat and the gateway accepts no voice connection.
2. **Given** voice is enabled with no provider named, **When** the user uses voice
   mode, **Then** the built-in default runs and costs nothing.
3. **Given** a provider that needs a key, **When** the key is configured, **Then** it is
   given by reference to the gateway's environment, never written into the file in the
   clear by the feature, and never sent to the browser in any form.
4. **Given** an invalid `voice` section, **When** the gateway loads it, **Then** it says
   which setting is wrong and why, and voice stays off.
5. **Given** a configured provider is unavailable (not installed, wrong address, missing
   key), **When** the user opens a chat, **Then** the voice control says voice is
   unavailable and why, and the chat otherwise works normally.
6. **Given** the voice prompt is replaced in the configuration, **When** the session
   answers a spoken message, **Then** it follows the replacement prompt.

---

### User Story 5 - Use voice mode on a phone, with the screen locked (Priority: P2)

The user turns voice mode on from their phone, puts the phone in their pocket with the
screen locked, and keeps talking to the session. It keeps listening, keeps speaking, and
can still be interrupted. A control on the lock screen shows that voice mode is on and
stops it.

What a phone allows differs by platform. A web page in a mobile browser loses the
microphone when the screen locks on iOS, and no page can prevent that. Android browsers
are not consistent about it either. So the locked-screen experience is guaranteed in the
**Hundredfold mobile app**. In a mobile browser voice mode keeps going wherever the
browser allows. Where the browser suspends it, the user is told why, and on unlock voice
mode picks up again without losing a reply.

**Why this priority**: the user named it as key. It depends on Stories 1 and 2.

**Independent Test**: in the Hundredfold mobile app on a phone, turn voice mode on, lock
the screen, wait one minute, then hold a spoken exchange that includes one interruption,
and confirm it completes with the screen still locked. Separately, in a mobile browser,
lock the screen mid-reply, unlock, and confirm that voice mode says whether it was
suspended and that the finished reply can still be heard.

**Acceptance Scenarios**:

1. **Given** a mobile browser or the mobile app, **When** the user taps the voice
   control, **Then** audio capture and playback both start from that single tap.
2. **Given** voice mode is on in the mobile app, **When** the screen locks, **Then**
   listening, speaking and interruption all keep working until the user turns voice mode
   off.
3. **Given** voice mode is on with the screen locked or the app in the background,
   **When** the user looks at the lock screen, **Then** a control shows that voice mode
   is on and lets them stop it.
4. **Given** voice mode is on in a mobile browser, **When** the browser suspends the
   page on lock, **Then** on unlock the user is told that voice mode was suspended by
   the device, a reply that finished meanwhile is spoken, and voice mode carries on
   (with one tap where the browser demands a fresh gesture).
5. **Given** voice mode is on in a mobile browser that keeps the page running with the
   screen locked, **When** the screen locks, **Then** voice mode keeps working as in the
   app.

### Edge Cases

- The user speaks while no reply is running: the utterance is a new message.
- The same person opens the same chat in a second tab or device and turns voice on there:
  the newer one takes over, and the older one is told voice moved and stops listening.
- A different person turns voice on for a chat already in voice mode: they are told
  someone else is using voice on it, and the existing voice mode is not disturbed.
- The phone locks in the middle of a reply: in the app the reply carries on; in a
  browser that suspends the page, the rest of the reply is spoken on unlock.
- A board member loses access to the chat (removed from the board, account disabled)
  while in voice mode: voice mode ends at once with a visible message.
- An utterance goes on past the configured maximum length: it is cut at the limit, what
  was captured is used, and the user is told it was cut.
- The speech provider fails in the middle of an utterance or a reply: the user is told
  that recognition or speech failed for that exchange; the session, the chat and voice
  mode carry on, and the reply is still shown as text.
- The network connection drops: voice mode shows it has stopped, and turning it back on
  starts cleanly. Nothing already sent is sent twice.
- A reply is started by the session itself while voice mode is on (a backgrounded command
  finished, a delegated task reported back): it is spoken too.
- The session is busy with work the user did not start by voice: the same barge-in
  and long-work rules apply.
- The gateway restarts during voice mode: voice mode stops with a visible message, and
  can be turned on again.
- The session is deleted or stopped while voice mode is on: voice mode ends with a
  visible message.
- The user's message starts with `/` (a command): it is sent unchanged, without voice
  instructions attached.
- Voice is turned off in the configuration while a chat is in voice mode: voice mode ends
  with a visible message.
- The user has no microphone, or refuses microphone permission: the voice control
  says so and offers nothing it cannot do.

## Requirements *(mandatory)*

### Functional Requirements

**Conversation**

- **FR-001**: Users MUST be able to turn voice mode on and off for the chat they are
  viewing, when voice is enabled and available.
- **FR-002**: The system MUST show partial transcripts while the user speaks, when the
  configured speech-to-text provider can produce them; where it cannot, it MUST show that
  it is listening and then the final transcript.
- **FR-003**: The system MUST decide when an utterance has ended from the user's pause,
  using the configured sensitivity, and MUST also offer a push-to-talk mode in which the
  user marks the start and end themselves.
- **FR-004**: The system MUST send each final transcript to the session as an ordinary
  message from the user, so that it is stored, shown and handled exactly as a typed
  message is, and MUST mark it as spoken.
- **FR-005**: The system MUST speak every assistant reply on a chat in voice mode,
  including replies the session starts on its own, and MUST begin speaking a reply once
  its first sentence is complete rather than when the reply is finished.
- **FR-006**: The system MUST NOT read aloud code, logs, tables, file paths, links or
  identifiers. These stay in the text of the reply.
- **FR-007**: The system MUST measure the time to first audio for each spoken exchange
  and show it to the user, and MUST keep it with the exchange so that it can be reported
  afterwards.
- **FR-008**: The system MUST stop capturing audio as soon as voice mode is turned off,
  the user leaves the chat, or the page or app is closed. A hidden page or a locked
  screen does NOT stop voice mode by itself (see FR-031 to FR-034).

**Interruption**

- **FR-009**: The system MUST stop playback as soon as the user starts speaking over the
  assistant, without waiting on the gateway or the provider.
- **FR-010**: The system MUST NOT end the session's running reply on the start of speech
  alone. It MUST wait for the utterance's final transcript, and if that has no words in
  it, MUST resume speaking from the first sentence the user had not heard.
- **FR-011**: When an interrupting utterance has words in it, the system MUST deliver it
  to the session as the user's next message, MUST tell the session that it was
  interrupted and how far the user had heard, and MUST record on the interrupted reply
  what was heard, so the chat can show the unheard part set apart.
- **FR-012**: The system MUST NOT let the assistant's own playback count as the user
  speaking.

**Long work**

- **FR-013**: The system MUST treat a tool call or command as long work once it has run
  longer than a configurable threshold, and when an utterance arrives during shorter
  work MUST let that work run until the threshold before acting on the utterance.
- **FR-014**: The system MUST NEVER stop long work because the user spoke.
- **FR-015**: Where the session's engine can move running work to the background, the
  system MUST do so when the user speaks during long work, MUST let the session take the
  new utterance at once, MUST tell the session the work was moved, and MUST show in the
  chat that it was moved and is still running.
- **FR-016**: When backgrounded work finishes, the session MUST be woken to take up its
  result, and the resulting reply MUST be spoken if voice mode is still on.
- **FR-017**: Where the session's engine cannot move running work to the background, the
  system MUST hand the utterance to the session at its next opportunity (or after the
  long work, where the engine offers no earlier opportunity), and MUST speak a short,
  configurable holding line straight away saying the message will be handled when the
  work is done.
- **FR-018**: For each supported engine, the documentation MUST say which of FR-015 or
  FR-017 applies.

**Voice prompt**

- **FR-019**: Spoken messages MUST carry instructions for spoken conversation (short,
  plain sentences; lead with the answer; no code or markup read out; summarise rather
  than recite; say briefly what it is doing before work that takes time; on being
  interrupted, answer the new utterance). The instructions MUST be replaceable by
  configuration, inline or from a file.
- **FR-020**: The voice instructions MUST NOT appear as part of the user's message in the
  chat or in its stored history, and MUST NOT be attached to a message that starts with
  `/`.

**Configuration and providers**

- **FR-021**: Voice MUST be off unless the configuration turns it on. With voice absent
  or off, the chat MUST show no voice control and the gateway MUST accept no voice
  connection and contact no speech provider.
- **FR-022**: The configuration MUST cover: on/off; hands-free or push-to-talk; language;
  for each of speech-to-text and text-to-speech, the provider, model and (for speech) the
  voice and speed, plus the endpoint address and key where the provider needs them;
  listening sensitivity and end-of-utterance pause; interruption on/off and sensitivity;
  long-work backgrounding on/off and threshold; the voice prompt (inline or a file); the
  holding line; the maximum utterance length; and the maximum number of chats in voice
  mode at once. Every setting MUST have a documented default.
- **FR-023**: The system MUST offer at least three providers for each of speech-to-text
  and text-to-speech: a built-in local one that needs no key and costs nothing, which is
  the default; one hosted provider; and one for any self-hosted service that speaks the
  widely used OpenAI-compatible audio interface. The built-in local providers MUST
  handle English, MUST use a GPU when the gateway's machine has a supported one and run
  on CPU otherwise, and MUST install their own runtime and models on first use without
  manual steps beyond the documented pre-installation requirements.
- **FR-023a**: The built-in local speech MUST be chosen for how pleasant it is to listen
  to, MUST offer several voices to choose from, and MUST default to the voice the
  operator picks from recorded samples.
- **FR-024**: Provider keys MUST be given by reference to the gateway's environment, in
  the same way the gateway's other provider keys are, and MUST NEVER be sent to the
  browser in any response, message or error.
- **FR-025**: The system MUST validate the `voice` section when it loads, MUST name each
  wrong setting and the reason, and MUST keep voice off while the section is invalid.
- **FR-026**: The system MUST tell the browser whether voice is available and, if not,
  why, without revealing any secret.
- **FR-027**: Voice mode MUST be available to the operator and to board members, each on
  exactly the sessions they are allowed to send messages to, checked when voice mode
  starts and again whenever their access changes. The system MUST bound utterance
  length, the size of what the browser sends, and the number of chats in voice mode at
  once.
- **FR-028**: Only one tab or device at a time MUST be in voice mode on a given session.
  A newer one belonging to the same person takes over and the older one is told. One
  belonging to someone else is refused while voice mode is in use.

**Web**

- **FR-029**: The voice control MUST be in the chat composer on desktop and mobile
  layouts, and MUST show the current state: listening, hearing, thinking, working (with
  what it is running), speaking, or unavailable (with why).
- **FR-030**: On mobile browsers and in the mobile app, one tap on the voice control MUST
  be enough to start both capture and playback.

**Locked screen and background**

- **FR-031**: In the Hundredfold mobile app (iOS and Android), voice mode MUST keep
  listening, speaking and accepting interruptions while the screen is locked or the app
  is in the background, until the user turns it off.
- **FR-032**: While voice mode runs with the screen locked or the page or app in the
  background, the system MUST show a lock-screen or notification control that says
  voice mode is on and stops it.
- **FR-033**: In a mobile browser, voice mode MUST keep running with the screen locked
  wherever the browser keeps the page running. Where the browser suspends the page, the
  system MUST, on return, tell the user that the device suspended voice mode, speak any
  reply that finished meanwhile, and carry on, asking for a tap only where the browser
  requires a fresh gesture.
- **FR-034**: The documentation MUST state, per platform, whether voice mode keeps
  working with the screen locked in the browser and in the app.

### Key Entities

- **Voice attachment**: one browser tab in voice mode on one session. It has the session,
  the mode (hands-free or push-to-talk), when it started, and its state (listening,
  hearing, thinking, working, speaking). It ends when voice mode is turned off, the tab
  goes away, a newer tab takes over, or the session goes away.
- **Utterance**: one stretch of user speech within an attachment. It has its partial and
  final text, its length, and the time to its final text. A final utterance with words
  becomes a user message.
- **Spoken segment**: one sentence of a reply as spoken. It has its text, the reply it
  belongs to, and whether it was heard in full, in part, or not at all.
- **Voice facts on a message**: on a user message, that it was spoken and by which
  provider; on an assistant message, what was heard, whether it was interrupted, and the
  time to first audio.
- **Backgrounded work**: a command or tool call moved out of the conversation's way. It
  has a description, when it started, and whether it has finished.
- **Speech provider**: a configured speech-to-text or text-to-speech service. It has an
  identity, whether it is available (and why not), whether it produces partial text, and
  any key given by reference.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the self-hosted default provider on the gateway's own machine, the
  median time to first audio over ten short spoken questions, measured from the end of
  the user's utterance to the first sound of the reply and excluding the model's own time
  to its first sentence, is under 1.5 seconds. The time with the model included is
  reported alongside.
- **SC-002**: Partial text for an utterance first appears within 1 second of the user
  starting to speak, when the provider supports partial text.
- **SC-003**: At default settings, playback stops within 500 milliseconds of the user
  starting to speak over the assistant, in ten out of ten attempts. (The default
  interruption sensitivity needs a short stretch of speech first, so that a click or a
  breath does not count; the time includes it.)
- **SC-004**: In ten interruptions made with only noise and no words, the assistant
  resumes speaking every time and no message is sent.
- **SC-005**: In a scripted run where the session starts a command lasting at least
  twice the threshold and the user then asks something else, the question is answered
  while the command is still running, and the command's result is later spoken without
  the user asking again.
- **SC-006**: With voice absent or off, the chat's appearance and the gateway's
  responses are unchanged from before the feature, and no voice connection is accepted.
- **SC-007**: No provider key appears in any response, message or error the browser
  receives, checked across every voice response and message in the test suite.
- **SC-008**: A recorded demonstration with sound shows a spoken round trip, an
  interruption, and a backgrounded long command whose result is spoken later.
- **SC-009**: Someone who has not used the feature can turn voice on with a self-hosted
  provider by following the documentation alone, in under 15 minutes.
- **SC-010**: In the Hundredfold mobile app on an iPhone and on an Android phone, with the
  screen locked for five minutes, a spoken exchange including one interruption completes
  without unlocking the phone.
- **SC-011**: A board member can hold a spoken exchange on a chat they may use, and is
  refused voice mode on a chat they may not use, in a test run with real accounts.
- **SC-012**: The default voice is the one the operator picks from recorded samples of
  the available voices.

## Assumptions

- **Who**: the operator and board members. A board member reaches only the sessions the
  board-member rules already let them message. Their connection to the gateway is
  default-deny today (it accepts only the main event stream), so voice needs an explicit,
  access-checked opening for them.
- **Default providers** (decided at the spec review gate): speech-to-text is NVIDIA
  **Parakeet TDT 0.6B v2** (English). Text-to-speech is **Kokoro-82M**, which leading
  open-model comparisons rate the most natural-sounding small model that also streams
  quickly on modest hardware. The repository already uses it for read-aloud. Measured on
  the build machine (16 GB workstation GPU, 2026-11-22): Parakeet transcribed a 3-second
  question exactly in 50 to 100 ms, and Kokoro spoke a short sentence in about 0.12 s
  and 4.4 s of speech in about 0.4 s. On that machine's heavily loaded CPU the same
  models were far slower (seconds), so the GPU is used when present and CPU-only
  latency is documented rather than promised. Both models download on first use, are
  free, and need no key. Choosing a paid default needs no operator decision. A hosted
  provider is opt-in by naming it. The local providers are English only. Other
  languages use a hosted or self-hosted provider.
- **Pre-installation**: the local providers need Python 3.10 or newer with its `venv`
  module on the gateway's machine, and, for the GPU path, an NVIDIA driver. The gateway
  installs the rest itself. The documentation lists these as required pre-installation
  steps, and they are installed on the build machine.
- **Hands-free by default**: voice mode listens continuously while it is on, and only
  speech, not silence, is sent on for recognition. Push-to-talk is available for noisy
  places. This follows the products the request names. A hosted provider bills only for
  speech sent to it, which keeps hands-free affordable.
- **Not Talk**: Talk stays as it is. Voice mode reuses the speech pieces Talk and
  read-aloud already have, and leaves Talk's own runtime alone.
- **Engines**: the full long-work behaviour (FR-015) is expected on the Claude engine,
  whose terminal client can move a running command to the background. The OpenCode 2.x
  engine can take a new message at its next step but has no background, so it gets
  FR-017. The other engines get FR-017 with the message held until the turn ends. Which
  engine gets which is confirmed against the real clients during planning.
- **Keys**: the gateway has no secrets store beyond referring to environment variables
  from the configuration file, which is how its other provider keys are given. Voice
  uses the same mechanism.
- **Browsers**: current desktop Chrome, Edge, Firefox and Safari, and current mobile
  Safari and Chrome, with microphone permission granted.
- **Locked screen**: iOS suspends a web page's microphone and audio when the screen
  locks or the browser goes to the background, and a page has no way to ask otherwise.
  This is reported consistently by developers and in Apple's developer forums; there is
  no web API for it. Android browsers behave inconsistently. Holding the microphone with
  the screen locked needs a native app that declares background audio (iOS) or runs a
  microphone foreground service (Android). The repository's Tauri shell
  (`packages/shell`) already has generated iOS and Android projects and its own gateway
  connection, so the native part of voice mode belongs there.
- **Building the mobile app**: an Android build can be made on the Linux build machine
  once the Android toolchain is installed. An iOS build and a run on an iPhone need a Mac
  with Xcode and an Apple developer team, which the build machine is not. The iOS half
  of FR-031 and SC-010 depends on access to one.
- **Connectors**: chat connectors other than the web UI are out of scope.
- **Cost**: hosted speech providers are billed by their vendors. The feature does not
  meter or cap that spend beyond the bounds in FR-027. Voice mode is off by default and
  the default providers are free.
