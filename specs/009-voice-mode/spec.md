# Feature Specification: Voice Mode for a Chat

**Feature Branch**: `feat/voice-mode`

**Created**: 2026-11-22

**Status**: Draft

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

Constitution, Principle II: this feature is mainly an operator-facing surface (rung 4).
One part reaches rung 3: when the user speaks during long work, the system decides on its
own to move that work to the background and to bring its result back into the
conversation, a loop the operator closes by hand today. The plan states why it stops
there.

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

The operator opens a chat on a gateway where voice is configured and turns voice mode on.
They speak. While they talk, their words appear as they are recognised. When they stop,
the settled text is sent to the session like a typed message. The reply appears as text
as usual and is spoken at the same time, starting with its first sentence while the rest
is still being written. When the reply ends, the session is listening again and the
operator can carry on talking.

**Why this priority**: it is the feature. Every other story builds on a working spoken
round trip, and on its own it already lets someone use a session hands-free.

**Independent Test**: on a gateway with voice configured to a self-hosted provider, open
a chat, turn voice mode on, say a question, and confirm that the partial text shows
while speaking, the question lands in the chat as the user's message, the reply is heard
before it has finished rendering, and the time to first audio is shown.

**Acceptance Scenarios**:

1. **Given** voice is configured and a chat is open, **When** the operator turns voice
   mode on and speaks, **Then** partial text of their speech appears while they talk.
2. **Given** the operator has stopped speaking, **When** the utterance ends, **Then** its
   final text is sent to the session exactly as a typed message would be, and is marked
   in the chat as spoken.
3. **Given** the session is writing its reply, **When** the first sentence is complete,
   **Then** that sentence is heard while later sentences are still being produced.
4. **Given** a reply contains code, a table, a path or a link, **When** it is spoken,
   **Then** that content is not read out, and it stays in the chat as text.
5. **Given** a spoken exchange has completed, **When** the operator looks at the chat,
   **Then** the time to first audio for that exchange is reported.
6. **Given** voice mode is on, **When** the operator turns it off, leaves the chat or
   closes the page, **Then** listening and playback stop and nothing more is captured.

---

### User Story 2 - Interrupt the assistant by talking over it (Priority: P1)

While the assistant is speaking, the operator starts talking. The speech stops at once.
What the operator says is handled as their next message, the same as sending a new
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

1. **Given** the assistant is speaking, **When** the operator starts talking, **Then**
   playback stops within the time in SC-003.
2. **Given** playback stopped because the operator talked, **When** their utterance ends
   with words in it, **Then** it is sent as their next message and the session answers
   it, and the session is told that it was interrupted and how far the user had heard.
3. **Given** playback stopped because the operator talked, **When** the utterance ends
   with no words in it, **Then** nothing is sent and speech resumes from the first
   sentence that had not been heard.
4. **Given** a reply was interrupted, **When** the operator reads the chat, **Then** the
   part that was not heard is visibly set apart from the part that was.
5. **Given** the assistant's own voice is coming out of the device's speaker, **When**
   nobody is talking, **Then** the assistant does not interrupt itself.

---

### User Story 3 - Keep talking while long work runs (Priority: P2)

The session starts a command that takes minutes, such as a full test run. The operator
asks something else in the meantime. The long command does not stop and does not hold up
the conversation: it moves to the background, the session answers the new question, and
when the command finishes its result is brought back into the conversation and spoken.

**Why this priority**: it is what makes voice usable for development work, where long
commands are routine. It depends on Stories 1 and 2.

**Independent Test**: in voice mode, ask the session to run a command that takes well
over the threshold, speak a different question while it runs, and confirm that the
question is answered while the command keeps running, and that the command's result is
later spoken without the operator asking again.

**Acceptance Scenarios**:

1. **Given** the session is running a command that has gone past the threshold, **When**
   the operator speaks, **Then** the command keeps running, the session is told it was
   moved to the background, and the new utterance is answered without waiting for it.
2. **Given** a backgrounded command finishes, **When** voice mode is still on, **Then**
   the session takes up the result and its reply about it is spoken.
3. **Given** the session is running a command younger than the threshold, **When** the
   operator speaks, **Then** the command is given until the threshold to finish on its
   own before anything is moved.
4. **Given** the session's engine cannot move work to the background, **When** the
   operator speaks during long work, **Then** the long work is never stopped; the
   operator hears a short spoken note that their message will be handled when the work
   is done, and it is.
5. **Given** a command was moved to the background, **When** the operator looks at the
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
2. **Given** voice is enabled with no provider named, **When** the operator uses voice
   mode, **Then** the built-in default runs and costs nothing.
3. **Given** a provider that needs a key, **When** the key is configured, **Then** it is
   given by reference to the gateway's environment, never written into the file in the
   clear by the feature, and never sent to the browser in any form.
4. **Given** an invalid `voice` section, **When** the gateway loads it, **Then** it says
   which setting is wrong and why, and voice stays off.
5. **Given** a configured provider is unavailable (not installed, wrong address, missing
   key), **When** the operator opens a chat, **Then** the voice control says voice is
   unavailable and why, and the chat otherwise works normally.
6. **Given** the voice prompt is replaced in the configuration, **When** the session
   answers a spoken message, **Then** it follows the replacement prompt.

---

### User Story 5 - Use voice mode on a phone (Priority: P3)

The operator opens a chat in a mobile browser, turns voice mode on with a tap, and holds
the same spoken conversation as on a desktop, including talking over the assistant. When
the phone locks or the browser goes to the background, listening stops.

**Why this priority**: the request names mobile browsers, but the desktop experience
proves the feature first and most of the phone story follows from it.

**Independent Test**: on a phone-sized browser with a microphone, turn voice mode on,
complete one spoken exchange including one interruption, then send the browser to the
background and confirm that capture stops.

**Acceptance Scenarios**:

1. **Given** a mobile browser, **When** the operator taps the voice control, **Then**
   audio capture and playback both start from that single tap.
2. **Given** voice mode is on in a mobile browser, **When** the page is hidden, **Then**
   capture and playback stop, and turning voice back on needs a new tap.

### Edge Cases

- The operator speaks while no reply is running: the utterance is a new message.
- The operator opens the same chat in a second tab and turns voice on there: the second
  tab takes over, and the first tab is told voice moved and stops listening.
- An utterance goes on past the configured maximum length: it is cut at the limit, what
  was captured is used, and the operator is told it was cut.
- The speech provider fails in the middle of an utterance or a reply: the operator is told
  that recognition or speech failed for that exchange; the session, the chat and voice
  mode carry on, and the reply is still shown as text.
- The network connection drops: voice mode shows it has stopped, and turning it back on
  starts cleanly. Nothing already sent is sent twice.
- A reply is started by the session itself while voice mode is on (a backgrounded command
  finished, a delegated task reported back): it is spoken too.
- The session is busy with work the operator did not start by voice: the same barge-in
  and long-work rules apply.
- The gateway restarts during voice mode: voice mode stops with a visible message, and
  can be turned on again.
- The session is deleted or stopped while voice mode is on: voice mode ends with a
  visible message.
- The operator's message starts with `/` (a command): it is sent unchanged, without voice
  instructions attached.
- Voice is turned off in the configuration while a chat is in voice mode: voice mode ends
  with a visible message.
- The operator has no microphone, or refuses microphone permission: the voice control
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
  the user leaves the chat, or the page is hidden or closed.

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
  widely used OpenAI-compatible audio interface.
- **FR-024**: Provider keys MUST be given by reference to the gateway's environment, in
  the same way the gateway's other provider keys are, and MUST NEVER be sent to the
  browser in any response, message or error.
- **FR-025**: The system MUST validate the `voice` section when it loads, MUST name each
  wrong setting and the reason, and MUST keep voice off while the section is invalid.
- **FR-026**: The system MUST tell the browser whether voice is available and, if not,
  why, without revealing any secret.
- **FR-027**: The system MUST only let a user use voice mode on a session they are
  allowed to send messages to, and MUST bound utterance length, the size of what the
  browser sends, and the number of chats in voice mode at once.
- **FR-028**: Only one browser tab at a time MUST be in voice mode on a given session; a
  newer one takes over and the older one is told.

**Web**

- **FR-029**: The voice control MUST be in the chat composer on desktop and mobile
  layouts, and MUST show the current state: listening, hearing, thinking, working (with
  what it is running), speaking, or unavailable (with why).
- **FR-030**: On mobile browsers, one tap on the voice control MUST be enough to start
  both capture and playback.

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

## Assumptions

- **Who**: voice mode is for the gateway's operator in the first release. Board members
  (accounts other than the operator) do not get it yet; their connection to the gateway
  already refuses anything but its main event stream, so they are excluded by default.
- **Default provider**: the built-in local providers (the Whisper binary dictation
  already uses, and the Kokoro voice read-aloud already uses) are the default. Turning
  voice on costs nothing and needs no key, so choosing a paid default needs no operator
  decision. A hosted provider is opt-in by naming it.
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
- **Connectors**: chat connectors other than the web UI are out of scope.
- **Cost**: hosted speech providers are billed by their vendors. The feature does not
  meter or cap that spend beyond the bounds in FR-027. Voice mode is off by default and
  the default providers are free.
